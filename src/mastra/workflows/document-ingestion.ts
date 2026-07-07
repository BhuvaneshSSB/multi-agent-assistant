import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { parseDocument } from "../tools/document-parser";
import { extractAllMetadata } from "../tools/metadata-extractor";
import { chunkDocumentFormatAware, getChunkStats } from "../tools/chunking";
import { embedAndStoreChunks } from "../tools/embeddings";
import { getStore } from "../storage/store";
import { DocumentFormat, DocumentStatus } from "../../types/index";

// ============================================================================
// WORKFLOW TYPES
// ============================================================================

export interface DocumentIngestionInput {
  fileBuffer: Buffer;
  filename: string;
  format: DocumentFormat;
  documentId: string;
  userId: string;
  conversationId: string;
}

export interface DocumentIngestionOutput {
  documentId: string;
  filename: string;
  totalChunks: number;
  embeddingsGenerated: number;
  status: DocumentStatus;
  executionTimeMs: number;
}

const documentFormatSchema = z.enum(["pdf", "docx", "xlsx", "pptx", "csv"]);

const chunkSchema = z.object({
  id: z.string(),
  index: z.number(),
  content: z.string(),
  metadata: z.object({
    documentId: z.string().optional(),
    pageNumber: z.number().optional(),
    sectionTitle: z.string().optional(),
    sourceOffset: z.number(),
  }),
});

// ============================================================================
// STEP 1: PARSE DOCUMENT
// ============================================================================

const parseDocumentStep = createStep({
  id: "parse-document",
  description: "Extract text from uploaded document",
  inputSchema: z.object({
    // Base64 string, not a raw Buffer: Mastra persists this step's input as
    // part of the workflow snapshot (via `storage: pgStore` in mastra/index.ts)
    // on every step transition. Node's default JSON serialization of a Buffer
    // is `{"type":"Buffer","data":[b0,b1,...]}` — one array element per byte —
    // which for a multi-MB PDF balloons into tens of millions of characters
    // and takes real wall-clock time to serialize and write to Postgres on
    // every step. Base64 serializes as a single string at ~1.33x the raw
    // size, avoiding the array-of-numbers blowup entirely.
    fileBuffer: z.string().describe("Base64-encoded file content"),
    filename: z.string().describe("Original filename"),
    format: documentFormatSchema.describe("Document format"),
    documentId: z.string().describe("Document ID"),
    conversationId: z.string().describe("Conversation ID"),
  }),
  outputSchema: z.object({
    text: z.string(),
    documentId: z.string(),
    conversationId: z.string(),
    filename: z.string(),
    format: documentFormatSchema,
    durationMs: z.number(),
  }),
  execute: async ({ inputData }) => {
    const stepStart = Date.now();
    try {
      logger.info("[Workflow] Step 1: Parsing document", {
        filename: inputData.filename,
        format: inputData.format,
      });

      const buffer = Buffer.from(inputData.fileBuffer, "base64");
      const text = await parseDocument(buffer, inputData.format);
      const durationMs = Date.now() - stepStart;

      logger.info("[Workflow] Step 1 completed: Document parsed", {
        textLength: text.length,
        documentId: inputData.documentId,
        durationMs,
      });

      return {
        text,
        documentId: inputData.documentId,
        conversationId: inputData.conversationId,
        filename: inputData.filename,
        format: inputData.format,
        durationMs,
      };
    } catch (error) {
      logger.error("[Workflow] Step 1 failed: Document parsing", error);
      throw error;
    }
  },
});

// ============================================================================
// STEP 2: EXTRACT METADATA
// ============================================================================

const extractMetadataStep = createStep({
  id: "extract-metadata",
  description: "Extract metadata from document",
  inputSchema: z.object({
    text: z.string(),
    filename: z.string(),
    format: documentFormatSchema,
    documentId: z.string(),
    conversationId: z.string(),
  }),
  outputSchema: z.object({
    text: z.string(),
    documentId: z.string(),
    conversationId: z.string(),
    filename: z.string(),
    format: documentFormatSchema,
    title: z.string().optional(),
    author: z.string().optional(),
    wordCount: z.number().optional(),
    pageBreaks: z.array(z.number()),
    hierarchy: z.array(z.string()),
    durationMs: z.number(),
  }),
  execute: async ({ inputData }) => {
    const stepStart = Date.now();
    try {
      logger.info("[Workflow] Step 2: Extracting metadata", {
        filename: inputData.filename,
        format: inputData.format,
      });

      const metadataResult = extractAllMetadata(
        inputData.text,
        inputData.documentId,
        inputData.filename,
        inputData.format
      );
      const durationMs = Date.now() - stepStart;

      logger.info("[Workflow] Step 2 completed: Metadata extracted", {
        title: metadataResult.documentMetadata.title,
        pages: metadataResult.pageBreaks.length,
        sections: metadataResult.hierarchy.length,
        durationMs,
      });

      return {
        text: inputData.text,
        documentId: inputData.documentId,
        conversationId: inputData.conversationId,
        filename: inputData.filename,
        format: inputData.format,
        title: metadataResult.documentMetadata.title,
        author: metadataResult.documentMetadata.author,
        wordCount: metadataResult.documentMetadata.wordCount,
        pageBreaks: metadataResult.pageBreaks,
        hierarchy: metadataResult.hierarchy,
        durationMs,
      };
    } catch (error) {
      logger.error("[Workflow] Step 2 failed: Metadata extraction", error);
      throw error;
    }
  },
});

// ============================================================================
// STEP 3: CHUNK DOCUMENT
// ============================================================================

const chunkDocumentStep = createStep({
  id: "chunk-document",
  description: "Split document into chunks",
  inputSchema: z.object({
    text: z.string(),
    format: documentFormatSchema,
    documentId: z.string(),
    conversationId: z.string(),
  }),
  outputSchema: z.object({
    chunks: z.array(chunkSchema),
    documentId: z.string(),
    conversationId: z.string(),
    totalChunks: z.number(),
    avgChunkSize: z.number(),
    durationMs: z.number(),
  }),
  execute: async ({ inputData }) => {
    const stepStart = Date.now();
    try {
      logger.info("[Workflow] Step 3: Chunking document", {
        format: inputData.format,
        textLength: inputData.text.length,
      });

      const chunks = await chunkDocumentFormatAware(
        inputData.text,
        inputData.format,
        inputData.documentId
      );

      const stats = getChunkStats(chunks);
      const durationMs = Date.now() - stepStart;

      logger.info("[Workflow] Step 3 completed: Document chunked", {
        totalChunks: stats.totalChunks,
        avgChunkSize: stats.avgChunkSize,
        durationMs,
      });

      return {
        chunks,
        documentId: inputData.documentId,
        conversationId: inputData.conversationId,
        totalChunks: stats.totalChunks,
        avgChunkSize: stats.avgChunkSize,
        durationMs,
      };
    } catch (error) {
      logger.error("[Workflow] Step 3 failed: Document chunking", error);
      throw error;
    }
  },
});

// ============================================================================
// STEP 4: GENERATE EMBEDDINGS
// ============================================================================

const generateEmbeddingsStep = createStep({
  id: "generate-embeddings",
  description: "Generate embeddings for chunks",
  inputSchema: z.object({
    chunks: z.array(chunkSchema),
    documentId: z.string(),
    conversationId: z.string(),
    totalChunks: z.number(),
  }),
  outputSchema: z.object({
    documentId: z.string(),
    totalChunks: z.number(),
    embeddingsGenerated: z.number(),
    durationMs: z.number(),
    embedMs: z.number(),
    indexEnsureMs: z.number(),
    upsertMs: z.number(),
  }),
  execute: async ({ inputData }) => {
    const stepStart = Date.now();
    try {
      logger.info("[Workflow] Step 4: Generating embeddings", {
        chunkCount: inputData.chunks.length,
      });

      // Note: embedAndStoreChunks both generates AND stores
      const { embedMs, indexEnsureMs, upsertMs } = await embedAndStoreChunks(
        inputData.chunks,
        inputData.documentId,
        inputData.conversationId
      );
      const durationMs = Date.now() - stepStart;

      logger.info("[Workflow] Step 4 completed: Embeddings generated and stored", {
        embeddingsGenerated: inputData.chunks.length,
        durationMs,
        embedMs,
        indexEnsureMs,
        upsertMs,
      });

      return {
        documentId: inputData.documentId,
        totalChunks: inputData.totalChunks,
        embeddingsGenerated: inputData.chunks.length,
        durationMs,
        embedMs,
        indexEnsureMs,
        upsertMs,
      };
    } catch (error) {
      logger.error("[Workflow] Step 4 failed: Embedding generation", error);
      throw error;
    }
  },
});

// ============================================================================
// STEP 5: UPDATE DOCUMENT STATUS
// ============================================================================

const updateStatusStep = createStep({
  id: "update-document-status",
  description: "Update document status in database",
  inputSchema: z.object({
    documentId: z.string(),
    totalChunks: z.number(),
    embeddingsGenerated: z.number(),
  }),
  outputSchema: z.object({
    documentId: z.string(),
    filename: z.string(),
    totalChunks: z.number(),
    embeddingsGenerated: z.number(),
    status: z.string(),
  }),
  execute: async ({ inputData, getStepResult }) => {
    try {
      logger.info("[Workflow] Step 5: Updating document status", {
        documentId: inputData.documentId,
      });

      const store = getStore();

      await store.updateDocumentStatus(
        inputData.documentId,
        "completed",
        inputData.totalChunks
      );

      const { filename } = getStepResult(parseDocumentStep);

      logger.info("[Workflow] Step 5 completed: Document status updated", {
        documentId: inputData.documentId,
        status: "completed",
        totalChunks: inputData.totalChunks,
      });

      // Consolidated per-stage timing breakdown, pulled from every prior
      // step's own recorded durationMs via getStepResult (each step already
      // measured itself — this just aggregates them into one summary line
      // instead of requiring someone to piece it together from separate logs).
      const parseResult = getStepResult(parseDocumentStep);
      const metadataResult = getStepResult(extractMetadataStep);
      const chunkResult = getStepResult(chunkDocumentStep);
      const embedResult = getStepResult(generateEmbeddingsStep);

      logger.info("[Workflow] Ingestion stage timings", {
        documentId: inputData.documentId,
        parseMs: parseResult.durationMs,
        metadataMs: metadataResult.durationMs,
        chunkMs: chunkResult.durationMs,
        embedAndStoreMs: embedResult.durationMs,
        embedOnlyMs: embedResult.embedMs,
        indexEnsureMs: embedResult.indexEnsureMs,
        vectorUpsertMs: embedResult.upsertMs,
        stagesTotalMs:
          parseResult.durationMs +
          metadataResult.durationMs +
          chunkResult.durationMs +
          embedResult.durationMs,
      });

      return {
        documentId: inputData.documentId,
        filename,
        totalChunks: inputData.totalChunks,
        embeddingsGenerated: inputData.embeddingsGenerated,
        status: "completed",
      };
    } catch (error) {
      logger.error("[Workflow] Step 5 failed: Status update", error);
      throw error;
    }
  },
});

// ============================================================================
// CREATE WORKFLOW
// ============================================================================

export const documentIngestionWorkflow = createWorkflow({
  id: "document-ingestion",
  description:
    "End-to-end RAG document ingestion: parse → metadata → chunk → embed → store",
  inputSchema: z.object({
    // See parseDocumentStep's inputSchema for why this is base64, not Buffer.
    fileBuffer: z.string().describe("Base64-encoded file content"),
    filename: z.string().describe("Original filename"),
    format: documentFormatSchema.describe("Document format"),
    documentId: z.string().describe("Unique document ID"),
    userId: z.string().describe("User ID"),
    conversationId: z.string().describe("Conversation ID"),
  }),
  outputSchema: z.object({
    documentId: z.string(),
    filename: z.string(),
    totalChunks: z.number(),
    embeddingsGenerated: z.number(),
    status: z.string(),
  }),
})
  .then(parseDocumentStep)
  .then(extractMetadataStep)
  .then(chunkDocumentStep)
  .then(generateEmbeddingsStep)
  .then(updateStatusStep)
  .commit();

// ============================================================================
// WORKFLOW EXECUTION HELPER
// ============================================================================

export async function executeDocumentIngestion(
  fileBuffer: Buffer,
  filename: string,
  format: DocumentFormat,
  userId: string,
  conversationId: string,
  documentId: string
): Promise<DocumentIngestionOutput> {
  try {
    logger.info("[Workflow] Starting document ingestion workflow", {
      filename,
      format,
      documentId,
    });

    const startTime = Date.now();

    const run = await documentIngestionWorkflow.createRun();
    const result = await run.start({
      inputData: {
        // Encoded to base64 here so the raw Buffer never enters the
        // workflow's persisted snapshot — see parseDocumentStep's
        // inputSchema comment for why that matters.
        fileBuffer: fileBuffer.toString("base64"),
        filename,
        format,
        documentId,
        userId,
        conversationId,
      },
    });

    const executionTime = Date.now() - startTime;

    if (result.status !== "success") {
      throw new Error(
        `Document ingestion workflow did not complete successfully: ${result.status}`
      );
    }

    logger.info("[Workflow] Document ingestion completed", {
      documentId,
      executionTimeMs: executionTime,
    });

    return {
      documentId: result.result.documentId,
      filename: result.result.filename,
      totalChunks: result.result.totalChunks,
      embeddingsGenerated: result.result.embeddingsGenerated,
      status: result.result.status as DocumentStatus,
      executionTimeMs: executionTime,
    };
  } catch (error) {
    logger.error("[Workflow] Document ingestion failed", error);
    throw error;
  }
}
