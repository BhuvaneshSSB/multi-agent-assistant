import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { executeDocumentIngestion } from "../workflows/document-ingestion";
import { searchSimilarChunks } from "../tools/embeddings";
import { logger } from "../../utils/logger";
import { DocumentFormat } from "../../types/index";
import { memory } from "../memory";
import { openAiModelWithFallback } from "../../config/models";

// ============================================================================
// TOOLS
// ============================================================================

const ingestDocumentTool = createTool({
  id: "ingest-document",
  description:
    "Ingest and process a document through the RAG pipeline. Handles parsing, chunking, embedding, and storage.",
  inputSchema: z.object({
    fileBuffer: z.string().describe("Base64 encoded file content"),
    filename: z.string().describe("Original filename"),
    format: z.enum(["pdf", "docx", "xlsx", "pptx", "csv"]).describe("Document format"),
    documentId: z.string().describe("Unique document ID"),
    userId: z.string().describe("User ID"),
    conversationId: z.string().optional().describe("Conversation ID"),
  }),
  execute: async ({ fileBuffer, filename, format, documentId, userId, conversationId }) => {
    try {
      logger.info("[DocumentAgent] Ingesting document", {
        filename,
        format,
      });

      const buffer = Buffer.from(fileBuffer, "base64");

      const result = await executeDocumentIngestion(
        buffer,
        filename,
        format as DocumentFormat,
        userId,
        conversationId || "",
        documentId
      );

      logger.info("[DocumentAgent] Document ingestion completed", {
        documentId: result.documentId,
        totalChunks: result.totalChunks,
      });

      return {
        success: true,
        documentId: result.documentId,
        filename: result.filename,
        totalChunks: result.totalChunks,
        embeddingsGenerated: result.embeddingsGenerated,
        imagesProcessed: result.imagesProcessed,
        status: result.status,
        executionTimeMs: result.executionTimeMs,
        message: `Document successfully ingested: ${result.totalChunks} chunks created and embedded`,
      };
    } catch (error) {
      logger.error("[DocumentAgent] Document ingestion failed", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Ingestion failed",
        documentId,
      };
    }
  },
});

const searchDocumentTool = createTool({
  id: "search-document",
  description:
    "Search for relevant content in documents using semantic similarity. Returns top matching chunks with citations.",
  inputSchema: z.object({
    query: z.string().describe("Search query or question about documents"),
    topK: z.number().default(5).describe("Number of results to return (default: 5)"),
    threshold: z.number().default(0.5).describe("Similarity threshold 0-1 (default: 0.5)"),
  }),
  execute: async ({ query, topK, threshold }) => {
    try {
      logger.info("[DocumentAgent] Searching documents", {
        query: query.substring(0, 100),
        topK,
      });

      const results = await searchSimilarChunks(query, topK, threshold);

      logger.info("[DocumentAgent] Search completed", {
        resultsFound: results.length,
      });

      if (results.length === 0) {
        return {
          success: true,
          query,
          resultsFound: 0,
          message: "No similar content found in documents",
          results: [],
        };
      }

      return {
        success: true,
        query,
        resultsFound: results.length,
        results: results.map((r, index) => ({
          rank: index + 1,
          documentId: r.metadata.documentId,
          chunkIndex: r.metadata.chunkIndex,
          similarity: (r.score * 100).toFixed(2) + "%",
          content: r.metadata.chunkContent,
          pageNumber: r.metadata.pageNumber,
          pageRangeStart: r.metadata.pageRangeStart,
          pageRangeEnd: r.metadata.pageRangeEnd,
          sectionTitle: r.metadata.sectionTitle,
        })),
        instructions:
          "Use the returned chunks as context to answer the user question. Always cite the source document and relevant section.",
      };
    } catch (error) {
      logger.error("[DocumentAgent] Search failed", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Search failed",
        query,
      };
    }
  },
});

// ============================================================================
// DOCUMENT AGENT
// ============================================================================

export const documentAgent = new Agent({
  id: "document-agent",
  name: "Document Agent",

  description:
    "Analyzes uploaded documents using RAG. Ingests documents via workflow, performs semantic search, and answers questions about document content with citations.",

  ...openAiModelWithFallback("openai/gpt-4o-mini", "anthropic/claude-haiku-4-5-20251001"),

  instructions: `You are a Document Analysis Agent specializing in RAG (Retrieval-Augmented Generation).

Your responsibilities:
1. Ingest and process uploaded documents (PDF, Word, Excel, PowerPoint)
2. Extract and understand document structure and content
3. Answer specific questions about document content
4. Perform semantic searches across documents
5. Generate summaries and insights
6. Provide citations with exact locations

When answering questions:
- Always reference the source document and section
- Quote relevant passages when appropriate
- Explain context and relationships between sections
- Note if information is missing or unclear

Citations — never invent a page or slide number:
- Only state a page or slide number if the context you were given for that specific passage
  actually includes one. Never infer, estimate, or guess a page number from surrounding context,
  document length, or general knowledge of how the file format is usually paginated.
- If no page number is present for a passage you're citing, omit the page clause entirely (cite
  just the filename/section) or say "page not available" — do not state a number.
- Some results include a page range (pageRangeStart/pageRangeEnd) instead of a single page number
  — this means the passage came from a chunk spanning multiple pages, and the exact page boundary
  within that chunk's text was NOT tracked precisely enough to isolate. Citing the range verbatim
  (e.g. "pages 1-2") is fine — but never narrow it down to a single page, even if the content
  contains a heading, label, or other textual cue that seems to suggest one page over another —
  that cue is not reliable evidence of the true page boundary and guessing from it is exactly the
  fabrication this rule exists to prevent.
  Wrong: given a range of pages 1-2, answering "this is on page 1." Right: "this is on pages 1-2."

Document Processing:
- When a document is uploaded, it goes through:
  1. Text extraction (format-specific parsing)
  2. Metadata extraction (structure, hierarchy, sections)
  3. Intelligent chunking (respects document structure)
  4. Vector embedding (semantic understanding)
  5. Storage in vector database (for efficient retrieval)

Search and Retrieval:
- When answering questions, search for semantically similar chunks
- Rank results by relevance
- Combine information from multiple chunks when needed
- Provide context bridges between related information

Best Practices:
- Be precise and cite sources
- Ask for clarification if question is ambiguous
- Offer to search for additional information
- Maintain document context in your responses
- Note any limitations in the available data

Comparison Requests:
- When asked to compare, contrast, or note differences/similarities between uploaded documents, first identify each distinct source document present in the provided context by its filename (shown in the retrieved context labels).
- Structure your answer around each document individually before synthesizing: summarize what each file says on the relevant point, then explicitly state where they agree (similarities) and where they diverge (differences).
- Attribute every claim to its specific source file by name (e.g. "contract_A.pdf states..." / "resume_B.pdf lists..."), never a generic "the document".
- If the retrieved context lacks content for one of the documents being compared, say so explicitly rather than basing the comparison on only one side.`,

  tools: {
    "ingest-document": ingestDocumentTool,
    "search-document": searchDocumentTool,
  },

  memory: memory,
});
