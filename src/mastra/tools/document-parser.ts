import { PDFParse } from "pdf-parse";
import * as mammoth from "mammoth";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { DocumentFormat } from "../../types/index";

// ============================================================================
// PDF PARSER
// ============================================================================

export async function parsePDF(buffer: Buffer): Promise<string> {
  try {
    console.log("[PDF Parser] Parsing PDF...");
    const parser = new PDFParse({ data: buffer });

    const info = await parser.getInfo();
    const textResult = await parser.getText();
    await parser.destroy();

    let text = "";

    // Add metadata
    if (info.info?.Title) {
      text += `Title: ${info.info.Title}\n`;
    }
    if (info.info?.Author) {
      text += `Author: ${info.info.Author}\n`;
    }
    if (info.info?.Subject) {
      text += `Subject: ${info.info.Subject}\n`;
    }

    text += `\nPages: ${textResult.total}\n\n`;
    text += "---\n\n";

    // Add page content
    text += textResult.text;

    console.log(`[PDF Parser] Extracted ${textResult.total} pages, ${textResult.text.length} characters`);
    return text;
  } catch (error) {
    throw new Error(`PDF parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================================
// WORD (.docx) PARSER
// ============================================================================

export async function parseWord(buffer: Buffer): Promise<string> {
  try {
    console.log("[Word Parser] Parsing Word document...");

    const result = await mammoth.extractRawText({ buffer });

    if (result.messages && result.messages.length > 0) {
      console.warn("[Word Parser] Warnings:", result.messages);
    }

    console.log(`[Word Parser] Extracted ${result.value.length} characters`);
    return result.value;
  } catch (error) {
    throw new Error(`Word parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatCellValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString().split("T")[0];
  }
  return value;
}

// ============================================================================
// EXCEL (.xlsx) PARSER
// ============================================================================

export async function parseExcel(buffer: Buffer): Promise<string> {
  try {
    console.log("[Excel Parser] Parsing Excel file...");

    // cellDates keeps date cells as real JS Date objects instead of raw
    // Excel serial numbers (e.g. 45599.229...), which formatRowValue below
    // then renders as a plain YYYY-MM-DD string.
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });

    let text = `Excel File: ${workbook.Props?.Title || "Untitled"}\n`;
    text += `Sheets: ${workbook.SheetNames.join(", ")}\n\n`;
    text += "---\n\n";

    // Parse each sheet
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      const sheetData = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet);

      text += `## Sheet: ${sheetName}\n\n`;

      // Add column headers
      if (sheetData.length > 0) {
        const headers = Object.keys(sheetData[0]);
        text += `Columns: ${headers.join(", ")}\n\n`;

        // Add rows as structured text
        for (let i = 0; i < Math.min(sheetData.length, 100); i++) {
          const row = sheetData[i];
          text += `Row ${i + 1}: `;
          text += Object.entries(row)
            .map(([key, value]) => `${key}: ${formatCellValue(value)}`)
            .join(" | ");
          text += "\n";
        }

        if (sheetData.length > 100) {
          text += `\n... and ${sheetData.length - 100} more rows\n`;
        }
      }

      text += "\n---\n\n";
    }

    console.log(`[Excel Parser] Extracted ${workbook.SheetNames.length} sheets`);
    return text;
  } catch (error) {
    throw new Error(`Excel parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================================
// CSV PARSER
// ============================================================================

export async function parseCSV(buffer: Buffer): Promise<string> {
  try {
    console.log("[CSV Parser] Parsing CSV file...");

    // XLSX.read auto-detects plain-delimited text and produces a single-sheet
    // workbook, so CSV reuses the same sheet_to_json path as parseExcel and
    // emits the same "## Sheet:" / "Columns:" markers tableAwareChunk expects.
    // raw:true disables SheetJS's date-sniffing heuristic, which otherwise
    // silently rewrites date-looking CSV strings (e.g. "2024-11-03") into
    // Excel serial-date numbers — CSV cells have no real type, so the
    // original text should pass through unchanged.
    const workbook = XLSX.read(buffer, { type: "buffer", raw: true });
    const sheetName = workbook.SheetNames[0] ?? "Sheet1";
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet);

    let text = `CSV File\n\n`;
    text += "---\n\n";
    text += `## Sheet: ${sheetName}\n\n`;

    if (rows.length > 0) {
      const headers = Object.keys(rows[0]);
      text += `Columns: ${headers.join(", ")}\n\n`;

      for (let i = 0; i < Math.min(rows.length, 100); i++) {
        const row = rows[i];
        text += `Row ${i + 1}: `;
        text += Object.entries(row)
          .map(([key, value]) => `${key}: ${value}`)
          .join(" | ");
        text += "\n";
      }

      if (rows.length > 100) {
        text += `\n... and ${rows.length - 100} more rows\n`;
      }
    }

    text += "\n---\n\n";

    console.log(`[CSV Parser] Extracted ${rows.length} rows`);
    return text;
  } catch (error) {
    throw new Error(`CSV parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================================
// POWERPOINT (.pptx) PARSER
// ============================================================================

export async function parsePowerPoint(buffer: Buffer): Promise<string> {
  try {
    console.log("[PowerPoint Parser] Parsing PowerPoint file...");

    // A .pptx file is a zip archive; slide text lives in ppt/slides/slideN.xml
    // as <a:t> text runs. Extract it directly rather than depending on a
    // full OOXML parser.
    const zip = await JSZip.loadAsync(buffer);

    const slideFiles = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const numA = parseInt(a.match(/slide(\d+)\.xml/)?.[1] ?? "0", 10);
        const numB = parseInt(b.match(/slide(\d+)\.xml/)?.[1] ?? "0", 10);
        return numA - numB;
      });

    let text = `PowerPoint Presentation\n`;
    text += `Slides: ${slideFiles.length}\n\n`;
    text += "---\n\n";

    for (let i = 0; i < slideFiles.length; i++) {
      const xml = await zip.files[slideFiles[i]].async("text");
      const lines = Array.from(xml.matchAll(/<a:t>([^<]*)<\/a:t>/g))
        .map((match) => match[1])
        .filter((line) => line.trim().length > 0);

      text += `## Slide ${i + 1}\n\n`;
      text += lines.join("\n");
      text += "\n\n---\n\n";
    }

    console.log(`[PowerPoint Parser] Extracted ${slideFiles.length} slides`);
    return text;
  } catch (error) {
    throw new Error(
      `PowerPoint parsing failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ============================================================================
// UNIFIED PARSER
// ============================================================================

export async function parseDocument(
  buffer: Buffer,
  format: DocumentFormat
): Promise<string> {
  console.log(`[Document Parser] Parsing ${format.toUpperCase()} document...`);

  switch (format) {
    case "pdf":
      return parsePDF(buffer);

    case "docx":
      return parseWord(buffer);

    case "xlsx":
      return parseExcel(buffer);

    case "pptx":
      return parsePowerPoint(buffer);

    case "csv":
      return parseCSV(buffer);

    default:
      throw new Error(`Unsupported document format: ${format}`);
  }
}

// ============================================================================
// CREATE MASTRA TOOL
// ============================================================================

export const documentParserTool = {
  id: "parse-document",
  description: "Parse a document and extract text (supports PDF, Word, Excel, PowerPoint, CSV)",
  inputSchema: {
    type: "object" as const,
    properties: {
      buffer: {
        type: "string",
        description: "Base64 encoded file content",
      },
      format: {
        type: "string",
        enum: ["pdf", "docx", "xlsx", "pptx", "csv"],
        description: "Document format",
      },
    },
    required: ["buffer", "format"],
  },
  execute: async (input: { buffer: string; format: DocumentFormat }) => {
    try {
      const fileBuffer = Buffer.from(input.buffer, "base64");
      const text = await parseDocument(fileBuffer, input.format);

      return {
        success: true,
        textLength: text.length,
        preview: text.substring(0, 500),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Parsing failed",
      };
    }
  },
};