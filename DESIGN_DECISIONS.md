# Design Decisions, Assumptions & Trade-offs

This document covers the architectural decisions behind the system, the alternatives that were considered and rejected, and the assumptions baked into the current implementation. The guiding principle throughout: **wherever a decision can be made deterministically in code, don't hand it to an LLM to guess.** Ingestion, routing, and relevance are all treated as things that should be *decided by evidence* (parsing succeeded, retrieval found a match, a score crossed a threshold), not by a model's intuition about what's probably true.

---

## 1. Multi-agent orchestration

### 1.1 Document ingestion is deterministic, never an agent's decision

**Problem:** the Document Agent has an `ingest-document` tool, but a tool only runs if the model decides to call it. Testing (via Mastra Studio's own file-attach chat) confirmed this failure mode directly: attaching a file to a chat message produced *zero* pipeline logs, because the UI passed the file as inline multimodal content rather than as tool arguments — the model never had a reason to invoke the tool.

**Options considered:**
| Option | Description | Verdict |
|---|---|---|
| A | Base64-encode the file into the Supervisor's prompt, let it decide to call `ingest-document` | Rejected — same "model might not call the tool" failure mode, plus pushes large binary payloads through LLM context on every upload |
| B | Same as A, as the only upload path | Rejected, same reason |
| **C (chosen)** | `POST /api/chat` accepts an optional file. If present, ingestion (parse → chunk → embed → store) runs **unconditionally in plain code**, before the Supervisor is ever called. The Supervisor only reasons about *what to do* with an already-ingested document. | **Chosen** |

**Why C:** ingestion is a deterministic ETL job — there's no scenario where "the LLM decided not to process the file" is a good outcome. Keeping it outside the agent loop makes it reliable and removes an entire class of "why didn't it index my file" bugs.

### 1.2 Retrieval-first routing (the retrieval gate)

**Problem:** once a document exists in a conversation, how does the Supervisor decide whether a given question should go to the Document Agent or the Research Agent? Letting the model guess based on the question's wording is exactly the kind of judgment call that goes wrong silently — guess "research" when the document actually had the answer, or guess "document" for every question once *any* file has been uploaded, wasting a retrieval on unrelated questions.

**Decision:** `POST /api/chat` runs a real hybrid search against the conversation's uploaded documents *before* the Supervisor is invoked, and injects the verdict as a `[System: ...]` note in the prompt: either "retrieval found N relevant chunks — use the Document Agent, grounded in this content" or "nothing relevant — use the Research Agent." The Supervisor's instructions explicitly tell it to trust this note rather than second-guess it.

**Alternative rejected:** having the retrieval-gate branch bypass the Supervisor entirely (call Document Agent or Research Agent directly based on the score). Rejected in favor of always routing through the Supervisor, so there's one call path, conversation memory/thread continuity stays intact, and delegation tracing (`agentsInvolved`) remains meaningful — the Supervisor still visibly delegates, just on evidence instead of a guess.

**Scoping decision:** retrieval is scoped to `conversationId`, not globally across every document ever uploaded. This was confirmed as sufficient for a single-user system (see [Assumptions](#4-assumptions)) — without it, a document uploaded in one conversation would keep surfacing as "relevant" grounding in unrelated conversations indefinitely.

**When relevant chunks are found**, the actual chunk content is handed to the Supervisor/Document Agent directly in the system note, rather than telling the Document Agent to re-run its own (unscoped) `search-document` tool — this avoids a redundant second search and keeps the answer grounded in the same conversation-scoped results the gate already found.

**Cost accepted:** the Supervisor still spends one model call "deciding" something retrieval has already decided — mitigated by strong instruction wording, not eliminated. The gate's routing heuristic lives in `chat.ts`, not in agent instructions — changing it means a code change, not a prompt change (a deliberate trade of prompt-flexibility for reliability).

### 1.3 Parallel multi-document upload, not sequential-by-construction

**Decision:** `POST /api/chat` accepts up to 5 files (`upload.array("files", 5)`), ingested concurrently via `Promise.allSettled`, each wrapped in its own outer exponential backoff (`withRetry`, 2 retries, 1s→8s) layered on top of the embedding pipeline's existing per-batch retry.

**Why `allSettled`, not `all`:** `Promise.all` rejects on the first failure but doesn't stop the other in-flight promises — they just become unobserved, abandoning work already paid for. `allSettled` waits for every file's pipeline to finish, successfully or not, before the handler decides what to do, preserving the old all-or-nothing HTTP contract without cutting off documents that were already succeeding concurrently. Verified live: uploading a valid CSV alongside an invalid-format file still returned `400` for the batch, but the valid file had already completed and was persisted as `status: "completed"` before the error was thrown.

**Why retry the whole document, not individual pipeline steps:** the embedding step already retries per-batch internally (`maxRetries: 4`), absorbing most transient embedding-API failures on its own. The outer per-document retry is a coarser safety net for failures outside the embedding batches — a DB blip during `saveDocument`/upsert, a flaky parser dependency — kept to 2 retries (not 4) since a full outer retry re-does parsing and chunking too, not just the failed step.

**Cost accepted:** capping concurrency at 5 files means a full batch can burst up to ~25 concurrent embedding requests to OpenAI (5 files × the embedding pipeline's own `batchConcurrency: 5`), relying on per-batch/per-document backoff to absorb any resulting 429s rather than adding a cross-file concurrency limiter (e.g. `p-limit`) speculatively — flagged as the next lever to pull if rate-limit thrashing shows up under real multi-file load.

**Verified:** two files uploaded together completed in 9.9s total — not ~2x the 21.5s single-file baseline — with server logs showing the two ingestion pipelines interleaved rather than sequential, and follow-up questions in the same conversation correctly resolved against the right document.

---

## 2. Document analysis / RAG — approaches explored

This is the area with the most iteration. Three sub-problems were each worked through by trying more than one approach: **chunking strategy**, **retrieval quality (threshold brittleness)**, and **vector index type**.

### 2.1 Chunking: format-aware, not one-size-fits-all

**Approaches evaluated:**

| Strategy | Used for | Why |
|---|---|---|
| Recursive character/token splitting (paragraph → line → word, via `@mastra/rag`) | PDF, DOCX | General prose has no fixed internal structure worth preserving beyond paragraphs |
| Table-aware row-grouping (custom) | XLSX, CSV | A fixed-size text splitter would cut across row boundaries and header context; instead rows are grouped up to ~50 rows or an 800–1200 char window, with the sheet header repeated in every chunk so each chunk is independently interpretable |
| Slide-based chunking (custom) | PPTX | Each slide is a natural semantic unit; keep it as one chunk when it fits, split only when a single slide's content overflows the window, and never spread one slide's content across chunks in a way that fragments it |

**Why not a single fixed-size splitter for everything:** early testing surfaced two format-specific bugs this would have caused — a slide fan-out bug (one slide splitting into many disconnected fragments) and a table orphan/overshoot bug (a trailing row-group ending up too small or exceeding the window). Both were fixed by making the chunker aware of the document's actual structure rather than treating all formats as flat text.

**A real bug this exposed:** `maxSize`/`overlap` were documented as *token* counts but silently enforced as *character* counts (`@mastra/rag`'s chunker defaults to `text.length` unless given an explicit `lengthFunction`). This made chunks ~4x smaller than intended — 512 "tokens" was actually ~128 tokens — which cascaded into 4x the embedding calls, 4x the database rows, and a bloated candidate pool at query time. Fixed by wiring in a real `cl100k_base` tokenizer (`js-tiktoken`) as the length function. This only affected the recursive strategy (PDF/DOCX); the table/slide strategies use their own character-based windows by design and were unaffected.

**Known unresolved finding:** identical source content produces ~2.3x more chunks as PDF than as DOCX (16 vs. 7 chunks for the same 45-section document), because `pdf-parse` emits a newline after every wrapped visual line while `mammoth` emits clean paragraph breaks, and the recursive splitter's separator hierarchy reacts differently to each. Retrieval correctness wasn't affected (the right chunk was still found in both cases), but chunk granularity is currently inconsistent across parsers — worth revisiting if retrieval precision or embedding cost ever becomes a tuning concern.

### 2.2 Retrieval quality: the threshold-brittleness problem

**Problem, reproduced with real data:** asking "how long is atal tunnel" against a document that plainly contains the answer scored the correct chunk at **0.4958** against a **0.5** similarity cutoff — a 0.0042 miss that sent the question to the Research Agent instead. A more verbosely-phrased version of the same question scored comfortably above threshold. Same fact, same document, different score, purely from wording.

Three approaches were evaluated for this:

**A — Lower the global similarity threshold.** Rejected as the primary fix: evidence from one document showed a ~0.30 gap between the relevant chunk and every irrelevant one, so a lower threshold wouldn't have hurt there — but that's one document, one query. A global threshold change applies to every document/query pair, including ones where "topically adjacent" and "actually relevant" sit much closer together. No evidence existed either way for that broader case, so a systemic change felt too blunt for a problem specific to certain phrasings.

**B — LLM query expansion (implemented).** When a query's top score lands in an ambiguous band (0.35–0.5), a small utility agent (`gpt-4o-mini`) rewrites it into two alternate phrasings — a natural rephrasing, and a declarative "hypothetical answer sentence" written the way the fact might appear in source text — and re-searches with all three. The best-scoring chunk across all variants is kept. This lives in the deterministic retrieval-gate itself, not as a tool the Document Agent can choose to use — the same "the model might not call it" failure mode from §1.1 applies here too, since the score-based rejection happens in code *before* the Supervisor (and therefore the Document Agent) is ever invoked. Verified end-to-end: the failing query above resolved correctly after expansion (0.4958 → 0.6399 on the rewritten phrasing), while a genuinely unrelated question ("what is the capital of France") still correctly returned no match — expansion doesn't over-trigger outside its band.

**C — Hybrid search: vector + keyword (BM25-style), fused by Reciprocal Rank Fusion (chosen for this implementation).** A parallel Postgres full-text search (`tsvector` + GIN index + `ts_rank_cd`) runs alongside the vector search on the same table, and the two rankings are fused by rank position (RRF), not raw score blending — cosine similarity and `ts_rank_cd` live on incompatible scales, so averaging them directly would be arbitrary. This catches the exact case that pure semantic search can miss: a rare term or exact phrase (a product code, a specific name) that a paraphrase-based embedding model might not weight highly, but that a literal keyword match finds immediately, with no extra LLM call.

**Why C was chosen over B for this implementation:** hybrid search reduced the retrieval failures observed during testing for the same class of "correct answer, low vector score" problem as query expansion, while avoiding an additional LLM call in the common case — one extra parallel SQL query instead of one extra LLM round-trip per ambiguous query, for what's usually just "the exact term is in there somewhere." Query expansion (B) is retained in the codebase as a separate function and remains a reasonable complement for the cases hybrid search doesn't help — a *conceptually*-related but non-keyword-overlapping paraphrase — but it isn't currently wired into the production retrieval-gate.

**Design details worth noting:**
- Full-text ranking uses a strict AND query (`websearch_to_tsquery`) first, falling back to an OR-joined reconstruction only if AND finds nothing — this keeps normal multi-term queries precise while still rescuing single-term stemming mismatches (e.g. "long" vs. "longest").
- A keyword match is trusted outright if it's a **strict** match (every query term present); a **loose** (OR-fallback) match additionally needs a modest vector score as corroboration, so a single generic shared word can't falsely qualify a chunk.
- Candidate pools are widened to `topK * 4` per branch before fusion, so a chunk ranked outside the vector search's raw top-K but strong on keyword match still gets a chance to surface.

**Trade-off accepted:** RRF fuses by rank position, not magnitude — a landslide win and a narrow win at the same rank look identical to the fusion step. `RRF_K = 60` and the `topK * 4` pool size are both standard/reasonable defaults, not tuned against this project's actual query distribution.

### 2.3 Vector index: IVFFlat, not HNSW

**Decision:** the pgvector index backing `document_embeddings` is IVFFlat (the library default for dense vector columns), not HNSW.

**Why:** the deciding factor is insert cost, not query-time recall. Embeddings are generated and upserted **inline, synchronously, on every document upload** — there's no offline/batch re-indexing step. IVFFlat's insert is a cheap nearest-centroid assignment; HNSW's insert requires searching and rewiring a multi-layer graph, and gets *more* expensive as the graph grows. Since upload latency was already the reported problem (see chunking/embedding latency work below), IVFFlat keeps the write path cheap; the read-side recall/speed ceiling being somewhat lower than HNSW's is a cost paid on the query side, which hasn't been the bottleneck.

**Cost accepted:** IVFFlat's list count is computed from the row count *at first index creation* and isn't recalculated as the table grows, so recall can degrade as the corpus scales past that initial size until a manual reindex. Switching to HNSW later is a config change, not a schema rewrite, if query recall ever does become the bottleneck.

### 2.4 Ingestion latency: two real bugs, not the chunking algorithm

A user-reported "chunking is slow" complaint was traced to two root causes, neither of which was the chunking algorithm itself (confirmed to be linear, not quadratic, for this codebase's separator configuration):

1. **The token-counting bug in §2.1** — a document that should have produced ~75 chunks / 3 embedding batches was instead producing ~300 chunks / 12 batches.
2. **Serial embedding batches with a flat 500ms sleep between every one**, regardless of whether the API was anywhere near a rate limit. Fixed with a bounded worker pool (5 batches in flight concurrently) and exponential backoff that only fires on an actual 429/5xx, not unconditionally. Ordering is preserved across concurrent batches via a pre-sized results array indexed by batch position — important because embeddings are zipped back to chunks by position, and silently reordering them would corrupt every citation downstream.

Per-stage timing (`parseMs`, `chunkMs`, `embedMs`, `indexEnsureMs`, `upsertMs`) is now logged at the end of every ingestion, specifically so a future latency complaint doesn't require re-deriving this same investigation from scratch.

### 2.5 Ingestion latency, round two: tracing overhead and workflow-snapshot bloat

**Problem:** a 7-page PDF still took over 2 minutes to ingest even after the §2.4 fixes had landed. Per-stage timing showed the pipeline itself was fast — the gap was between the pipeline's own step timers and the wall-clock time the framework reported around them, pointing at two bottlenecks in framework configuration, not pipeline logic.

**Root cause #1 — unconditional console tracing of full span payloads.** `ConsoleExporter` was configured alongside `MastraStorageExporter` for observability. Its implementation logs every span's full `input`/`output` via `JSON.stringify(..., null, 2)` on every `SPAN_STARTED`/`SPAN_ENDED`/`SPAN_UPDATED` event, uncontrolled by `logLevel` — and workflow steps pass the entire chunk array and parsed document text between them, so the same 30-50KB blob got pretty-printed and logged multiple times per step. Measured: a step whose own timer said 3262ms of real work was wrapped in a span reporting 17224ms.

**Fix:** dropped `ConsoleExporter` entirely, keeping `MastraStorageExporter` (batched, not synchronous stdout) for persisted, queryable traces.

**Root cause #2 — the raw file `Buffer` was being persisted into the workflow snapshot on every step transition.** The workflow's input schema typed the file as `z.instanceof(Buffer)`; because the workflow engine snapshots the full accumulated step context to Postgres after every transition (for resumability), `JSON.stringify` boxed the buffer as one array element per byte — for a PDF with embedded figures, this produced a 9.2MB / 20M-character snapshot row for a document whose extracted text was only ~26KB.

**Fix:** the file now crosses into workflow-managed state as a base64 **string**, decoded back to a `Buffer` only inside the step that needs bytes. `executeDocumentIngestion`'s external signature is unchanged — the base64 conversion happens at the one seam where raw bytes enter Mastra-managed, snapshotted state.

**Cost accepted:** base64 is still ~1.33x the raw file size, and it's persisted once per step transition (5x) — no longer catastrophic, but not free. Disabling workflow-snapshot persistence entirely was rejected, to preserve whatever resumability the team gets from Mastra persisting workflow runs; a tighter fix (keep the buffer out of any Zod-typed step schema, parsing the file before entering the workflow) wasn't pursued, to keep the change minimal and the existing 5-step shape intact.

**Verified:** same document, before/after — snapshot row 9.2MB → 153KB (~60x smaller); the gap between the step-timer sum and total `executionTimeMs` went from 174.6s to ~600ms; the user's real 13-page PDF dropped from 203s to 15s cold.

### 2.6 What live testing actually validated

All five formats (PDF, DOCX, XLSX, PPTX, CSV) were tested end-to-end against the real API with documents large enough to require multiple chunks, each with one fabricated "needle" fact planted mid-document. Every format correctly isolated the needle to a single chunk and retrieved it via the retrieval-gate, with correct routing (`document-agent`) and correct citation in every case except one:

- **The Document Agent will refuse to quote content it perceives as sensitive**, if the source document's own text frames it that way (e.g. a passphrase adjacent to "must never be shared over unencrypted channels"). Retrieval was still correct — it cited the right section — it just declined to relay the value. Worth being aware of if real uploaded documents contain similar "don't share this" language aimed at a human reader; this is a generation-time behavior, not a retrieval failure.

---

## 3. Memory system

Four layers are active per conversation, all backed by Postgres/pgvector, scoped by `resource` (userId) and `thread` (conversationId):

| Layer | Purpose | Verified behavior |
|---|---|---|
| Message history (`lastMessages: 10`) | Verbatim recent turns | Confirmed persisted and ordered correctly past 40+ messages in a thread |
| Working memory | A structured, continuously-updated user profile (name, preferences, current task, domain knowledge) | The template is a *starting scaffold, not a strict schema* — the model freely adds new sections (e.g. an unprompted "Personal Details" section) when a fact doesn't fit the four given fields |
| Semantic recall | Embeds and retrieves relevant older messages once they've scrolled out of the raw message-history window | Confirmed via direct vector-table queries that a fact mentioned, then pushed out of the window by filler turns, was both embedded and correctly surfaced later |
| Observational memory | A background model extracts durable facts/current-task state as the conversation progresses | Required a real fix — see below |



**Trade-off/limitation:** semantic recall and working memory turned out hard to isolate from each other in testing, since working memory is aggressive enough to capture nearly anything mentioned in conversation. Both layers passed independently, but a "correct recall" in this system is often reinforced by more than one layer rather than attributable to exactly one — acceptable for the actual goal (coherent, context-aware answers) but worth knowing if you need to reason about *which* layer answered a given question.

**Document↔turn association is a structured fact, not incidental text.** Before this fix, a document↔turn association was only recoverable through memory if the exact tagged turn happened to be the one semantic recall's vector match selected — the `documentId` existed only as literal text inside a past message. Turns that trigger a retrieval-gate hit are now also tagged with a `metadata: { documentIds, documentRefs }` sidecar on the message row (via `MastraMessageContentV2`'s `metadata` field; `@mastra/pg` persists and rehydrates it losslessly), making the association a durable, directly queryable fact independent of whether that turn is ever chosen as a semantic match.

**Cost accepted:** the metadata deliberately excludes chunk content (already addressable via `documentId` + `chunkIndex` in `document_embeddings` — duplicating full chunk text into every tagged message would bloat `mastra_messages`) and `conversationId` (redundant with the thread key). Only the user turn is tagged, not the assistant's reply — deferred as a narrow-benefit follow-up, since the default `messageRange: { before: 1, after: 1 }` usually pulls in the neighboring turn anyway.

**Verified:** live against real Postgres — metadata correctly present on a retrieval-gate hit, correctly absent on a no-match turn, and confirmed intact after 11 filler messages pushed the tagged turn out of the `lastMessages: 10` window.

---

## 4. Assumptions

- **Single-user system, not multi-tenant.** Confirmed explicitly rather than assumed: retrieval and memory are scoped by `conversationId`/`userId` strings with no authentication or authorization boundary between them. Nothing currently prevents a client from reading another conversation's data if it knows (or guesses) the ID. Acceptable for the current scope; would need a real auth layer before this could be multi-user.
- **English-language documents.** Full-text/keyword search is hardcoded to Postgres's `'english'` text-search configuration. Non-English content won't error, but keyword ranking will silently under-perform.
- **Documents are append-only.** Re-ingesting a document overwrites chunks at matching indices but doesn't delete now-orphaned trailing chunks from a previous, longer version of the same document — acceptable since the pipeline doesn't currently support in-place document replacement.
- **Retrieval thresholds are reasonable starting points, not tuned constants.** The `0.5` similarity threshold, `0.35` expansion-band floor, `RRF_K = 60`, and `topK * 4` candidate pool size all came from either existing codebase convention or the standard literature default — none have been validated against a broad corpus of this project's real documents and query phrasings.
