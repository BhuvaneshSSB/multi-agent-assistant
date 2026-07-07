import { Request, Response, NextFunction } from "express";
import { parseDocument } from "../mastra/tools/document-parser";
import { ValidationError } from "../types/index";
import { chunkDocument, DEFAULT_CHUNKING_CONFIG } from "../mastra/tools/chunking";
import { extractAllMetadata } from "../mastra/tools/metadata-extractor";

export async function handleParseTest(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const uploadedFile = req.file;
    const format = req.body.format || uploadedFile?.originalname.split(".").pop();

    if (!uploadedFile) {
      throw new ValidationError("file is required (multipart upload)");
    }

    if (!format || !["pdf", "docx", "xlsx", "pptx", "csv"].includes(format)) {
      throw new ValidationError("format is required (pdf, docx, xlsx, pptx, or csv)");
    }

    const fileBuffer = uploadedFile.buffer;

    const startTime = Date.now();
    const text = await parseDocument(fileBuffer, format);
    const parseTime = Date.now() - startTime;

    res.status(200).json({
      success: true,
      format,
      parseTimeMs: parseTime,
      textLength: text.length,
      wordCount: text.split(/\s+/).length,
      preview: text.substring(0, 1000),
      fullText: text,
    });
  } catch (error) {
    console.error("[Test] Error:", error);
    next(error);
  }
}


export async function handleChunkTest(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { text, maxSize = 512, overlap = 50 } = req.body;

    if (!text || typeof text !== "string") {
      throw new ValidationError("text is required");
    }

    const startTime = Date.now();
    const chunks = await chunkDocument(text, {
      maxSize,
      overlap,
      separators: DEFAULT_CHUNKING_CONFIG.separators,
    });
    const chunkTime = Date.now() - startTime;

    res.status(200).json({
      success: true,
      chunkTimeMs: chunkTime,
      totalChunks: chunks.length,
      avgChunkSize: Math.round(
        chunks.reduce((sum, c) => sum + c.content.length, 0) / chunks.length
      ),
      chunks: chunks.map((c) => ({
        index: c.index,
        length: c.content.length,
        preview: c.content.substring(0, 100),
      })),
      fullChunks: chunks,
    });
  } catch (error) {
    console.error("[Test] Error:", error);
    next(error);
  }
}

export async function handleMetadataTest(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { text, filename, fileType = "pdf", documentId } = req.body;

    if (!text || !filename || !fileType) {
      throw new ValidationError("text, filename, and fileType are required");
    }

    const result = extractAllMetadata(text, documentId || "doc-123", filename, fileType);

    res.status(200).json({
      success: true,
      documentMetadata: result.documentMetadata,
      pageBreaks: result.pageBreaks.length,
      hierarchy: result.hierarchy,
    });
  } catch (error) {
    next(error);
  }
}

import { chunkDocumentFormatAware, getChunkStats } from "../mastra/tools/chunking";
import { DocumentFormat } from "../types/index";

export async function handleFormatAwareChunkTest(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { text, format, documentId, maxSize = 512, overlap = 50 } = req.body;

    if (!text || !format) {
      throw new ValidationError("text and format are required");
    }

    const validFormats = ["pdf", "docx", "xlsx", "pptx", "csv"];
    if (!validFormats.includes(format)) {
      throw new ValidationError(`format must be one of: ${validFormats.join(", ")}`);
    }

    const startTime = Date.now();
    const chunks = await chunkDocumentFormatAware(text, format as DocumentFormat, documentId, {
      maxSize,
      overlap,
      separators: ["\n\n", "\n", " "],
    });
    const chunkTime = Date.now() - startTime;

    const stats = getChunkStats(chunks);

    res.status(200).json({
      success: true,
      format,
      chunkTimeMs: chunkTime,
      strategy:
        format === "pdf" || format === "docx"
          ? "recursive"
          : format === "xlsx"
            ? "table-aware"
            : "slide-based",
      ...stats,
      chunks: chunks.map((c) => ({
        index: c.index,
        contentPreview: c.content.substring(0, 100),
        length: c.content.length,
      })),
    });
  } catch (error) {
    console.error("[Test] Error:", error);
    next(error);
  }
}