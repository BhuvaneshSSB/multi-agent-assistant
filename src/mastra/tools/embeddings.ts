import { PgVector } from "@mastra/pg";
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { config } from "../../config/env";
import { getDatabase } from "../../config/database";
import { withRetry } from "../../utils/retry";
import { openAiModelWithFallback } from "../../config/models";
import { Chunk } from "./chunking";

// ============================================================================
// EMBEDDING CONFIGURATION
// ============================================================================

export const EMBEDDING_CONFIG = {
  model: "openai/text-embedding-3-small",
  dimension: 1536, // text-embedding-3-small dimensions
  batchSize: 25, // OpenAI batch limit
  batchConcurrency: 5, // batches in flight at once
  maxRetries: 4, // retries for a single batch on 429/5xx before giving up
  indexName: "document_embeddings", // PgVector index name
};

// ============================================================================
// INITIALIZE EMBEDDING MODEL
// ============================================================================

const embedder = new ModelRouterEmbeddingModel({
  id: EMBEDDING_CONFIG.model as `${string}/${string}`,
  apiKey: config.mastra.openaiApiKey,
});

// ============================================================================
// INITIALIZE PGVECTOR STORE
// ============================================================================

const pgVector = new PgVector({
  id: "document-vector-store",
  connectionString: config.database.url,
});

// ============================================================================
// CREATE INDEX (Idempotent)
// ============================================================================

export async function ensureIndexCreated(): Promise<void> {
  try {
    logger.info("[Embedding] Ensuring index exists", {
      indexName: EMBEDDING_CONFIG.indexName,
      dimension: EMBEDDING_CONFIG.dimension,
    });

    // PgVector will create index if it doesn't exist
    // This is safe to call multiple times (idempotent)
    await pgVector.createIndex({
      indexName: EMBEDDING_CONFIG.indexName,
      dimension: EMBEDDING_CONFIG.dimension,
    });

    logger.info("[Embedding] Index ready", {
      indexName: EMBEDDING_CONFIG.indexName,
    });
  } catch (error) {
    // Index might already exist - this is fine
    if (error instanceof Error && error.message.includes("already exists")) {
      logger.info("[Embedding] Index already exists (expected)");
      return;
    }
    logger.error("[Embedding] Error ensuring index", { error });
    throw error;
  }
}

// ============================================================================
// CREATE FULL-TEXT INDEX (Idempotent) — powers keyword/BM25-style search
// ============================================================================
//
// `document_embeddings` is a plain Postgres table (id, vector_id, embedding,
// metadata JSONB) created by PgVector.createIndex(). We piggyback a generated
// tsvector column + GIN index on top of it so keyword search can run as a
// normal SQL query against the same table/rows the vector index uses —
// no separate store to keep in sync.

async function ensureFullTextIndexCreated(): Promise<void> {
  try {
    const db = getDatabase();
    const table = `"${EMBEDDING_CONFIG.indexName}"`;

    await db.query(`
      ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS content_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('english', metadata->>'chunkContent')) STORED;
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS "${EMBEDDING_CONFIG.indexName}_tsv_idx"
      ON ${table} USING GIN (content_tsv);
    `);

    logger.info("[Embedding] Full-text index ready", {
      indexName: EMBEDDING_CONFIG.indexName,
    });
  } catch (error) {
    logger.error("[Embedding] Error ensuring full-text index", { error });
    throw error;
  }
}

// ============================================================================
// GENERATE EMBEDDINGS (BATCH PROCESSING)
// ============================================================================

// Only retry batches that failed for a transient reason (rate limit or server
// error) — anything else (bad input, auth failure) will just fail again.
function isRetryableEmbeddingError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const err = error as { statusCode?: number; isRetryable?: boolean };
    if (typeof err.isRetryable === "boolean") return err.isRetryable;
    if (typeof err.statusCode === "number") {
      return err.statusCode === 429 || err.statusCode >= 500;
    }
  }
  return false;
}

async function embedBatchWithRetry(
  batchTexts: string[],
  batchLabel: string,
  maxRetries: number
): Promise<number[][]> {
  try {
    return await withRetry(
      async () => (await embedder.doEmbed({ values: batchTexts })).embeddings,
      { maxRetries, isRetryable: isRetryableEmbeddingError, label: batchLabel }
    );
  } catch (error) {
    logger.error(`[Embedding] ${batchLabel} failed`, { error });
    throw error;
  }
}

export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  try {
    if (texts.length === 0) {
      logger.warn("[Embedding] No texts to embed");
      return [];
    }

    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_CONFIG.batchSize) {
      batches.push(texts.slice(i, i + EMBEDDING_CONFIG.batchSize));
    }

    logger.info("[Embedding] Generating embeddings", {
      textCount: texts.length,
      batchCount: batches.length,
      batchSize: EMBEDDING_CONFIG.batchSize,
      concurrency: EMBEDDING_CONFIG.batchConcurrency,
    });

    // Bounded worker pool: run up to `batchConcurrency` batches in parallel
    // instead of one at a time, and only pay a retry delay on batches that
    // actually hit a rate limit / server error (not a flat sleep every time).
    const results: number[][][] = new Array(batches.length);
    let nextBatchIndex = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const batchIndex = nextBatchIndex++;
        if (batchIndex >= batches.length) return;

        const batchLabel = `batch ${batchIndex + 1}/${batches.length}`;
        results[batchIndex] = await embedBatchWithRetry(
          batches[batchIndex],
          batchLabel,
          EMBEDDING_CONFIG.maxRetries
        );
        logger.info(`[Embedding] ${batchLabel} completed`, {
          embeddingsInBatch: results[batchIndex].length,
        });
      }
    }

    const workerCount = Math.min(EMBEDDING_CONFIG.batchConcurrency, batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const embeddings = results.flat();

    logger.info("[Embedding] All embeddings generated", {
      totalEmbeddings: embeddings.length,
      embeddingDimension: embeddings[0]?.length || 0,
    });

    return embeddings;
  } catch (error) {
    logger.error("[Embedding] Error generating embeddings", { error });
    throw error;
  }
}

// ============================================================================
// STORE EMBEDDINGS IN PGVECTOR
// ============================================================================

export interface EmbeddingMetadata {
  documentId: string;
  conversationId: string;
  chunkIndex: number;
  chunkContent: string;
  pageNumber?: number;
  pageRangeStart?: number;
  pageRangeEnd?: number;
  sectionTitle?: string;
  contentType?: string;
  hierarchy?: string[];
}

export interface StoreEmbeddingsTimings {
  indexEnsureMs: number;
  upsertMs: number;
}

export async function storeEmbeddings(
  embeddings: number[][],
  metadata: EmbeddingMetadata[]
): Promise<StoreEmbeddingsTimings> {
  try {
    if (embeddings.length === 0) {
      logger.warn("[Embedding] No embeddings to store");
      return { indexEnsureMs: 0, upsertMs: 0 };
    }

    if (embeddings.length !== metadata.length) {
      throw new Error(
        `Embedding count (${embeddings.length}) doesn't match metadata count (${metadata.length})`
      );
    }

    logger.info("[Embedding] Storing embeddings in PgVector", {
      indexName: EMBEDDING_CONFIG.indexName,
      embeddingCount: embeddings.length,
    });

    // Ensure both indexes exist before storing (vector for semantic search,
    // full-text for keyword/BM25-style search — see hybridSearchChunks below)
    const indexEnsureStart = Date.now();
    await ensureIndexCreated();
    await ensureFullTextIndexCreated();
    const indexEnsureMs = Date.now() - indexEnsureStart;

    // Prepare ids and metadata for upsert
    const ids = metadata.map(
      (m) => m.documentId + "-" + m.chunkIndex
    );
    const preparedMetadata = metadata.map((m) => ({
      documentId: m.documentId,
      conversationId: m.conversationId,
      chunkIndex: m.chunkIndex,
      chunkContent: m.chunkContent,
      pageNumber: m.pageNumber,
      pageRangeStart: m.pageRangeStart,
      pageRangeEnd: m.pageRangeEnd,
      sectionTitle: m.sectionTitle,
      contentType: m.contentType,
      hierarchy: m.hierarchy ? JSON.stringify(m.hierarchy) : null,
    }));

    // Upsert by id (documentId-chunkIndex), no deleteFilter: reprocessing a
    // document only overwrites chunks that still exist at the same index.
    // If a re-chunk produces fewer chunks than before, trailing indexes from
    // the previous run are orphaned rather than removed. Acceptable for now
    // since documents are append-only in this pipeline; revisit with a
    // `deleteFilter: { documentId }` if in-place re-chunking is added.
    const upsertStart = Date.now();
    await pgVector.upsert({
      indexName: EMBEDDING_CONFIG.indexName,
      vectors: embeddings,
      metadata: preparedMetadata,
      ids,
    });
    const upsertMs = Date.now() - upsertStart;

    logger.info("[Embedding] Embeddings stored successfully", {
      indexName: EMBEDDING_CONFIG.indexName,
      storedCount: embeddings.length,
      indexEnsureMs,
      upsertMs,
    });

    return { indexEnsureMs, upsertMs };
  } catch (error) {
    logger.error("[Embedding] Error storing embeddings", { error });
    throw error;
  }
}

// ============================================================================
// COMPLETE PIPELINE: EMBED + STORE
// ============================================================================

export interface EmbedAndStoreTimings {
  embedMs: number;
  indexEnsureMs: number;
  upsertMs: number;
}

export async function embedAndStoreChunks(
  chunks: Chunk[],
  documentId: string,
  conversationId: string
): Promise<EmbedAndStoreTimings> {
  try {
    logger.info("[Embedding] Starting embed and store pipeline", {
      documentId,
      chunkCount: chunks.length,
    });

    // Step 1: Extract texts from chunks
    const texts = chunks.map((chunk) => chunk.content);

    // Step 2: Generate embeddings
    const embedStart = Date.now();
    const embeddings = await generateEmbeddings(texts);
    const embedMs = Date.now() - embedStart;

    // Step 3: Prepare metadata
    const metadata: EmbeddingMetadata[] = chunks.map((chunk) => ({
      documentId,
      conversationId,
      chunkIndex: chunk.index,
      chunkContent: chunk.content,
      pageNumber: chunk.metadata.pageNumber,
      pageRangeStart: chunk.metadata.pageRangeStart,
      pageRangeEnd: chunk.metadata.pageRangeEnd,
      sectionTitle: chunk.metadata.sectionTitle,
      contentType: chunk.metadata.contentType ?? "text",
    }));

    // Step 4: Store embeddings with metadata
    const { indexEnsureMs, upsertMs } = await storeEmbeddings(embeddings, metadata);

    logger.info("[Embedding] Embed and store pipeline completed", {
      documentId,
      processedChunks: chunks.length,
      embedMs,
      indexEnsureMs,
      upsertMs,
    });

    return { embedMs, indexEnsureMs, upsertMs };
  } catch (error) {
    logger.error("[Embedding] Error in embed and store pipeline", { error });
    throw error;
  }
}

// ============================================================================
// SEARCH EMBEDDINGS (RETRIEVE SIMILAR CHUNKS)
// ============================================================================

export interface SearchResult {
  id: string;
  score: number;
  metadata: EmbeddingMetadata;
}

export async function searchSimilarChunks(
  query: string,
  topK: number = 5,
  similarityThreshold: number = 0.5,
  conversationId?: string,
  documentId?: string
): Promise<SearchResult[]> {
  try {
    logger.info("[Embedding] Searching similar chunks", {
      query: query.substring(0, 100),
      topK,
      threshold: similarityThreshold,
      conversationId,
      documentId,
    });

    // Step 1: Generate embedding for query
    const { embeddings: queryEmbeddings } = await withRetry(
      () => embedder.doEmbed({ values: [query] }),
      { maxRetries: 3, isRetryable: isRetryableEmbeddingError, label: "query embedding" }
    );
    const queryVector = queryEmbeddings[0];

    logger.info("[Embedding] Query embedding generated", {
      dimension: queryVector.length,
    });

    // Step 2: Search in PgVector, scoped to the conversation (and optionally
    // a single document within it, for per-document comparison retrieval) so
    // unrelated conversations'/documents' content never surfaces as an answer.
    const filter =
      conversationId || documentId
        ? { ...(conversationId ? { conversationId } : {}), ...(documentId ? { documentId } : {}) }
        : undefined;

    const results = await pgVector.query({
      indexName: EMBEDDING_CONFIG.indexName,
      queryVector,
      topK,
      minScore: similarityThreshold,
      filter,
    });

    logger.info("[Embedding] Search completed", {
      resultsFound: results.length,
      topK,
    });

    return results as SearchResult[];
  } catch (error) {
    logger.error("[Embedding] Error searching similar chunks", { error });
    throw error;
  }
}

// ============================================================================
// SEARCH WITH QUERY EXPANSION (RETRIEVAL-GATE ONLY)
// ============================================================================
//
// A short/loosely-phrased query can score just under the similarity
// threshold even when the answer is present (e.g. "how long is atal tunnel"
// scored 0.496 against a 0.5 cutoff, while the same fact phrased closer to
// the source text scored 0.60+). Rather than lowering the threshold globally
// (which would raise false-positive risk for every query), only queries that
// land in an ambiguous middle band get rewritten into alternate phrasings
// and re-searched. Clear hits and clear misses skip this entirely, so the
// common case pays no extra latency/cost.
//
// Scoped to the /api/chat retrieval-gate (see src/api/chat.ts) — the
// Document Agent's own unscoped `search-document` tool keeps using plain
// `searchSimilarChunks`, unchanged, per the existing design in
// docs/rag/12_observability-and-retrieval-first-routing.md §7.1.

const EXPANSION_BAND_FLOOR = 0.35; // below this, expansion is unlikely to help either — skip it

const queryExpansionAgent = new Agent({
  id: "query-expansion",
  name: "Query Expansion Agent",
  description:
    "Internal utility agent that rewrites a search query into alternate phrasings to improve semantic retrieval recall. Not part of the agent orchestration team — used only by the retrieval-gate.",
  ...openAiModelWithFallback("openai/gpt-4o-mini", "anthropic/claude-haiku-4-5-20251001"),
  instructions: `You rewrite a user's question into exactly 2 alternate search queries to improve semantic similarity search against source documents.
1. A natural rephrasing of the same question, using different words/structure.
2. A declarative statement written the way the answer might literally appear in the source text (a hypothetical answer sentence), not phrased as a question.
Keep both concise and specific to the original question's topic. Do not invent facts — phrase them as plausible statements, not asserted answers.`,
});

async function expandQuery(query: string): Promise<string[]> {
  const result = await queryExpansionAgent.generate(query, {
    structuredOutput: {
      schema: z.object({
        variants: z.array(z.string()).length(2),
      }),
    },
  });
  return result.object?.variants ?? [];
}

export async function searchSimilarChunksWithExpansion(
  query: string,
  topK: number = 5,
  similarityThreshold: number = 0.5,
  conversationId?: string
): Promise<SearchResult[]> {
  const initial = await searchSimilarChunks(query, topK, 0, conversationId);
  const topScore = initial[0]?.score ?? 0;

  if (topScore >= similarityThreshold) {
    return initial.filter((r) => r.score >= similarityThreshold);
  }
  if (topScore < EXPANSION_BAND_FLOOR) {
    return [];
  }

  logger.info("[Embedding] Score in expansion band, rewriting query", {
    query: query.substring(0, 100),
    topScore,
  });

  const variants = await expandQuery(query);
  const variantResults = await Promise.all(
    variants.map((v) => searchSimilarChunks(v, topK, 0, conversationId))
  );

  const bestById = new Map<string, SearchResult>();
  for (const r of [...initial, ...variantResults.flat()]) {
    const existing = bestById.get(r.id);
    if (!existing || r.score > existing.score) bestById.set(r.id, r);
  }

  return Array.from(bestById.values())
    .filter((r) => r.score >= similarityThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ============================================================================
// KEYWORD SEARCH (BM25-STYLE, VIA POSTGRES FULL-TEXT SEARCH)
// ============================================================================
//
// Runs entirely as SQL against the same `document_embeddings` table the
// vector search uses — no separate index to keep in sync. `ts_rank_cd`
// gives a BM25-like relevance score (term frequency + proximity, normalized
// by document length).
//
// `websearch_to_tsquery` parses the query the way a search engine would
// ("quoted phrase", -exclusion) but ANDs every term by default — a single
// non-matching term (e.g. a stemming mismatch like query "long" vs.
// document "longest", which the English dictionary does not fold together)
// zeroes out the whole match even when every other term hit strongly.
//
// So this runs AND first (precise: a chunk must contain every query term,
// same as before) and only falls back to an OR-joined reconstruction
// (built from plainto_tsquery's stemmed terms) when AND finds nothing.
// OR alone is too loose to use as the default — a generic shared word (e.g.
// "capital" in an unrelated query landing on an unrelated "state capital"
// sentence) would otherwise surface chunks with no real relevance to the
// query. Falling back only on a zero-result AND keeps normal queries
// precise while still rescuing genuine single-term recall failures.
// ts_rank_cd ranks chunks matching more terms (and matching them closer
// together) higher in both modes, so relevance ordering is preserved.
const AND_TSQUERY = `websearch_to_tsquery('english', $1)`;
const OR_TSQUERY = `to_tsquery('english', replace(plainto_tsquery('english', $1)::text, ' & ', ' | '))`;

async function runKeywordQuery(
  tsqueryExpr: string,
  query: string,
  topK: number,
  conversationId?: string,
  documentId?: string
): Promise<SearchResult[]> {
  const db = getDatabase();
  const table = `"${EMBEDDING_CONFIG.indexName}"`;
  const conditions = [`content_tsv @@ ${tsqueryExpr}`];
  const params: (string | number)[] = [query];

  if (conversationId) {
    conditions.push(`metadata->>'conversationId' = $${params.length + 1}`);
    params.push(conversationId);
  }

  if (documentId) {
    conditions.push(`metadata->>'documentId' = $${params.length + 1}`);
    params.push(documentId);
  }

  params.push(topK);

  const result = await db.query(
    `SELECT vector_id AS id, metadata,
            ts_rank_cd(content_tsv, ${tsqueryExpr}) AS score
     FROM ${table}
     WHERE ${conditions.join(" AND ")}
     ORDER BY score DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows.map((row) => ({
    id: row.id as string,
    score: Number(row.score),
    metadata: row.metadata as EmbeddingMetadata,
  }));
}

export interface KeywordSearchResult extends SearchResult {
  // "strict": every distinct query term was present (high-confidence match).
  // "loose": only reached via the OR fallback, i.e. the strict AND query
  // found nothing and this chunk matched on partial term overlap — a
  // weaker signal that a caller may want to corroborate before trusting.
  matchTier: "strict" | "loose";
}

export async function keywordSearchChunks(
  query: string,
  topK: number = 5,
  conversationId?: string,
  documentId?: string
): Promise<KeywordSearchResult[]> {
  try {
    logger.info("[Embedding] Running keyword search", {
      query: query.substring(0, 100),
      topK,
      conversationId,
      documentId,
    });

    let rows = await runKeywordQuery(AND_TSQUERY, query, topK, conversationId, documentId);
    let matchTier: KeywordSearchResult["matchTier"] = "strict";
    if (rows.length === 0) {
      rows = await runKeywordQuery(OR_TSQUERY, query, topK, conversationId, documentId);
      matchTier = "loose";
    }

    logger.info("[Embedding] Keyword search completed", {
      resultsFound: rows.length,
      matchTier,
    });

    return rows.map((r) => ({ ...r, matchTier }));
  } catch (error) {
    // Table/tsvector column may not exist yet (no documents ingested) —
    // treat as "no keyword hits" rather than failing hybrid search entirely.
    logger.warn("[Embedding] Keyword search unavailable, returning no results", {
      error: error instanceof Error ? error.message : error,
    });
    return [];
  }
}

// ============================================================================
// FULL DOCUMENT FETCH (ORDERED, NOT SEARCH-BASED)
// ============================================================================
//
// For whole-document requests ("summarize this", "give me an overview") the
// user's message has no specific semantic content to match against any one
// chunk, so similarity/keyword search over it reliably returns zero hits —
// that's not a relevance signal, it's a query-shape mismatch. This bypasses
// search entirely and returns the document's chunks in original order, up to
// a char budget, so a caller can hand the (near-)full text to an agent.

export interface DocumentChunksResult {
  documentId: string;
  chunks: {
    chunkIndex: number;
    content: string;
    pageNumber?: number;
    pageRangeStart?: number;
    pageRangeEnd?: number;
  }[];
  truncated: boolean;
  totalChunkCount: number;
}

export async function getAllChunksForDocument(
  documentId: string,
  maxChars: number = 40000 // ~10k tokens, safe budget alongside the rest of the prompt
): Promise<DocumentChunksResult> {
  const db = getDatabase();
  const table = `"${EMBEDDING_CONFIG.indexName}"`;

  const result = await db.query(
    `SELECT metadata FROM ${table}
     WHERE metadata->>'documentId' = $1
     ORDER BY (metadata->>'chunkIndex')::int ASC`,
    [documentId]
  );
  const rows = result.rows as { metadata: EmbeddingMetadata }[];

  let usedChars = 0;
  const chunks: DocumentChunksResult["chunks"] = [];
  let truncated = false;
  for (const row of rows) {
    const content = row.metadata.chunkContent;
    if (usedChars + content.length > maxChars && chunks.length > 0) {
      truncated = true;
      break;
    }
    chunks.push({
      chunkIndex: row.metadata.chunkIndex,
      content,
      pageNumber: row.metadata.pageNumber,
      pageRangeStart: row.metadata.pageRangeStart,
      pageRangeEnd: row.metadata.pageRangeEnd,
    });
    usedChars += content.length;
  }

  return { documentId, chunks, truncated, totalChunkCount: rows.length };
}

// ============================================================================
// HYBRID SEARCH (VECTOR + KEYWORD, FUSED VIA RECIPROCAL RANK FUSION)
// ============================================================================
//
// Vector cosine-similarity and BM25-style ts_rank scores live on incompatible
// scales, so we don't blend the raw scores. Reciprocal Rank Fusion (RRF)
// instead fuses by *rank position* within each ranking — a chunk that shows
// up near the top of either list scores well, one that shows up near the top
// of both scores best. `k` (60, the standard default from the original RRF
// paper) dampens how much a single ranking's top slot can dominate.
//
// This is purely additive: `searchSimilarChunks` / `searchSimilarChunksWithExpansion`
// are untouched, so every existing caller keeps its current vector-only behavior.
//
// RRF's fused score has no absolute meaning (it's rank position, not
// similarity), so it can't be thresholded on its own — the vector side
// always returns its top candidates even when none are actually relevant
// (searchSimilarChunks is called with minScore 0 here). Relevance is instead
// decided per-candidate by how it was found:
//   - "strict" keyword match (every query term present): trusted outright.
//   - "loose" keyword match (partial term overlap, only reached because the
//     strict query found nothing): a single shared word isn't enough proof
//     of relevance on its own, so it additionally needs a modest vector
//     score as corroboration (`looseKeywordVectorFloor`) — otherwise a
//     generic term shared with an unrelated query would falsely qualify.
//   - vector-only (no keyword match at all): needs the full
//     `vectorRelevanceThreshold` to qualify, same bar as plain vector search.

const RRF_K = 60;

function reciprocalRankFusion(
  rankings: SearchResult[][],
  topK: number
): SearchResult[] {
  const fused = new Map<string, { score: number; metadata: EmbeddingMetadata }>();

  for (const ranking of rankings) {
    ranking.forEach((result, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      const existing = fused.get(result.id);
      if (existing) {
        existing.score += contribution;
      } else {
        fused.set(result.id, { score: contribution, metadata: result.metadata });
      }
    });
  }

  return Array.from(fused.entries())
    .map(([id, { score, metadata }]) => ({ id, score, metadata }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export async function hybridSearchChunks(
  query: string,
  topK: number = 5,
  conversationId?: string,
  vectorRelevanceThreshold: number = 0.5,
  looseKeywordVectorFloor: number = 0.2,
  documentId?: string
): Promise<SearchResult[]> {
  // Pull a wider candidate pool from each ranking than `topK` before fusing,
  // so a chunk that's e.g. #2 on keyword but outside vector's top-5 still
  // gets a chance to surface once both rankings are combined.
  const candidatePoolSize = topK * 4;

  const [vectorResults, keywordResults] = await Promise.all([
    searchSimilarChunks(query, candidatePoolSize, 0, conversationId, documentId),
    keywordSearchChunks(query, candidatePoolSize, conversationId, documentId),
  ]);

  logger.info("[Embedding] Hybrid search completed", {
    vectorHits: vectorResults.length,
    keywordHits: keywordResults.length,
  });

  const vectorScoreById = new Map(vectorResults.map((r) => [r.id, r.score]));
  const strictKeywordIds = new Set(
    keywordResults.filter((r) => r.matchTier === "strict").map((r) => r.id)
  );
  const looseKeywordIds = new Set(
    keywordResults.filter((r) => r.matchTier === "loose").map((r) => r.id)
  );

  const fused = reciprocalRankFusion(
    [vectorResults, keywordResults],
    candidatePoolSize
  );

  const relevant = fused.filter((r) => {
    const vectorScore = vectorScoreById.get(r.id) ?? 0;
    if (strictKeywordIds.has(r.id)) return true;
    if (looseKeywordIds.has(r.id)) return vectorScore >= looseKeywordVectorFloor;
    return vectorScore >= vectorRelevanceThreshold;
  });

  return relevant.slice(0, topK);
}

// ============================================================================
// MASTRA TOOL - EMBED CHUNKS
// ============================================================================

export const embeddingTool = {
  id: "embed-and-store-chunks",
  description:
    "Generate embeddings for document chunks and store in PgVector with automatic indexing",
  inputSchema: {
    type: "object" as const,
    properties: {
      chunks: {
        type: "array",
        description: "Array of document chunks with content and metadata",
        items: {
          type: "object",
          properties: {
            index: { type: "number" },
            content: { type: "string" },
            metadata: { type: "object" },
          },
        },
      },
      documentId: {
        type: "string",
        description: "Document ID for metadata association",
      },
      conversationId: {
        type: "string",
        description: "Conversation ID to scope retrieval to",
      },
    },
    required: ["chunks", "documentId", "conversationId"],
  },
  execute: async (input: { chunks: Chunk[]; documentId: string; conversationId: string }) => {
    try {
      const startTime = Date.now();

      await embedAndStoreChunks(input.chunks, input.documentId, input.conversationId);

      const executionTime = Date.now() - startTime;

      return {
        success: true,
        documentId: input.documentId,
        chunksProcessed: input.chunks.length,
        executionTimeMs: executionTime,
        indexName: EMBEDDING_CONFIG.indexName,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Embedding failed",
      };
    }
  },
};

// ============================================================================
// MASTRA TOOL - SEARCH EMBEDDINGS
// ============================================================================

export const searchEmbeddingsTool = {
  id: "search-similar-chunks",
  description:
    "Search for similar document chunks using semantic similarity in PgVector",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Search query",
      },
      topK: {
        type: "number",
        description: "Number of results to return (default: 5)",
        default: 5,
      },
      threshold: {
        type: "number",
        description: "Similarity threshold 0-1 (default: 0.5)",
        default: 0.5,
      },
    },
    required: ["query"],
  },
  execute: async (input: {
    query: string;
    topK?: number;
    threshold?: number;
  }) => {
    try {
      const results = await searchSimilarChunks(
        input.query,
        input.topK || 5,
        input.threshold || 0.5
      );

      return {
        success: true,
        query: input.query,
        resultsFound: results.length,
        results: results.map((r) => ({
          id: r.id,
          score: r.score,
          content: r.metadata.chunkContent.substring(0, 200),
          documentId: r.metadata.documentId,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Search failed",
      };
    }
  },
};