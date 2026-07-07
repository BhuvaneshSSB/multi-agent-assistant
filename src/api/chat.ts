import { Request, Response, NextFunction } from "express";
import { supervisorAgent } from "../mastra/agents/supervisor";
import { executeDocumentIngestion } from "../mastra/workflows/document-ingestion";
import { hybridSearchChunks, getAllChunksForDocument } from "../mastra/tools/embeddings";
import { getStore } from "../mastra/storage/store";
import { ValidationError, DocumentFormat } from "../types/index";
import { logger } from "../utils/logger";
import { withRetry, isRetryableHttpError } from "../utils/retry";

const VALID_DOCUMENT_FORMATS: DocumentFormat[] = ["pdf", "docx", "xlsx", "pptx", "csv"];
const RETRIEVAL_TOP_K = 5;
const RETRIEVAL_THRESHOLD = 0.5;

// Deterministic comparison-intent gate — kept as a regex, not a model call,
// to match this codebase's "retrieval determines relevance, not the model's
// guess" philosophy (docs/rag/12). False negatives just fall back to the
// existing global-topK path, so the worst case is "no worse than before."
const COMPARISON_INTENT_REGEX =
  /\b(compare|comparison|comparing|compares|difference|differences|differ|differing|versus|vs\.?|similar|similarity|similarities|contrast|contrasting)\b/i;
const COMPARISON_PER_DOC_TOP_K = 3;
const MAX_COMPARISON_DOCUMENTS = 5; // beyond this, fall back to the global-topK path rather than firing unbounded concurrent searches

// Deterministic whole-document-intent gate, same rationale as the comparison
// gate above: "summarize this" has no specific semantic content to match
// against any one chunk (it's a request for the whole document, not a fact
// lookup), so plain similarity/keyword search reliably returns zero hits —
// a query-shape mismatch, not a real "nothing relevant" signal. False
// negatives just fall back to the existing global-topK path.
const SUMMARY_INTENT_REGEX =
  /\b(summar(y|ize|ise|izing|ising|ies)|overview|tl;?dr|key\s*(points|takeaways)|main\s*points|gist|recap)\b/i;
const WHOLE_DOCUMENT_CHAR_BUDGET = 40000; // ~10k tokens, safe alongside the rest of the prompt

// Structured, durable record of which documents/chunks a turn's retrieval
// gate drew on — attached to the persisted message's `content.metadata` so
// the association survives independent of the `[System: ...]` note's wording.
interface RetrievalTurnMetadata {
  documentIds: string[];
  documentRefs: Array<{
    documentId: string;
    filename?: string;
    chunkIndex: number;
    pageNumber?: number;
    pageRangeStart?: number;
    pageRangeEnd?: number;
  }>;
}

// Single source of truth for how a page citation is rendered into a prompt —
// only ever states a page/range the chunk metadata actually has; never
// invents one. See docs/test/16-closing-report.md for the bug this replaced
// (the model stating a specific page number it was never given).
function formatPageCitation(meta: {
  pageNumber?: number;
  pageRangeStart?: number;
  pageRangeEnd?: number;
}): string {
  if (meta.pageNumber) return `page ${meta.pageNumber}`;
  if (meta.pageRangeStart && meta.pageRangeEnd) return `pages ${meta.pageRangeStart}-${meta.pageRangeEnd}`;
  return "";
}

interface DocumentIngestionResult {
  documentId: string;
  filename: string;
  totalChunks: number;
  embeddingsGenerated: number;
  imagesProcessed: number;
  status: string;
}

// Ingests a single attached file (validate → save → parse/chunk/embed).
// The whole per-document pipeline is retried with exponential backoff on
// transient failures (rate limits, 5xx, connection resets) — deterministic
// failures (bad format, corrupt file) are not, since retrying those just
// repeats the same failure. Called concurrently, once per uploaded file, so
// a slow or rate-limited document never blocks its siblings from finishing.
async function ingestUploadedFile(
  uploadedFile: Express.Multer.File,
  conversationId: string,
  userId: string,
  store: ReturnType<typeof getStore>
): Promise<DocumentIngestionResult> {
  const filename = uploadedFile.originalname;
  const ext = filename.split(".").pop()?.toLowerCase();

  if (!ext || !VALID_DOCUMENT_FORMATS.includes(ext as DocumentFormat)) {
    throw new ValidationError(
      `Invalid file format for "${filename}". Supported: ${VALID_DOCUMENT_FORMATS.join(", ")}`
    );
  }

  const format = ext as DocumentFormat;

  const documentId = await store.saveDocument(
    conversationId,
    userId,
    filename,
    format,
    uploadedFile.buffer.length,
    { uploadedAt: new Date().toISOString() }
  );

  logger.info("[Chat] Document attached, ingesting", { filename, format, documentId });

  try {
    const ingestionResult = await withRetry(
      () =>
        executeDocumentIngestion(
          uploadedFile.buffer,
          filename,
          format,
          userId,
          conversationId,
          documentId
        ),
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        isRetryable: isRetryableHttpError,
        label: `document ingestion (${filename})`,
      }
    );

    const documentResult: DocumentIngestionResult = {
      documentId: ingestionResult.documentId,
      filename: ingestionResult.filename,
      totalChunks: ingestionResult.totalChunks,
      embeddingsGenerated: ingestionResult.embeddingsGenerated,
      imagesProcessed: ingestionResult.imagesProcessed,
      status: ingestionResult.status,
    };

    logger.info("[Chat] Document ingestion completed", documentResult);
    return documentResult;
  } catch (ingestionError) {
    await store.updateDocumentStatus(
      documentId,
      "failed",
      undefined,
      ingestionError instanceof Error ? ingestionError.message : String(ingestionError)
    );
    throw ingestionError;
  }
}

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
 *               files:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Optional document(s) to ingest, up to 5 (pdf, docx, xlsx, pptx, csv)
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
 *                 documents:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       documentId:
 *                         type: string
 *                       filename:
 *                         type: string
 *                       totalChunks:
 *                         type: number
 *                       embeddingsGenerated:
 *                         type: number
 *                       imagesProcessed:
 *                         type: number
 *                       status:
 *                         type: string
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
    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];

    if (!conversationId) {
      throw new ValidationError("conversationId is required");
    }

    if (!userId) {
      throw new ValidationError("userId is required");
    }

    if (uploadedFiles.length === 0 && (!message || typeof message !== "string")) {
      throw new ValidationError(
        "message is required and must be a string when no file is attached"
      );
    }

    const store = getStore();

    // ------------------------------------------------------------------
    // Step 1: Unconditional ingestion. Any attached files always go through
    // the pipeline — this is never a decision the agent makes. Files are
    // ingested concurrently (one pipeline per file, each retried with its
    // own exponential backoff) rather than one at a time, so N files take
    // roughly as long as the slowest one instead of the sum of all of them.
    // ------------------------------------------------------------------
    const documentResults: DocumentIngestionResult[] = [];

    if (uploadedFiles.length > 0) {
      const settled = await Promise.allSettled(
        uploadedFiles.map((uploadedFile) =>
          ingestUploadedFile(uploadedFile, conversationId, userId, store)
        )
      );

      for (const result of settled) {
        if (result.status === "fulfilled") {
          documentResults.push(result.value);
        }
      }

      // All files were given a chance to complete (nothing is aborted just
      // because a sibling failed); only after that do we surface a failure —
      // matching the previous all-or-nothing contract for the HTTP response,
      // even though ingestion itself no longer stops early on first failure.
      const firstFailure = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (firstFailure) {
        throw firstFailure.reason;
      }
    }

    // ------------------------------------------------------------------
    // Step 2: Retrieval-first routing. If the user asked something, check
    // whether previously uploaded documents in this conversation actually
    // have a relevant answer — via real semantic search, not model guessing.
    // ------------------------------------------------------------------
    let retrievalNote = "";
    let relevantChunksFound = 0;
    let retrievalMetadata: RetrievalTurnMetadata | null = null;
    const ranQuery = typeof message === "string" && message.length > 0;

    if (ranQuery) {
      try {
        // Look up completed documents in this conversation once — used both
        // to decide whether this is a comparison request and to label every
        // retrieved chunk by filename instead of an opaque documentId.
        const completedDocuments = await store.getDocumentsByConversation(conversationId);
        const filenameById = new Map(completedDocuments.map((d) => [d.id, d.filename]));

        const useComparisonBranch =
          COMPARISON_INTENT_REGEX.test(message) &&
          completedDocuments.length >= 2 &&
          completedDocuments.length <= MAX_COMPARISON_DOCUMENTS;

        const useWholeDocumentBranch =
          !useComparisonBranch &&
          SUMMARY_INTENT_REGEX.test(message) &&
          completedDocuments.length >= 1;

        if (useComparisonBranch) {
          // Comparison request: search each document separately (instead of
          // one shared global top-K) so every document gets a guaranteed
          // slice of context rather than competing with the others for a
          // handful of shared slots.
          const perDocResults = await withRetry(
            () =>
              Promise.all(
                completedDocuments.map((doc) =>
                  hybridSearchChunks(
                    message,
                    COMPARISON_PER_DOC_TOP_K,
                    conversationId,
                    RETRIEVAL_THRESHOLD,
                    undefined,
                    doc.id
                  )
                )
              ),
            { maxRetries: 2, baseDelayMs: 300, maxDelayMs: 2000, label: "retrieval-gate comparison search" }
          );

          relevantChunksFound = perDocResults.reduce((sum, r) => sum + r.length, 0);

          if (relevantChunksFound > 0) {
            const sections = completedDocuments.map((doc, idx) => {
              const docResults = perDocResults[idx];
              if (docResults.length === 0) {
                return `### ${doc.filename} (documentId: ${doc.id})\n(no relevant content retrieved for this document)`;
              }
              const chunksText = docResults
                .map((r, i) => {
                  const citation = formatPageCitation(r.metadata);
                  return `[${i + 1}]${citation ? ` (${citation})` : ""} ${r.metadata.chunkContent}`;
                })
                .join("\n\n");
              return `### ${doc.filename} (documentId: ${doc.id})\n${chunksText}`;
            });

            retrievalNote = `\n\n[System: comparison request detected across ${completedDocuments.length} uploaded documents in this conversation. Retrieval ran separately per document (top ${COMPARISON_PER_DOC_TOP_K} each) so every document gets a fair share of context, not just whichever scores highest overall. Use the Document Agent to answer, addressing each document individually before comparing similarities/differences, and attribute every claim to its specific source file:\n\n${sections.join("\n\n")}]`;

            const documentRefs = perDocResults.flatMap((docResults) =>
              docResults.map((r) => ({
                documentId: r.metadata.documentId,
                filename: filenameById.get(r.metadata.documentId),
                chunkIndex: r.metadata.chunkIndex,
                pageNumber: r.metadata.pageNumber,
                pageRangeStart: r.metadata.pageRangeStart,
                pageRangeEnd: r.metadata.pageRangeEnd,
              }))
            );
            retrievalMetadata = {
              documentIds: [...new Set(documentRefs.map((d) => d.documentId))],
              documentRefs,
            };
          } else {
            retrievalNote =
              "\n\n[System: no relevant content found in this conversation's uploaded documents for this comparison request. Use the Research Agent instead, or ask the user to clarify.]";
          }
        } else if (useWholeDocumentBranch) {
          // Whole-document request ("summarize this", "give me an overview"):
          // prefer the file(s) just uploaded in this request — "this" in
          // "summarize this" refers to what the user just attached — and
          // only fall back to previously uploaded documents in the
          // conversation when nothing was uploaded this turn.
          const justUploadedIds = new Set(documentResults.map((d) => d.documentId));
          let targetDocuments = completedDocuments.filter((d) => justUploadedIds.has(d.id));
          if (targetDocuments.length === 0) {
            targetDocuments =
              completedDocuments.length <= MAX_COMPARISON_DOCUMENTS
                ? completedDocuments
                : completedDocuments.slice(-1); // ambiguous otherwise — default to the most recently uploaded
          }

          const docChunkResults = await withRetry(
            () =>
              Promise.all(
                targetDocuments.map((doc) =>
                  getAllChunksForDocument(doc.id, WHOLE_DOCUMENT_CHAR_BUDGET)
                )
              ),
            { maxRetries: 2, baseDelayMs: 300, maxDelayMs: 2000, label: "retrieval-gate whole-document fetch" }
          );

          relevantChunksFound = docChunkResults.reduce((sum, r) => sum + r.chunks.length, 0);

          if (relevantChunksFound > 0) {
            const sections = targetDocuments.map((doc, idx) => {
              const docResult = docChunkResults[idx];
              const chunksText = docResult.chunks
                .map((c) => {
                  const citation = formatPageCitation(c);
                  return `${citation ? `(${citation}) ` : ""}${c.content}`;
                })
                .join("\n\n");
              const truncationNote = docResult.truncated
                ? `\n[Note: truncated to the first ${docResult.chunks.length} of ${docResult.totalChunkCount} chunks for length; mention this if the summary may be incomplete.]`
                : "";
              return `### ${doc.filename} (documentId: ${doc.id})\n${chunksText}${truncationNote}`;
            });

            retrievalNote = `\n\n[System: whole-document request detected (e.g. "summarize"). Below is the full ordered content of the relevant document(s) in this conversation — not a similarity search result. Use the Document Agent to answer directly from this content:\n\n${sections.join("\n\n")}]`;

            const documentRefs = targetDocuments.flatMap((doc, idx) =>
              docChunkResults[idx].chunks.map((c) => ({
                documentId: doc.id,
                filename: doc.filename,
                chunkIndex: c.chunkIndex,
                pageNumber: c.pageNumber,
                pageRangeStart: c.pageRangeStart,
                pageRangeEnd: c.pageRangeEnd,
              }))
            );
            retrievalMetadata = {
              documentIds: [...new Set(documentRefs.map((d) => d.documentId))],
              documentRefs,
            };
          } else {
            retrievalNote =
              "\n\n[System: whole-document request detected but no content was found for the uploaded document(s) — ingestion may still be indexing. Use the Research Agent instead, or ask the user to retry shortly.]";
          }
        } else {
          const results = await withRetry(
            () => hybridSearchChunks(message, RETRIEVAL_TOP_K, conversationId, RETRIEVAL_THRESHOLD),
            { maxRetries: 2, baseDelayMs: 300, maxDelayMs: 2000, label: "retrieval-gate search" }
          );
          relevantChunksFound = results.length;

          if (results.length > 0) {
            const context = results
              .map((r, i) => {
                const filename = filenameById.get(r.metadata.documentId);
                const citation = formatPageCitation(r.metadata);
                return `[${i + 1}] (file: ${filename ?? "unknown"}, documentId: ${r.metadata.documentId}${
                  citation ? `, ${citation}` : ""
                }) ${r.metadata.chunkContent}`;
              })
              .join("\n\n");

            retrievalNote = `\n\n[System: retrieval found ${results.length} relevant chunk(s) in this conversation's uploaded documents. Use the Document Agent to answer, grounded in this retrieved context — cite document/page:\n${context}]`;

            const documentRefs = results.map((r) => ({
              documentId: r.metadata.documentId,
              filename: filenameById.get(r.metadata.documentId),
              chunkIndex: r.metadata.chunkIndex,
              pageNumber: r.metadata.pageNumber,
              pageRangeStart: r.metadata.pageRangeStart,
              pageRangeEnd: r.metadata.pageRangeEnd,
            }));
            retrievalMetadata = {
              documentIds: [...new Set(documentRefs.map((d) => d.documentId))],
              documentRefs,
            };
          } else {
            retrievalNote =
              "\n\n[System: no relevant content found in this conversation's uploaded documents (or none have been uploaded). Use the Research Agent instead.]";
          }
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

    const documentNote =
      documentResults.length > 0
        ? `\n\n[System: ${documentResults.length} document(s) ingested — ${documentResults
            .map((d) => `documentId: ${d.documentId}, filename: ${d.filename}, ${d.totalChunks} chunks indexed`)
            .join("; ")}.]`
        : "";

    const supervisorMessage = `${message || "I've uploaded document(s)."}${documentNote}${retrievalNote}`;

    // Call supervisor agent — track real delegations via the delegation hook
    // rather than assuming which sub-agents ran.
    const delegatedAgents: string[] = [];
    const startTime = Date.now();

    const supervisorInput = retrievalMetadata
      ? [
          {
            role: "user" as const,
            content: supervisorMessage,
            metadata: retrievalMetadata,
          },
        ]
      : supervisorMessage;

    const response = await supervisorAgent.generate(supervisorInput, {
      memory: {
        thread: conversationId,
        resource: userId,
      },
      maxSteps: 10,
      delegation: {
        onDelegationStart: async (context) => {
          delegatedAgents.push(context.primitiveId);
          return { proceed: true };
        },
      },
    });

    const executionTime = Date.now() - startTime;

    res.status(200).json({
      conversationId,
      userId,
      userMessage: message || null,
      assistantMessage: response.text || response,
      timestamp: new Date().toISOString(),
      executionTimeMs: executionTime,
      agentsInvolved: ["supervisor", ...new Set(delegatedAgents)],
      documents: documentResults,
      retrieval: ranQuery ? { ranQuery, relevantChunksFound } : null,
    });
  } catch (error) {
    logger.error("[Chat] Error", error);
    next(error);
  }
}