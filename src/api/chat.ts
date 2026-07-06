import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { supervisorAgent } from "../mastra/agents/supervisor";
import { executeDocumentIngestion } from "../mastra/workflows/document-ingestion";
import { searchSimilarChunks } from "../mastra/tools/embeddings";
import { getStore } from "../mastra/storage/store";
import { ValidationError, DocumentFormat } from "../types/index";
import { logger } from "../utils/logger";

const VALID_DOCUMENT_FORMATS: DocumentFormat[] = ["pdf", "docx", "xlsx", "pptx", "csv"];
const RETRIEVAL_TOP_K = 5;
const RETRIEVAL_THRESHOLD = 0.5;

/**
 * @openapi
 * /api/chat:
 *   post:
 *     summary: Send a message to the supervisor agent, optionally attaching a document
 *     description: >
 *       Single entry point for the frontend. If a file is attached, it is always
 *       ingested through the RAG pipeline first (parse → chunk → embed → store),
 *       regardless of the message content — ingestion is unconditional, not a
 *       decision the agent makes. Before calling the supervisor, a lightweight
 *       conversation-scoped semantic search runs against previously uploaded
 *       documents using the user's message. If relevant chunks are found above
 *       the similarity threshold, the supervisor is told to answer via the
 *       Document Agent using those chunks; otherwise it's told no relevant
 *       document content exists and to use the Research Agent instead.
 *       Retrieval determines relevance — not the model's guess.
 *     tags: [Chat]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [conversationId, userId]
 *             properties:
 *               conversationId:
 *                 type: string
 *               userId:
 *                 type: string
 *               message:
 *                 type: string
 *                 description: Required unless a file is attached
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Optional document to ingest (pdf, docx, xlsx, pptx, csv)
 *     responses:
 *       200:
 *         description: Assistant response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 conversationId:
 *                   type: string
 *                 userId:
 *                   type: string
 *                 userMessage:
 *                   type: string
 *                 assistantMessage:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 executionTimeMs:
 *                   type: number
 *                 agentsInvolved:
 *                   type: array
 *                   items:
 *                     type: string
 *                 document:
 *                   type: object
 *                   nullable: true
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
 *                 retrieval:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     ranQuery:
 *                       type: boolean
 *                     relevantChunksFound:
 *                       type: number
 *       400:
 *         description: Missing or invalid fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export async function handleChat(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { conversationId, userId, message } = req.body;
    const uploadedFile = req.file;

    // Validation
    if (!conversationId) {
      throw new ValidationError("conversationId is required");
    }

    if (!userId) {
      throw new ValidationError("userId is required");
    }

    if (!uploadedFile && (!message || typeof message !== "string")) {
      throw new ValidationError(
        "message is required and must be a string when no file is attached"
      );
    }

    console.log(`[Chat] User: ${userId}, Conversation: ${conversationId}`);

    // ------------------------------------------------------------------
    // Step 1: Unconditional ingestion. If a file is attached, it always
    // goes through the pipeline — this is never a decision the agent makes.
    // ------------------------------------------------------------------
    let documentResult: {
      documentId: string;
      filename: string;
      totalChunks: number;
      embeddingsGenerated: number;
      status: string;
    } | null = null;

    if (uploadedFile) {
      const filename = uploadedFile.originalname;
      const ext = filename.split(".").pop()?.toLowerCase();

      if (!ext || !VALID_DOCUMENT_FORMATS.includes(ext as DocumentFormat)) {
        throw new ValidationError(
          `Invalid file format. Supported: ${VALID_DOCUMENT_FORMATS.join(", ")}`
        );
      }

      const format = ext as DocumentFormat;
      const documentId = uuidv4();

      logger.info("[Chat] Document attached, ingesting", {
        filename,
        format,
        documentId,
      });

      const store = getStore();
      await store.saveDocument(
        conversationId,
        userId,
        filename,
        format,
        uploadedFile.buffer.length,
        { uploadedAt: new Date().toISOString() }
      );

      const ingestionResult = await executeDocumentIngestion(
        uploadedFile.buffer,
        filename,
        format,
        userId,
        conversationId,
        documentId
      );

      documentResult = {
        documentId: ingestionResult.documentId,
        filename: ingestionResult.filename,
        totalChunks: ingestionResult.totalChunks,
        embeddingsGenerated: ingestionResult.embeddingsGenerated,
        status: ingestionResult.status,
      };

      logger.info("[Chat] Document ingestion completed", documentResult);
    }

    // ------------------------------------------------------------------
    // Step 2: Retrieval-first routing. If the user asked something, check
    // whether previously uploaded documents in this conversation actually
    // have a relevant answer — via real semantic search, not model guessing.
    // ------------------------------------------------------------------
    let retrievalNote = "";
    let relevantChunksFound = 0;
    const ranQuery = typeof message === "string" && message.length > 0;

    if (ranQuery) {
      try {
        const results = await searchSimilarChunks(
          message,
          RETRIEVAL_TOP_K,
          RETRIEVAL_THRESHOLD,
          conversationId
        );
        relevantChunksFound = results.length;

        if (results.length > 0) {
          const context = results
            .map(
              (r, i) =>
                `[${i + 1}] (documentId: ${r.metadata.documentId}${
                  r.metadata.pageNumber ? `, page ${r.metadata.pageNumber}` : ""
                }) ${r.metadata.chunkContent}`
            )
            .join("\n\n");

          retrievalNote = `\n\n[System: retrieval found ${results.length} relevant chunk(s) in this conversation's uploaded documents. Use the Document Agent to answer, grounded in this retrieved context — cite document/page:\n${context}]`;
        } else {
          retrievalNote =
            "\n\n[System: no relevant content found in this conversation's uploaded documents (or none have been uploaded). Use the Research Agent instead.]";
        }
      } catch (error) {
        // No documents ingested yet (e.g. vector index not created) — treat
        // as "nothing relevant" rather than failing the whole chat request.
        logger.warn("[Chat] Retrieval gate failed, falling back to no-match", {
          error: error instanceof Error ? error.message : error,
        });
        retrievalNote =
          "\n\n[System: no relevant content found in this conversation's uploaded documents. Use the Research Agent instead.]";
      }
    }

    const documentNote = documentResult
      ? `\n\n[System: document ingested — documentId: ${documentResult.documentId}, filename: ${documentResult.filename}, ${documentResult.totalChunks} chunks indexed.]`
      : "";

    const supervisorMessage = `${message || "I've uploaded a document."}${documentNote}${retrievalNote}`;

    console.log(`[Chat] Message: ${supervisorMessage.substring(0, 150)}...`);

    // Call supervisor agent — track real delegations via the delegation hook
    // rather than assuming which sub-agents ran.
    const delegatedAgents: string[] = [];
    const startTime = Date.now();

    const response = await supervisorAgent.generate(supervisorMessage, {
      memory: {
        thread: conversationId,
        resource: userId,
      },
      maxSteps: 10, // Allow supervisor to make up to 10 agent calls
      delegation: {
        onDelegationStart: async (context) => {
          delegatedAgents.push(context.primitiveId);
          return { proceed: true };
        },
      },
    });

    const executionTime = Date.now() - startTime;

    console.log(`[Chat] Response generated in ${executionTime}ms`);

    // Return response
    res.status(200).json({
      conversationId,
      userId,
      userMessage: message || null,
      assistantMessage: response.text || response,
      timestamp: new Date().toISOString(),
      executionTimeMs: executionTime,
      agentsInvolved: ["supervisor", ...new Set(delegatedAgents)],
      document: documentResult,
      retrieval: ranQuery ? { ranQuery, relevantChunksFound } : null,
    });
  } catch (error) {
    console.error("[Chat] Error:", error);
    next(error);
  }
}