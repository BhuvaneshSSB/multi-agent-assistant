import { PgVector } from "@mastra/pg";
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { logger } from "../../utils/logger";
import { config } from "../../config/env";
import { Chunk } from "./chunking";

// ============================================================================
// EMBEDDING CONFIGURATION
// ============================================================================

export const EMBEDDING_CONFIG = {
  model: "openai/text-embedding-3-small",
  dimension: 1536, // text-embedding-3-small dimensions
  batchSize: 25, // OpenAI batch limit
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
// GENERATE EMBEDDINGS (BATCH PROCESSING)
// ============================================================================

export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  try {
    if (texts.length === 0) {
      logger.warn("[Embedding] No texts to embed");
      return [];
    }

    logger.info("[Embedding] Generating embeddings", {
      textCount: texts.length,
      batchSize: EMBEDDING_CONFIG.batchSize,
    });

    const embeddings: number[][] = [];
    const batches = Math.ceil(texts.length / EMBEDDING_CONFIG.batchSize);

    for (let i = 0; i < batches; i++) {
      const start = i * EMBEDDING_CONFIG.batchSize;
      const end = Math.min((i + 1) * EMBEDDING_CONFIG.batchSize, texts.length);
      const batchTexts = texts.slice(start, end);

      logger.info(`[Embedding] Processing batch ${i + 1}/${batches}`, {
        batchStart: start,
        batchEnd: end,
        batchSize: batchTexts.length,
      });

      try {
        // Call embedder for batch
        const { embeddings: batchEmbeddings } = await embedder.doEmbed({
          values: batchTexts,
        });

        embeddings.push(...batchEmbeddings);

        logger.info(`[Embedding] Batch ${i + 1} completed`, {
          embeddingsGenerated: embeddings.length,
        });
      } catch (batchError) {
        logger.error(`[Embedding] Batch ${i + 1} failed`, { error: batchError });
        throw batchError;
      }

      // Add small delay between batches to avoid rate limiting
      if (i < batches - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

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
  sectionTitle?: string;
  contentType?: string;
  hierarchy?: string[];
}

export async function storeEmbeddings(
  embeddings: number[][],
  metadata: EmbeddingMetadata[]
): Promise<void> {
  try {
    if (embeddings.length === 0) {
      logger.warn("[Embedding] No embeddings to store");
      return;
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

    // Ensure index exists before storing
    await ensureIndexCreated();

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
    await pgVector.upsert({
      indexName: EMBEDDING_CONFIG.indexName,
      vectors: embeddings,
      metadata: preparedMetadata,
      ids,
    });

    logger.info("[Embedding] Embeddings stored successfully", {
      indexName: EMBEDDING_CONFIG.indexName,
      storedCount: embeddings.length,
    });
  } catch (error) {
    logger.error("[Embedding] Error storing embeddings", { error });
    throw error;
  }
}

// ============================================================================
// COMPLETE PIPELINE: EMBED + STORE
// ============================================================================

export async function embedAndStoreChunks(
  chunks: Chunk[],
  documentId: string,
  conversationId: string
): Promise<void> {
  try {
    logger.info("[Embedding] Starting embed and store pipeline", {
      documentId,
      chunkCount: chunks.length,
    });

    // Step 1: Extract texts from chunks
    const texts = chunks.map((chunk) => chunk.content);

    // Step 2: Generate embeddings
    const embeddings = await generateEmbeddings(texts);

    // Step 3: Prepare metadata
    const metadata: EmbeddingMetadata[] = chunks.map((chunk) => ({
      documentId,
      conversationId,
      chunkIndex: chunk.index,
      chunkContent: chunk.content,
      pageNumber: chunk.metadata.pageNumber,
      sectionTitle: chunk.metadata.sectionTitle,
    }));

    // Step 4: Store embeddings with metadata
    await storeEmbeddings(embeddings, metadata);

    logger.info("[Embedding] Embed and store pipeline completed", {
      documentId,
      processedChunks: chunks.length,
    });
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
  conversationId?: string
): Promise<SearchResult[]> {
  try {
    logger.info("[Embedding] Searching similar chunks", {
      query: query.substring(0, 100),
      topK,
      threshold: similarityThreshold,
      conversationId,
    });

    // Step 1: Generate embedding for query
    const { embeddings: queryEmbeddings } = await embedder.doEmbed({
      values: [query],
    });
    const queryVector = queryEmbeddings[0];

    logger.info("[Embedding] Query embedding generated", {
      dimension: queryVector.length,
    });

    // Step 2: Search in PgVector, scoped to the conversation when provided
    // so unrelated conversations' documents never surface as answers.
    const results = await pgVector.query({
      indexName: EMBEDDING_CONFIG.indexName,
      queryVector,
      topK,
      minScore: similarityThreshold,
      filter: conversationId ? { conversationId } : undefined,
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