import { logger } from "../../utils/logger";
import { DocumentFormat } from "../../types/index";

// ============================================================================
// METADATA INTERFACES
// ============================================================================

export interface DocumentMetadata {
  documentId: string;
  filename: string;
  fileType: DocumentFormat;
  totalPages?: number;
  totalChunks?: number;
  wordCount?: number;
  title?: string;
  author?: string;
  uploadedAt: Date;
  userId: string;
  conversationId: string;
}

export interface ChunkMetadata {
  documentId: string;
  chunkIndex: number;
  pageNumber?: number;
  sectionTitle?: string;
  sectionLevel?: number; // 1, 2, 3 for h1, h2, h3
  hierarchy?: string[]; // ["Section 1", "Subsection 1.2"]
  sourceOffset: number;
  sourceEndOffset?: number;
  contentType?: "heading" | "paragraph" | "table" | "list" | "code" | "other";
  isNewPage?: boolean;
  confidence?: number; // Extraction confidence 0-1
}

// ============================================================================
// PDF METADATA EXTRACTOR
// ============================================================================

export function extractPDFMetadata(
  text: string,
  documentId: string,
  filename: string,
  pages?: number
): DocumentMetadata {
  try {
    const lines = text.split("\n");
    let title = filename.replace(/\.pdf$/i, "");
    let author = undefined;

    // Extract title and author from first lines (common in PDFs)
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const line = lines[i].trim();
      if (line.length > 0 && !line.startsWith("Page")) {
        if (!title || title === filename) {
          title = line;
        }
        if (line.toLowerCase().includes("author") || line.toLowerCase().includes("by")) {
          author = line;
        }
      }
    }

    const metadata: DocumentMetadata = {
      documentId,
      filename,
      fileType: "pdf",
      title,
      author,
      totalPages: pages,
      wordCount: text.split(/\s+/).length,
      uploadedAt: new Date(),
      userId: "", // Will be set by caller
      conversationId: "", // Will be set by caller
    };

    logger.info("[Metadata] PDF metadata extracted", { title, pages });
    return metadata;
  } catch (error) {
    logger.error("[Metadata] Error extracting PDF metadata", { error });
    throw error;
  }
}

// ============================================================================
// WORD DOCUMENT METADATA EXTRACTOR
// ============================================================================

export function extractWordMetadata(
  text: string,
  documentId: string,
  filename: string
): DocumentMetadata {
  try {
    const title = filename.replace(/\.docx?$/i, "");
    const wordCount = text.split(/\s+/).length;

    const authorMatch = text.match(/author:\s*(.+?)(?:\n|$)/i);
    const author = authorMatch ? authorMatch[1].trim() : undefined;

    const metadata: DocumentMetadata = {
      documentId,
      filename,
      fileType: "docx",
      title,
      author,
      wordCount,
      uploadedAt: new Date(),
      userId: "",
      conversationId: "",
    };

    logger.info("[Metadata] Word metadata extracted", { title, wordCount });
    return metadata;
  } catch (error) {
    logger.error("[Metadata] Error extracting Word metadata", { error });
    throw error;
  }
}

// ============================================================================
// EXCEL METADATA EXTRACTOR
// ============================================================================

export function extractExcelMetadata(
  text: string,
  documentId: string,
  filename: string,
  sheetNames?: string[]
): DocumentMetadata {
  try {
    const title = filename.replace(/\.xlsx?$/i, "");
    const wordCount = text.split(/\s+/).length;

    const sheetInfo = sheetNames ? ` (Sheets: ${sheetNames.join(", ")})` : "";

    const metadata: DocumentMetadata = {
      documentId,
      filename,
      fileType: "xlsx",
      title: title + sheetInfo,
      wordCount,
      uploadedAt: new Date(),
      userId: "",
      conversationId: "",
    };

    logger.info("[Metadata] Excel metadata extracted", {
      title,
      sheets: sheetNames?.length || 0,
    });
    return metadata;
  } catch (error) {
    logger.error("[Metadata] Error extracting Excel metadata", { error });
    throw error;
  }
}

// ============================================================================
// CSV METADATA EXTRACTOR
// ============================================================================

export function extractCSVMetadata(
  text: string,
  documentId: string,
  filename: string
): DocumentMetadata {
  try {
    const title = filename.replace(/\.csv$/i, "");
    const wordCount = text.split(/\s+/).length;

    const metadata: DocumentMetadata = {
      documentId,
      filename,
      fileType: "csv",
      title,
      wordCount,
      uploadedAt: new Date(),
      userId: "",
      conversationId: "",
    };

    logger.info("[Metadata] CSV metadata extracted", { title });
    return metadata;
  } catch (error) {
    logger.error("[Metadata] Error extracting CSV metadata", { error });
    throw error;
  }
}

// ============================================================================
// POWERPOINT METADATA EXTRACTOR
// ============================================================================

export function extractPowerPointMetadata(
  text: string,
  documentId: string,
  filename: string,
  slideCount?: number
): DocumentMetadata {
  try {
    const title = filename.replace(/\.pptx?$/i, "");
    const wordCount = text.split(/\s+/).length;

    const metadata: DocumentMetadata = {
      documentId,
      filename,
      fileType: "pptx",
      title,
      totalPages: slideCount, // Slides = pages
      wordCount,
      uploadedAt: new Date(),
      userId: "",
      conversationId: "",
    };

    logger.info("[Metadata] PowerPoint metadata extracted", {
      title,
      slides: slideCount,
    });
    return metadata;
  } catch (error) {
    logger.error("[Metadata] Error extracting PowerPoint metadata", { error });
    throw error;
  }
}

// ============================================================================
// CHUNK METADATA EXTRACTOR
// ============================================================================

export function extractChunkMetadata(
  chunkContent: string,
  chunkIndex: number,
  documentId: string,
  sourceOffset: number,
  documentMetadata?: {
    currentPageNumber?: number;
    lastSectionTitle?: string;
    hierarchy?: string[];
  }
): ChunkMetadata {
  try {
    // Detect content type
    let contentType: ChunkMetadata["contentType"] = "paragraph";

    if (/^#+\s/m.test(chunkContent)) {
      contentType = "heading";
    } else if (/^\|.+\|.+\|/m.test(chunkContent)) {
      contentType = "table";
    } else if (/^[-*•]\s/m.test(chunkContent)) {
      contentType = "list";
    } else if (/```|^    /m.test(chunkContent)) {
      contentType = "code";
    }

    // Extract section title if content starts with heading
    let sectionTitle = documentMetadata?.lastSectionTitle;
    let sectionLevel = undefined;

    const headingMatch = chunkContent.match(/^(#+)\s+(.+?)$/m);
    if (headingMatch) {
      sectionLevel = headingMatch[1].length; // # = 1, ## = 2, etc
      sectionTitle = headingMatch[2].trim();
    }

    // Build hierarchy
    const hierarchy = documentMetadata?.hierarchy || [];
    if (sectionTitle && !hierarchy.includes(sectionTitle)) {
      hierarchy.push(sectionTitle);
    }

    const metadata: ChunkMetadata = {
      documentId,
      chunkIndex,
      pageNumber: documentMetadata?.currentPageNumber,
      sectionTitle,
      sectionLevel,
      hierarchy: hierarchy.length > 0 ? hierarchy : undefined,
      sourceOffset,
      sourceEndOffset: sourceOffset + chunkContent.length,
      contentType,
      isNewPage: sourceOffset === 0, // First chunk starts on new page
      confidence: 0.95, // High confidence extraction
    };

    return metadata;
  } catch (error) {
    logger.error("[Metadata] Error extracting chunk metadata", { error });
    throw error;
  }
}

// ============================================================================
// INTELLIGENT PAGE BREAK DETECTOR (For PDFs)
// ============================================================================

export function detectPageBreaks(text: string): number[] {
  try {
    const pageBreakPatterns = [
      /\n\s{0,10}[-─]{20,}\s*\n/, // Dashed line separator
      /\n\s*Page\s+\d+\s*\n/gi, // "Page 1" marker
      /\f/g, // Form feed character
    ];

    const positions: number[] = [];

    for (const pattern of pageBreakPatterns) {
      let match;
      if (pattern.global) {
        while ((match = pattern.exec(text)) !== null) {
          positions.push(match.index);
        }
      } else {
        match = pattern.exec(text);
        if (match) positions.push(match.index);
      }
    }

    // Sort and deduplicate
    return [...new Set(positions)].sort((a, b) => a - b);
  } catch (error) {
    logger.warn("[Metadata] Error detecting page breaks", { error });
    return [];
  }
}

// ============================================================================
// SECTION HIERARCHY DETECTOR
// ============================================================================

export function detectSectionHierarchy(text: string): string[] {
  try {
    const lines = text.split("\n");
    const hierarchy: string[] = [];

    // Look for heading patterns (markdown-style)
    for (const line of lines) {
      const headingMatch = line.match(/^(#+)\s+(.+?)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = headingMatch[2].trim();

        // Truncate hierarchy to current level
        hierarchy.length = level - 1;
        hierarchy.push(title);
      }
    }

    return hierarchy;
  } catch (error) {
    logger.warn("[Metadata] Error detecting section hierarchy", { error });
    return [];
  }
}

// ============================================================================
// UNIFIED METADATA EXTRACTOR
// ============================================================================

export function extractAllMetadata(
  text: string,
  documentId: string,
  filename: string,
  fileType: DocumentFormat,
  additionalInfo?: {
    pages?: number;
    slides?: number;
    sheets?: string[];
    userId?: string;
    conversationId?: string;
  }
): {
  documentMetadata: DocumentMetadata;
  pageBreaks: number[];
  hierarchy: string[];
} {
  try {
    logger.info("[Metadata] Extracting all metadata", { filename, fileType });

    let documentMetadata: DocumentMetadata;

    switch (fileType) {
      case "pdf":
        documentMetadata = extractPDFMetadata(text, documentId, filename, additionalInfo?.pages);
        break;
      case "docx":
        documentMetadata = extractWordMetadata(text, documentId, filename);
        break;
      case "xlsx":
        documentMetadata = extractExcelMetadata(text, documentId, filename, additionalInfo?.sheets);
        break;
      case "csv":
        documentMetadata = extractCSVMetadata(text, documentId, filename);
        break;
      case "pptx":
        documentMetadata = extractPowerPointMetadata(
          text,
          documentId,
          filename,
          additionalInfo?.slides
        );
        break;
      default:
        throw new Error(`Unsupported file type: ${fileType}`);
    }

    if (additionalInfo?.userId) {
      documentMetadata.userId = additionalInfo.userId;
    }
    if (additionalInfo?.conversationId) {
      documentMetadata.conversationId = additionalInfo.conversationId;
    }

    const pageBreaks = detectPageBreaks(text);
    const hierarchy = detectSectionHierarchy(text);

    logger.info("[Metadata] All metadata extracted successfully", {
      pages: pageBreaks.length,
      sections: hierarchy.length,
    });

    return {
      documentMetadata,
      pageBreaks,
      hierarchy,
    };
  } catch (error) {
    logger.error("[Metadata] Error extracting all metadata", { error });
    throw error;
  }
}

// ============================================================================
// MASTRA TOOL - EXTRACT METADATA
// ============================================================================

export const metadataExtractorTool = {
  id: "extract-metadata",
  description:
    "Extract comprehensive metadata from documents including page breaks, sections, and content type analysis",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: {
        type: "string",
        description: "The extracted document text",
      },
      filename: {
        type: "string",
        description: "Original filename",
      },
      fileType: {
        type: "string",
        enum: ["pdf", "docx", "xlsx", "pptx", "csv"],
        description: "Document format",
      },
      documentId: {
        type: "string",
        description: "Unique document ID",
      },
      userId: {
        type: "string",
        description: "User ID who uploaded document",
      },
      conversationId: {
        type: "string",
        description: "Conversation ID",
      },
    },
    required: ["text", "filename", "fileType", "documentId"],
  },
  execute: async (input: {
    text: string;
    filename: string;
    fileType: DocumentFormat;
    documentId: string;
    userId?: string;
    conversationId?: string;
  }) => {
    try {
      const result = extractAllMetadata(input.text, input.documentId, input.filename, input.fileType, {
        userId: input.userId,
        conversationId: input.conversationId,
      });

      return {
        success: true,
        documentMetadata: result.documentMetadata,
        pageBreakCount: result.pageBreaks.length,
        sectionCount: result.hierarchy.length,
        sections: result.hierarchy.slice(0, 10), // First 10 sections
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Metadata extraction failed",
      };
    }
  },
};