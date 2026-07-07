import { MDocument } from "@mastra/rag";
import { getEncoding } from "js-tiktoken";
import { logger } from "../../utils/logger";
import { DocumentFormat } from "../../types/index";
import type { ImageCaption } from "./image-captioner";

// cl100k_base matches OpenAI's text-embedding-3-small tokenizer. Loaded once
// at module scope since building the encoding table is expensive.
const tokenEncoding = getEncoding("cl100k_base");

// `maxSize`/`overlap` in ChunkingConfig are documented as token counts, but
// @mastra/rag's chunker defaults to counting plain characters unless given an
// explicit lengthFunction — without this, "512 tokens" was actually being
// enforced as 512 characters (~128 tokens), producing ~4x more chunks (and
// downstream embeddings/DB writes) than intended.
function countTokens(text: string): number {
  return tokenEncoding.encode(text).length;
}

// ============================================================================
// CHUNKING CONFIGURATION
// ============================================================================

export interface ChunkingConfig {
  maxSize: number; // tokens
  overlap: number; // tokens
  separators: string[];
  // Soft target window (characters) for slide-based chunking. Chunks are
  // packed up toward `max` rather than cut at a fixed size, so a short line
  // left over after a cut gets merged into a neighboring chunk instead of
  // becoming an orphan fragment on its own.
  slideChunkWindow?: { min: number; max: number };
  // Same idea as `slideChunkWindow`, applied to table-aware (Excel) chunking:
  // rows are packed up toward `max` (bounded by `maxRowsPerChunk`), and an
  // undersized trailing row-group is merged into its predecessor.
  tableChunkWindow?: { min: number; max: number };
}

// Default configuration optimized for RAG
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxSize: 512, // ~1 page of content
  overlap: 50, // Keep context between chunks
  separators: ["\n\n", "\n", " "], // Paragraph → Line → Word
  slideChunkWindow: { min: 800, max: 1200 },
  tableChunkWindow: { min: 800, max: 1200 },
};

const DEFAULT_CHUNK_WINDOW = { min: 800, max: 1200 };

// ============================================================================
// CHUNK INTERFACE
// ============================================================================

export interface Chunk {
  id: string;
  index: number;
  content: string;
  metadata: {
    documentId?: string;
    pageNumber?: number;
    // Set instead of pageNumber when a chunk's content spans more than one
    // PDF page (e.g. a whole short document collapsing into a single chunk)
    // — an honest "pages X-Y" citation instead of a fabricated single page.
    pageRangeStart?: number;
    pageRangeEnd?: number;
    sectionTitle?: string;
    sourceOffset: number;
    contentType?: "text" | "image_caption";
  };
}

// ============================================================================
// IMAGE CAPTION CHUNKS (from extractAndCaptionImages, PDF only)
// ============================================================================

export function imageCaptionsToChunks(captions: ImageCaption[], startIndex: number): Chunk[] {
  return captions.map((c, offset) => ({
    id: `chunk-image-${startIndex + offset}`,
    index: startIndex + offset,
    content: `[Image, page ${c.pageNumber}] ${c.caption}`,
    metadata: {
      pageNumber: c.pageNumber,
      sourceOffset: 0,
      contentType: "image_caption" as const,
    },
  }));
}

// ============================================================================
// STRATEGY 1: RECURSIVE CHUNKING (PDF, Word)
// ============================================================================

async function recursiveChunk(
  text: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): Promise<Chunk[]> {
  try {
    logger.info("[Chunking] Using recursive strategy");

    const doc = MDocument.fromText(text, { metadata: { format: "text" } });

    const chunkedDocs = await doc.chunk({
      strategy: "recursive",
      maxSize: config.maxSize,
      overlap: config.overlap,
      separators: config.separators,
      lengthFunction: countTokens,
    });

    const chunks: Chunk[] = chunkedDocs.map((mastraChunk, index) => ({
      id: `chunk-${index}`,
      index,
      content: mastraChunk.text,
      metadata: {
        sourceOffset: 0,
      },
    }));

    logger.info("[Chunking] Recursive chunking completed", {
      totalChunks: chunks.length,
    });

    return chunks;
  } catch (error) {
    logger.error("[Chunking] Recursive chunking failed", { error });
    throw error;
  }
}

// ============================================================================
// STRATEGY 1B: PAGE-AWARE RECURSIVE CHUNKING (PDF)
// ============================================================================
//
// parsePDF (document-parser.ts) precedes each page's text with a
// `[[[PDF_PAGE:n]]]` marker, the same convention already used for `## Slide
// N` (PPTX) and `## Sheet:` (XLSX). Chunk boundaries are still decided by the
// same token-aware recursive splitter used for DOCX — a PDF page isn't a
// natural semantic unit the way a slide is, so we don't want to force a
// chunk break at every page boundary — but after chunking, each chunk's real
// character range in the marker-stripped text is used to look up which
// page(s) it actually came from, so a chunk spanning multiple pages gets an
// honest `pageRangeStart`/`pageRangeEnd` instead of a silently absent
// `pageNumber` that the model would otherwise invent a value for.

const PDF_PAGE_MARKER = /\[\[\[PDF_PAGE:(\d+)\]\]\]/g;

function extractPdfPageOffsets(text: string): {
  cleanText: string;
  pageRanges: { page: number; start: number; end: number }[];
} {
  const pageRanges: { page: number; start: number; end: number }[] = [];
  let cleanText = "";
  let lastIndex = 0;
  const regex = new RegExp(PDF_PAGE_MARKER.source, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    cleanText += text.slice(lastIndex, match.index);
    if (pageRanges.length > 0) {
      pageRanges[pageRanges.length - 1].end = cleanText.length;
    }
    pageRanges.push({ page: parseInt(match[1], 10), start: cleanText.length, end: cleanText.length });
    lastIndex = match.index + match[0].length;
  }
  cleanText += text.slice(lastIndex);
  if (pageRanges.length > 0) {
    pageRanges[pageRanges.length - 1].end = cleanText.length;
  }

  return { cleanText: cleanText.trim(), pageRanges };
}

// MDocument's recursive splitter normalizes whitespace when it rejoins split
// segments into chunk text (consecutive blank lines collapse to one), so a
// chunk's `.text` is not always an exact substring of the pre-chunk text —
// an exact indexOf lookup silently fails and every chunk loses page
// attribution. Collapsing both sides to single-space-separated text before
// searching, then mapping the match position back through `toOriginal`,
// finds the real offset regardless of that normalization.
function collapseWhitespace(s: string): { collapsed: string; toOriginal: number[] } {
  let collapsed = "";
  const toOriginal: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (!inWhitespace) {
        collapsed += " ";
        toOriginal.push(i);
        inWhitespace = true;
      }
    } else {
      collapsed += ch;
      toOriginal.push(i);
      inWhitespace = false;
    }
  }
  return { collapsed, toOriginal };
}

async function pdfAwareChunk(
  text: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): Promise<Chunk[]> {
  try {
    logger.info("[Chunking] Using page-aware recursive strategy for PDF");

    const { cleanText, pageRanges } = extractPdfPageOffsets(text);

    // No page markers found (e.g. raw text handed directly to the
    // /api/test/chunk-document diagnostic endpoint, not real parsePDF
    // output) — fall back to plain recursive chunking, same as before.
    if (pageRanges.length === 0) {
      return recursiveChunk(text, config);
    }

    const doc = MDocument.fromText(cleanText, { metadata: { format: "text" } });
    const chunkedDocs = await doc.chunk({
      strategy: "recursive",
      maxSize: config.maxSize,
      overlap: config.overlap,
      separators: config.separators,
      lengthFunction: countTokens,
    });

    const { collapsed: collapsedClean, toOriginal } = collapseWhitespace(cleanText);

    let searchFrom = 0; // in collapsed-text coordinates
    const chunks: Chunk[] = chunkedDocs.map((mastraChunk, index) => {
      const content = mastraChunk.text;
      const { collapsed: collapsedChunk } = collapseWhitespace(content);

      let collapsedStart = collapsedClean.indexOf(collapsedChunk, searchFrom);
      if (collapsedStart === -1) {
        // Overlap can make a chunk start slightly before the previous
        // chunk's match position — retry a full-text search rather than
        // lose page attribution entirely for this one chunk.
        collapsedStart = collapsedClean.indexOf(collapsedChunk);
      }

      let start = -1;
      let end = -1;
      if (collapsedStart !== -1) {
        start = toOriginal[collapsedStart] ?? 0;
        const collapsedEnd = collapsedStart + collapsedChunk.length;
        end = collapsedEnd < toOriginal.length ? toOriginal[collapsedEnd] : cleanText.length;
        searchFrom = collapsedStart;
      }

      const overlappingPages =
        start === -1 ? [] : pageRanges.filter((p) => p.start < end && p.end > start).map((p) => p.page);

      const pageNumber = overlappingPages.length === 1 ? overlappingPages[0] : undefined;
      const pageRangeStart = overlappingPages.length > 1 ? Math.min(...overlappingPages) : undefined;
      const pageRangeEnd = overlappingPages.length > 1 ? Math.max(...overlappingPages) : undefined;

      return {
        id: `chunk-${index}`,
        index,
        content,
        metadata: {
          sourceOffset: start === -1 ? 0 : start,
          ...(pageNumber !== undefined ? { pageNumber } : {}),
          ...(pageRangeStart !== undefined ? { pageRangeStart, pageRangeEnd } : {}),
        },
      };
    });

    logger.info("[Chunking] Page-aware PDF chunking completed", {
      totalChunks: chunks.length,
      pagesDetected: pageRanges.length,
    });

    return chunks;
  } catch (error) {
    logger.error("[Chunking] Page-aware PDF chunking failed", { error });
    throw error;
  }
}

// ============================================================================
// STRATEGY 2: TABLE-AWARE CHUNKING (Excel)
// ============================================================================

async function tableAwareChunk(
  text: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): Promise<Chunk[]> {
  try {
    logger.info("[Chunking] Using table-aware strategy for Excel");

    const chunks: Chunk[] = [];
    let chunkIndex = 0;
    const { min: windowMin, max: windowMax } =
      config.tableChunkWindow ?? DEFAULT_CHUNK_WINDOW;
    const maxRowsPerChunk = 50; // Keep ~50 rows per chunk

    // Split by sheet markers (## Sheet: name)
    const sheetSections = text.split(/^##\s+Sheet:\s+/m);

    for (const section of sheetSections) {
      if (!section.trim()) continue;

      const lines = section.split("\n");
      const sheetName = lines[0]?.trim() ?? "";
      const headerLine = lines.find((l) => l.includes("Columns:")) ?? "";
      const rowLines = lines.filter((l) => /^Row\s+\d+:/.test(l));

      if (rowLines.length === 0) continue;

      // Group rows up to the row-count/size limits. The size check runs
      // before a row is added (not after), so one exceptionally wide row
      // can't silently blow an existing group past the window — it just
      // starts its own group instead.
      const rowGroups: string[][] = [];
      let current: string[] = [];
      let currentSize = headerLine.length + 1;

      for (const row of rowLines) {
        const projected = currentSize + row.length + 1;
        if (current.length > 0 && (current.length >= maxRowsPerChunk || projected > windowMax)) {
          rowGroups.push(current);
          current = [];
          currentSize = headerLine.length + 1;
        }
        current.push(row);
        currentSize += row.length + 1;
      }
      if (current.length > 0) rowGroups.push(current);

      // Merge an undersized trailing group into its predecessor when it
      // still fits, so a sheet whose row count doesn't divide evenly never
      // ends up with a near-empty final chunk.
      const bodySize = (rows: string[]) =>
        headerLine.length + 1 + rows.reduce((sum, r) => sum + r.length + 1, 0);

      const mergedGroups: string[][] = [];
      for (const group of rowGroups) {
        const prev = mergedGroups[mergedGroups.length - 1];
        if (
          prev &&
          bodySize(group) < windowMin &&
          prev.length + group.length <= maxRowsPerChunk &&
          bodySize([...prev, ...group]) <= windowMax
        ) {
          mergedGroups[mergedGroups.length - 1] = [...prev, ...group];
        } else {
          mergedGroups.push(group);
        }
      }

      mergedGroups.forEach((group, partIndex) => {
        const lead = partIndex === 0 && sheetName ? `${sheetName}\n` : "";
        const content = `${lead}${headerLine}\n${group.join("\n")}`.trim();
        chunks.push({
          id: `chunk-excel-${chunkIndex}`,
          index: chunkIndex,
          content,
          metadata: {
            sourceOffset: 0,
          },
        });
        chunkIndex++;
      });
    }

    logger.info("[Chunking] Table-aware chunking completed", {
      totalChunks: chunks.length,
      strategy: "table-aware",
    });

    return chunks;
  } catch (error) {
    logger.error("[Chunking] Table-aware chunking failed", { error });
    throw error;
  }
}

// ============================================================================
// STRATEGY 3: SLIDE-BASED CHUNKING (PowerPoint)
// ============================================================================

/**
 * Recursively splits `text` on `separators` (tried in order) so that every
 * returned piece is at most `maxSize` characters. Falls back to a hard slice
 * once separators run out, so the guarantee holds even for one giant word.
 */
function splitTextToSize(text: string, separators: string[], maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const [separator, ...rest] = separators;
  if (!separator) {
    const pieces: string[] = [];
    for (let i = 0; i < text.length; i += maxSize) {
      pieces.push(text.slice(i, i + maxSize));
    }
    return pieces;
  }

  const parts = text.split(separator).filter((p) => p.length > 0);
  const pieces: string[] = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? `${current}${separator}${part}` : part;
    if (candidate.length <= maxSize) {
      current = candidate;
      continue;
    }

    if (current) pieces.push(current);

    if (part.length > maxSize) {
      pieces.push(...splitTextToSize(part, rest, maxSize));
      current = "";
    } else {
      current = part;
    }
  }
  if (current) pieces.push(current);

  return pieces;
}

async function slideBasedChunk(
  text: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): Promise<Chunk[]> {
  try {
    logger.info("[Chunking] Using slide-based strategy for PowerPoint");

    const chunks: Chunk[] = [];
    const { min: windowMin, max: windowMax } =
      config.slideChunkWindow ?? DEFAULT_CHUNK_WINDOW;

    // Split by slide markers (## Slide N)
    const slidePattern = /^##\s+Slide\s+(\d+)/m;
    const slideSections = text.split(slidePattern).slice(1); // Skip first empty split

    let chunkIndex = 0;
    for (let i = 0; i < slideSections.length; i += 2) {
      const slideNumber = slideSections[i];
      const slideContent = slideSections[i + 1] || "";

      if (!slideContent.trim()) continue;

      // Keep each slide as cohesive unit, or split if too large.
      // Strip the trailing "---" divider left over from the slide separator.
      const content = slideContent.replace(/\n?-{3,}\s*$/, "").trim();
      if (!content) continue;

      const primaryHeader = `Slide ${slideNumber}:\n`;
      const continuedHeader = `Slide ${slideNumber} (continued):\n`;

      if (primaryHeader.length + content.length <= windowMax) {
        // Slide fits in one chunk
        chunks.push({
          id: `chunk-slide-${slideNumber}`,
          index: chunkIndex,
          content: `${primaryHeader}${content}`,
          metadata: {
            pageNumber: parseInt(slideNumber),
            sourceOffset: 0,
          },
        });
        chunkIndex++;
        continue;
      }

      // Break the slide's content into pieces that each fit within the
      // window's upper bound (accounting for the header), greedily pack
      // those pieces up toward windowMax, then merge any chunk that fell
      // short of windowMin into a neighbor so a short trailing line never
      // ends up as an orphan chunk by itself.
      const atoms = splitTextToSize(content, config.separators, windowMax - continuedHeader.length);

      const bodies: string[] = [];
      let current = "";
      for (const atom of atoms) {
        const candidate = current ? `${current}\n\n${atom}` : atom;
        if (candidate.length <= windowMax) {
          current = candidate;
        } else {
          if (current) bodies.push(current);
          current = atom;
        }
      }
      if (current) bodies.push(current);

      const mergedBodies: string[] = [];
      for (const body of bodies) {
        const prev = mergedBodies[mergedBodies.length - 1];
        if (prev && body.length < windowMin && prev.length + 2 + body.length <= windowMax) {
          mergedBodies[mergedBodies.length - 1] = `${prev}\n\n${body}`;
        } else {
          mergedBodies.push(body);
        }
      }

      mergedBodies.forEach((body, partIndex) => {
        const header = partIndex === 0 ? primaryHeader : continuedHeader;
        chunks.push({
          id: `chunk-slide-${slideNumber}-${chunkIndex}`,
          index: chunkIndex,
          content: `${header}${body}`,
          metadata: {
            pageNumber: parseInt(slideNumber),
            sourceOffset: 0,
          },
        });
        chunkIndex++;
      });
    }

    logger.info("[Chunking] Slide-based chunking completed", {
      totalChunks: chunks.length,
      strategy: "slide-based",
    });

    return chunks;
  } catch (error) {
    logger.error("[Chunking] Slide-based chunking failed", { error });
    throw error;
  }
}

// ============================================================================
// FORMAT-AWARE CHUNKING (MAIN FUNCTION)
// ============================================================================

export async function chunkDocumentFormatAware(
  text: string,
  format: DocumentFormat,
  documentId?: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG,
  imageCaptions: ImageCaption[] = []
): Promise<Chunk[]> {
  try {
    logger.info("[Chunking] Starting format-aware chunking", {
      format,
      documentId,
    });

    let chunks: Chunk[];

    switch (format) {
      case "pdf":
        chunks = await pdfAwareChunk(text, config);
        break;

      case "docx":
        chunks = await recursiveChunk(text, config);
        break;

      case "xlsx":
        chunks = await tableAwareChunk(text, config);
        break;

      case "csv":
        chunks = await tableAwareChunk(text, config);
        break;

      case "pptx":
        chunks = await slideBasedChunk(text, config);
        break;

      default:
        logger.warn(`[Chunking] Unknown format: ${format}, using recursive fallback`);
        chunks = await recursiveChunk(text, config);
    }

    // Append image-caption chunks (PDF only, populated via extractAndCaptionImages)
    // after the text chunks, so retrieval treats image content as ordinary chunks.
    if (imageCaptions.length > 0) {
      chunks = [...chunks, ...imageCaptionsToChunks(imageCaptions, chunks.length)];
    }

    // Add documentId to all chunks if provided
    if (documentId) {
      chunks = chunks.map((chunk) => ({
        ...chunk,
        metadata: {
          ...chunk.metadata,
          documentId,
        },
      }));
    }

    logger.info("[Chunking] Format-aware chunking completed", {
      format,
      totalChunks: chunks.length,
      avgChunkSize: Math.round(
        chunks.reduce((sum, c) => sum + c.content.length, 0) / chunks.length
      ),
    });

    return chunks;
  } catch (error) {
    logger.error("[Chunking] Format-aware chunking failed", { error });
    throw error;
  }
}

// ============================================================================
// BACKWARD COMPATIBILITY
// ============================================================================

export async function chunkDocument(
  text: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): Promise<Chunk[]> {
  // Default to recursive for backward compatibility
  return recursiveChunk(text, config);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export function getChunksForEmbedding(chunks: Chunk[]): string[] {
  return chunks.map((chunk) => chunk.content);
}

export function getChunksByDocumentId(chunks: Chunk[], documentId: string): Chunk[] {
  return chunks.filter((chunk) => chunk.metadata.documentId === documentId);
}

export function getChunkStats(chunks: Chunk[]) {
  return {
    totalChunks: chunks.length,
    totalContent: chunks.reduce((sum, c) => sum + c.content.length, 0),
    avgChunkSize: Math.round(
      chunks.reduce((sum, c) => sum + c.content.length, 0) / chunks.length
    ),
    minChunkSize: Math.min(...chunks.map((c) => c.content.length)),
    maxChunkSize: Math.max(...chunks.map((c) => c.content.length)),
  };
}

// ============================================================================
// MASTRA TOOL - FORMAT-AWARE CHUNKING
// ============================================================================

export const formatAwareChunkingTool = {
  id: "chunk-document-format-aware",
  description:
    "Intelligently chunk documents based on format. Uses recursive for PDF/Word, table-aware for Excel, slide-based for PowerPoint.",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: {
        type: "string",
        description: "The extracted document text to chunk",
      },
      format: {
        type: "string",
        enum: ["pdf", "docx", "xlsx", "pptx", "csv"],
        description: "Document format",
      },
      documentId: {
        type: "string",
        description: "Optional document ID for metadata",
      },
      maxSize: {
        type: "number",
        description: "Maximum chunk size in tokens (default: 512)",
        default: 512,
      },
      overlap: {
        type: "number",
        description: "Overlap between chunks in tokens (default: 50)",
        default: 50,
      },
    },
    required: ["text", "format"],
  },
  execute: async (input: {
    text: string;
    format: DocumentFormat;
    documentId?: string;
    maxSize?: number;
    overlap?: number;
  }) => {
    try {
      const config: ChunkingConfig = {
        maxSize: input.maxSize || DEFAULT_CHUNKING_CONFIG.maxSize,
        overlap: input.overlap || DEFAULT_CHUNKING_CONFIG.overlap,
        separators: DEFAULT_CHUNKING_CONFIG.separators,
      };

      const chunks = await chunkDocumentFormatAware(
        input.text,
        input.format,
        input.documentId,
        config
      );

      const stats = getChunkStats(chunks);

      return {
        success: true,
        format: input.format,
        ...stats,
        chunks: chunks.map((c) => ({
          index: c.index,
          contentPreview: c.content.substring(0, 100),
          length: c.content.length,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Chunking failed",
      };
    }
  },
};