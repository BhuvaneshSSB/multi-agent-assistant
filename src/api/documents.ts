import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { documentAgent } from "../mastra/agents/document";
import { executeDocumentIngestion } from "../mastra/workflows/document-ingestion";
import { getStore } from "../mastra/storage/store";
import { ValidationError, NotFoundError, DocumentFormat } from "../types/index";
import { logger } from "../utils/logger";

// ============================================================================
// UPLOAD DOCUMENT ENDPOINT
// ============================================================================

/**
 * @openapi
 * /api/documents/upload:
 *   post:
 *     summary: Upload and ingest a document into the RAG pipeline
 *     description: >
 *       Parses, chunks, embeds, and stores the document so its content can later
 *       be searched by the document agent.
 *     tags: [Documents]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               conversationId:
 *                 type: string
 *                 description: Existing conversation thread to attach this document to; a random UUID is generated if omitted
 *               userId:
 *                 type: string
 *                 description: Existing user identifier; a random UUID is generated if omitted
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: The document file (pdf, docx, xlsx, pptx, or csv)
 *     responses:
 *       200:
 *         description: Document ingested successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 documentId:
 *                   type: string
 *                 filename:
 *                   type: string
 *                 format:
 *                   type: string
 *                   enum: [pdf, docx, xlsx, pptx, csv]
 *                 conversationId:
 *                   type: string
 *                 userId:
 *                   type: string
 *                 uploadedAt:
 *                   type: string
 *                   format: date-time
 *                 executionTimeMs:
 *                   type: number
 *                 ingestion:
 *                   type: object
 *                   properties:
 *                     documentId:
 *                       type: string
 *                     filename:
 *                       type: string
 *                     totalChunks:
 *                       type: number
 *                     embeddingsGenerated:
 *                       type: number
 *                     status:
 *                       type: string
 *                     executionTimeMs:
 *                       type: number
 *       400:
 *         description: Missing or invalid fields, or unsupported file format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export async function handleUploadDocument(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const uploadedFile = req.file;
    const conversationId = req.body.conversationId || uuidv4();
    const userId = req.body.userId || uuidv4();

    if (!uploadedFile) {
      throw new ValidationError("file is required (multipart/form-data upload)");
    }

    const filename = uploadedFile.originalname;

    // Detect file format from filename
    const ext = filename.split(".").pop()?.toLowerCase();
    const validFormats = ["pdf", "docx", "xlsx", "pptx", "csv"];
    if (!ext || !validFormats.includes(ext)) {
      throw new ValidationError(
        `Invalid file format. Supported: ${validFormats.join(", ")}`
      );
    }

    const format = ext as DocumentFormat;

    // Store document metadata in database
    const store = getStore();
    const fileBuffer = uploadedFile.buffer;

    const documentId = await store.saveDocument(
      conversationId,
      userId,
      filename,
      format,
      fileBuffer.length,
      {
        uploadedAt: new Date().toISOString(),
      }
    );

    logger.info("[API] Document upload started", {
      filename,
      format,
      documentId,
      userId,
    });

    // Run the ingestion pipeline: parse → metadata → chunk → embed → store
    const startTime = Date.now();

    try {
      const ingestionResult = await executeDocumentIngestion(
        fileBuffer,
        filename,
        format,
        userId,
        conversationId,
        documentId
      );

      const executionTime = Date.now() - startTime;

      logger.info("[API] Document ingestion completed", {
        documentId,
        executionTimeMs: executionTime,
      });

      res.status(200).json({
        success: true,
        documentId,
        filename,
        format,
        conversationId,
        userId,
        uploadedAt: new Date().toISOString(),
        executionTimeMs: executionTime,
        ingestion: ingestionResult,
      });
    } catch (ingestionError) {
      await store.updateDocumentStatus(
        documentId,
        "failed",
        undefined,
        ingestionError instanceof Error
          ? ingestionError.message
          : String(ingestionError)
      );
      throw ingestionError;
    }
  } catch (error) {
    logger.error("[API] Upload document failed", error);
    next(error);
  }
}

// ============================================================================
// QUERY DOCUMENT ENDPOINT
// ============================================================================

/**
 * @openapi
 * /api/documents/{documentId}/query:
 *   post:
 *     summary: Ask the document agent a question about a document
 *     description: >
 *       Performs a semantic search over ingested document chunks and returns
 *       an answer with citations.
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query]
 *             properties:
 *               conversationId:
 *                 type: string
 *                 description: Existing conversation thread to continue; a random UUID is generated if omitted
 *               userId:
 *                 type: string
 *                 description: Existing user identifier; a random UUID is generated if omitted
 *               query:
 *                 type: string
 *                 description: Question about the document's content
 *     responses:
 *       200:
 *         description: Agent-generated answer
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 documentId:
 *                   type: string
 *                 query:
 *                   type: string
 *                 conversationId:
 *                   type: string
 *                 userId:
 *                   type: string
 *                 response:
 *                   type: object
 *                   description: Raw result from the document agent's generate() call
 *                 executionTimeMs:
 *                   type: number
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Missing or invalid fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export async function handleQueryDocument(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { query } = req.body;
    const { documentId } = req.params;
    const conversationId = req.body.conversationId || uuidv4();
    const userId = req.body.userId || uuidv4();

    // Validation
    if (!query || typeof query !== "string") {
      throw new ValidationError("query is required");
    }

    if (!documentId) {
      throw new ValidationError("documentId is required");
    }

    logger.info("[API] Document query started", {
      documentId,
      query: query.substring(0, 100),
      userId,
    });

    // Call document agent to search and answer
    const startTime = Date.now();

    const agentResponse = await documentAgent.generate(
      `Question about document (documentId: ${documentId}): ${query}`,
      {
        memory: {
          thread: conversationId,
          resource: userId,
        },
      }
    );

    const executionTime = Date.now() - startTime;

    logger.info("[API] Document query completed", {
      documentId,
      executionTimeMs: executionTime,
    });

    res.status(200).json({
      success: true,
      documentId,
      query,
      conversationId,
      userId,
      response: agentResponse,
      executionTimeMs: executionTime,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("[API] Query document failed", error);
    next(error);
  }
}

// ============================================================================
// GET DOCUMENT DETAILS ENDPOINT
// ============================================================================

/**
 * @openapi
 * /api/documents/{documentId}:
 *   get:
 *     summary: Get details for a previously uploaded document
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Document details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 documentId:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing documentId
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export async function handleGetDocument(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { documentId } = req.params;

    if (!documentId) {
      throw new ValidationError("documentId is required");
    }

    logger.info("[API] Getting document details", { documentId });

    const store = getStore();
    // Note: You'll need to add getDocument method to your Store
    // For now, we'll return a placeholder

    res.status(200).json({
      success: true,
      documentId,
      message: "Document details endpoint - implement in Store",
    });
  } catch (error) {
    logger.error("[API] Get document failed", error);
    next(error);
  }
}