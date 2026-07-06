import { Express, Request, Response } from "express";
import multer from "multer";
import { handleChat } from "./chat";
import { handleChunkTest, handleFormatAwareChunkTest, handleMetadataTest, handleParseTest } from "./test";
import { 
  handleUploadDocument, 
  handleQueryDocument, 
  handleGetDocument 
} from "./documents";


const upload = multer({ storage: multer.memoryStorage() });

export function setupRoutes(app: Express) {
  // Chat endpoint (file attachment is optional — multer passes through when absent)
  app.post("/api/chat", upload.single("file"), handleChat);

  /**
   * @openapi
   * /api/status:
   *   get:
   *     summary: API status
   *     tags: [System]
   *     responses:
   *       200:
   *         description: Current API status
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                 agents:
   *                   type: array
   *                   items:
   *                     type: string
   *                 memory:
   *                   type: string
   *                 timestamp:
   *                   type: string
   *                   format: date-time
   */
  app.get("/api/status", (req: Request, res: Response) => {
    res.json({
      message: "Multi-agent assistant API running",
      agents: ["supervisor", "research", "document", "writer"],
      memory: "enabled",
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * @openapi
   * /api/agents:
   *   get:
   *     summary: List available agents
   *     tags: [Agents]
   *     responses:
   *       200:
   *         description: Registered agents
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 agents:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       name:
   *                         type: string
   *                       description:
   *                         type: string
   */

  /**
   * @openapi
   * /api/test/parse-document:
   *   post:
   *     summary: Parse a base64-encoded document
   *     tags: [Test]
   *     requestBody:
   *       required: true
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             required: [file, format]
   *             properties:
   *               file:
   *                 type: string
   *                 format: binary
   *               format:
   *                 type: string
   *                 enum: [pdf, docx, xlsx, pptx, csv]
   *     responses:
   *       200:
   *         description: Parsed document result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 format:
   *                   type: string
   *                 parseTimeMs:
   *                   type: number
   *                 textLength:
   *                   type: number
   *                 wordCount:
   *                   type: number
   *                 preview:
   *                   type: string
   *                 fullText:
   *                   type: string
   *       400:
   *         description: Validation error (missing file or invalid format)
   */
  app.post("/api/test/parse-document", upload.single("file"), handleParseTest);


  /**
   * @openapi
   * /api/test/chunk-document:
   *   post:
   *     summary: Chunk raw text using the recursive chunking strategy
   *     tags: [Test]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [text]
   *             properties:
   *               text:
   *                 type: string
   *                 description: The raw text to chunk
   *               maxSize:
   *                 type: number
   *                 description: Maximum chunk size in tokens
   *                 default: 512
   *               overlap:
   *                 type: number
   *                 description: Overlap between chunks in tokens
   *                 default: 50
   *     responses:
   *       200:
   *         description: Chunked text result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 chunkTimeMs:
   *                   type: number
   *                 totalChunks:
   *                   type: number
   *                 avgChunkSize:
   *                   type: number
   *                 chunks:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       index:
   *                         type: number
   *                       length:
   *                         type: number
   *                       preview:
   *                         type: string
   *                 fullChunks:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       index:
   *                         type: number
   *                       content:
   *                         type: string
   *                       metadata:
   *                         type: object
   *                         properties:
   *                           documentId:
   *                             type: string
   *                           pageNumber:
   *                             type: number
   *                           sectionTitle:
   *                             type: string
   *                           sourceOffset:
   *                             type: number
   *       400:
   *         description: Validation error (missing text)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: "#/components/schemas/Error"
   */
  app.post("/api/test/chunk-document", handleChunkTest);



  /**
   * @openapi
   * /api/test/extract-metadata:
   *   post:
   *     summary: Extract document metadata, page breaks, and section hierarchy from raw text
   *     tags: [Test]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [text, filename, fileType]
   *             properties:
   *               text:
   *                 type: string
   *                 description: The raw document text to extract metadata from
   *               filename:
   *                 type: string
   *                 description: Name of the source file, used to derive the title
   *               fileType:
   *                 type: string
   *                 description: Source document format
   *                 enum: [pdf, docx, xlsx, pptx, csv]
   *                 default: pdf
   *               documentId:
   *                 type: string
   *                 description: Optional document ID (defaults to "doc-123")
   *     responses:
   *       200:
   *         description: Extracted metadata result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 documentMetadata:
   *                   type: object
   *                   properties:
   *                     documentId:
   *                       type: string
   *                     filename:
   *                       type: string
   *                     fileType:
   *                       type: string
   *                     title:
   *                       type: string
   *                     wordCount:
   *                       type: number
   *                     uploadedAt:
   *                       type: string
   *                       format: date-time
   *                     userId:
   *                       type: string
   *                     conversationId:
   *                       type: string
   *                 pageBreaks:
   *                   type: number
   *                   description: Count of detected page breaks
   *                 hierarchy:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: Detected section headings, in document order
   *       400:
   *         description: Validation error (missing text, filename, or fileType)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: "#/components/schemas/Error"
   */
  app.post("/api/test/extract-metadata", handleMetadataTest);


  /**
   * @openapi
   * /api/test/chunk-format-aware:
   *   post:
   *     summary: Chunk raw text using a strategy chosen automatically from the document format
   *     description: >
   *       Uses recursive chunking for PDF/Word, table-aware chunking for Excel,
   *       and slide-based chunking for PowerPoint.
   *     tags: [Test]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [text, format]
   *             properties:
   *               text:
   *                 type: string
   *                 description: The raw text to chunk
   *               format:
   *                 type: string
   *                 description: Source document format, determines chunking strategy
   *                 enum: [pdf, docx, xlsx, pptx, csv]
   *               documentId:
   *                 type: string
   *                 description: Optional document ID to attach to chunk metadata
   *               maxSize:
   *                 type: number
   *                 description: Maximum chunk size in tokens
   *                 default: 512
   *               overlap:
   *                 type: number
   *                 description: Overlap between chunks in tokens
   *                 default: 50
   *     responses:
   *       200:
   *         description: Chunked text result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 format:
   *                   type: string
   *                 chunkTimeMs:
   *                   type: number
   *                 strategy:
   *                   type: string
   *                   enum: [recursive, table-aware, slide-based]
   *                 totalChunks:
   *                   type: number
   *                 totalContent:
   *                   type: number
   *                 avgChunkSize:
   *                   type: number
   *                 minChunkSize:
   *                   type: number
   *                 maxChunkSize:
   *                   type: number
   *                 chunks:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       index:
   *                         type: number
   *                       contentPreview:
   *                         type: string
   *                       length:
   *                         type: number
   *       400:
   *         description: Validation error (missing text/format, or invalid format)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: "#/components/schemas/Error"
   */
  app.post("/api/test/chunk-format-aware", handleFormatAwareChunkTest);

  
  app.post("/api/documents/upload", upload.single("file"), handleUploadDocument);
  app.post("/api/documents/:documentId/query", handleQueryDocument);
  app.get("/api/documents/:documentId", handleGetDocument);

  app.get("/api/agents", (req: Request, res: Response) => {
    res.json({
      agents: [
        {
          id: "supervisor",
          name: "Supervisor Agent",
          description: "Orchestrates other agents",
        },
        {
          id: "research-agent",
          name: "Research Agent",
          description: "Gathers web information",
        },
        {
          id: "document-agent",
          name: "Document Agent",
          description: "Analyzes documents",
        },
        {
          id: "writer-agent",
          name: "Writer Agent",
          description: "Generates content",
        },
      ],
    });
  });
}