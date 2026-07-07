# Multi-Agent Assistant

A general-purpose AI assistant built on [Mastra](https://mastra.ai) that can research topics from the web, analyze uploaded documents (PDF, Word, Excel, PowerPoint, CSV) using Retrieval-Augmented Generation, and generate written content — all through a single chat interface, coordinated by a supervisor agent that routes each request to the right specialist.

- **Setup instructions:** [SETUP.md](./SETUP.md)
- **Design decisions, assumptions & trade-offs (incl. the RAG approaches evaluated):** [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md)

## What it does

| Capability | Description |
|---|---|
| **Research** | Answers questions using live web search (DuckDuckGo, Wikipedia, NewsAPI), with citations and source freshness notes. |
| **Document analysis (RAG)** | Upload one or more PDF, DOCX, XLSX, PPTX, or CSV files and ask questions, request summaries, extract key facts, or compare documents — grounded in the actual file content. |
| **Content writing** | Generates blog posts, emails, newsletters, LinkedIn/Twitter/Instagram posts, marketing copy, press releases, technical docs, reports, and how-to guides, each with a dedicated writing skill controlling tone and structure. |
| **Conversational memory** | Retains message history, a working-memory user profile, and semantic recall across turns, scoped per conversation. |

## Architecture

A single Express API endpoint (`POST /api/chat`) fronts a **Supervisor Agent** that delegates to three specialist agents. The supervisor never writes content or answers document questions itself — it routes and synthesizes.

```
                        ┌──────────────────────┐
   Streamlit UI  ─────► │   POST /api/chat     │
  (or any client)       └──────────┬───────────┘
                                    │
                     ┌─────────────────────────────────┐
                     │ Plain code, no LLM involved:    │
                     │ 1. File attached?               │
                     │    → parse → chunk → embed →    │
                     │      store, unconditionally     │
                     │      (Document Ingestion        │
                     │      Workflow)                  │
                     │ 2. Message present?             │
                     │    → hybrid search (vector +    │
                     │      keyword) against this      │
                     │      conversation's documents,  │
                     │      tell the supervisor what   │
                     │      it found                   │
                     └───┬───────────────────────────┬─┘
                         │ writes                    │ reads
                         ▼                           ▼
                    ┌─────────────────────────────────────────┐
                    │           PostgreSQL + pgvector         │
                    │  · conversation/message history         │
                    │  · working memory / observations        │
                    │  · vector + full-text chunk index       │
                    └─────────────────────────────────────────┘
                         ▲
                         │ verdict injected as [System: ...] note
                         │
                     ┌───┴──────────────────────────┐
                     │      Supervisor Agent        │
                     │  (routes on intent + the     │
                     │   retrieval-gate verdict)    │
                     └───┬───────────┬───────────┬──┘
                         │           │           │
              ┌──────────▼───┐ ┌─────▼───────┐ ┌─▼─────────────┐
              │  Research    │ │  Document   │ │   Writer      │
              │  Agent       │ │  Agent      │ │   Agent       │
              │ (web search) │ │ (answers    │ │ (skills)      │
              │              │ │ from chunks │ │               │
              │              │ │ it's given) │ │               │
              └──────────────┘ └─────────────┘ └───────────────┘
```

Ingestion and retrieval both write to / read from Postgres directly in the API layer — the Document Agent doesn't perform either in this flow. It's delegated to only to *generate the cited answer* from chunks the gate already found (see [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) for where the Document Agent's own `search-document`/`ingest-document` tools are still used independently, outside this path).

### Why a retrieval-gate instead of letting the supervisor guess

Before the supervisor ever sees the user's message, `POST /api/chat` runs a real hybrid search (vector + keyword) against that conversation's uploaded documents and appends a system note telling the supervisor exactly what it found — "N relevant chunks, use the Document Agent" or "nothing relevant, use the Research Agent." Routing is decided by an actual retrieval result, not the model's guess about whether a document probably contains the answer. See [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) for why this was worth the extra request.

## Multi-agent design

| Agent | Responsibility | Tools |
|---|---|---|
| **Supervisor** | Understands intent, delegates to the right specialist(s), synthesizes and cites the final answer. Holds conversation memory. | Sub-agents only (`researchAgent`, `documentAgent`, `writerAgent`) — no direct tools |
| **Research** | Answers questions from live web sources with citations. | `web-search` (DuckDuckGo + Wikipedia + NewsAPI, merged and formatted for the LLM) |
| **Document** | Ingests documents through the RAG pipeline and answers questions grounded in retrieved chunks, with document/page citations. | `ingest-document`, `search-document` |
| **Writer** | Generates polished content for a specific format (blog, email, social post, press release, etc.). | `generate-content` (activates one of 12 writing skills, each shaping tone/structure/length for its content type) |

Agents are composed via Mastra's native agent-delegation (`agents: {...}` on the supervisor) rather than a custom router — the supervisor calls sub-agents the same way it would call a tool, and can chain multiple in one turn (e.g. research a topic, then ask the Writer Agent to turn the findings into a LinkedIn post).

## Document analysis / RAG pipeline

Uploading a file always triggers the same 5-step ingestion workflow (`documentIngestionWorkflow`), regardless of what the accompanying message says:

1. **Parse** — format-specific text extraction (`pdf-parse`, `mammoth` for DOCX, `xlsx` for Excel/CSV, a zip/XML walk for PPTX slides).
2. **Extract metadata** — title, author, word count, page/slide boundaries, section hierarchy.
3. **Chunk** — format-aware chunking (e.g. slide-based for PPTX, table-aware for XLSX) rather than one fixed-size splitter for every format.
4. **Embed** — OpenAI `text-embedding-3-small`, batched with bounded concurrency and retry-on-429/5xx.
5. **Store** — upserted into Postgres/pgvector, with a generated `tsvector` column indexed for keyword search alongside the vector index.

At query time, retrieval is **hybrid**: vector similarity and Postgres full-text (BM25-style `ts_rank_cd`) search run in parallel and are fused by Reciprocal Rank Fusion. Queries that score in an ambiguous middle band get rewritten into alternate phrasings and re-searched before being discarded as "no match." Full rationale, alternatives considered, and benchmarking notes are in [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md).

## Memory

Built on Mastra's `Memory`, backed by Postgres, with four layers active per conversation (scoped by `resource` = userId, `thread` = conversationId):

1. **Message history** — last 10 messages, verbatim.
2. **Observational memory** — a background model extracts durable facts from the conversation as it goes.
3. **Working memory** — a structured, continuously-updated user profile (name, preferences, current task, domain knowledge).
4. **Semantic recall** — embeds and retrieves relevant older messages beyond the recent window.

## Content writing

The Writer Agent doesn't free-write — it activates one of 12 skills (`blog-post`, `listicle`, `professional-email`, `newsletter`, `linkedin-post`, `twitter-post`, `instagram-post`, `marketing-copy`, `press-release`, `technical-documentation`, `report`, `how-to-guide`), each of which fixes the tone, structure, and format conventions for that content type. The supervisor always delegates writing requests to this agent, even for a one-line request like "write a tweet about X," so format stays consistent regardless of how the request is phrased.

## Tech stack

- **Framework:** [Mastra](https://mastra.ai) (agents, workflows, memory, observability)
- **Runtime:** Node.js 22+, TypeScript, Express
- **LLMs:** OpenAI (primary), with optional Anthropic cross-provider fallback when a key is configured
- **Database:** PostgreSQL with `pgvector` (conversation storage, working/semantic memory, vector + full-text chunk index)
- **Document parsing:** `pdf-parse`, `mammoth`, `xlsx`, `jszip` (PPTX)
- **Frontend:** Streamlit chat UI (thin client over `POST /api/chat`)
- **Deployment:** Docker Compose (Postgres + backend + frontend)

## Project structure

```
src/
├── app.ts                       # Express entrypoint
├── api/                         # HTTP layer
│   ├── chat.ts                  # POST /api/chat — ingestion + retrieval-gate + supervisor call
│   ├── documents.ts             # Document upload/query/status endpoints
│   └── index.ts                 # Route registration, Swagger UI
├── config/                      # Env, DB pool, model fallback helper, Swagger spec
├── mastra/
│   ├── agents/                  # supervisor, research, document, writer
│   ├── workflows/               # document-ingestion (parse → metadata → chunk → embed → store)
│   ├── tools/                   # document-parser, chunking, embeddings (+ hybrid search), web-search, metadata-extractor
│   ├── skills/                  # writing-skills (12 content-type skills)
│   ├── storage/                 # Postgres store, vector store wiring
│   ├── memory.ts                # 4-layer Memory configuration
│   └── index.ts                 # Mastra instance — agents/workflows registered here
├── types/                       # Shared types, error classes
└── utils/                       # logger, retry helper
streamlit-frontend/              # Chat UI
scripts/init.sql                 # Postgres schema (documents table, pgvector extension, indexes)
```

## Getting started

See [SETUP.md](./SETUP.md) for prerequisites, environment variables, local and Docker setup, and how to verify the running system.
