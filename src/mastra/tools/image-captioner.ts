import { PDFParse } from "pdf-parse";
import { Agent } from "@mastra/core/agent";
import { logger } from "../../utils/logger";
import { openAiModelWithFallback } from "../../config/models";
import { withRetry } from "../../utils/retry";

// ============================================================================
// IMAGE CAPTIONING CONFIGURATION
// ============================================================================

export const IMAGE_CAPTION_CONFIG = {
  imageThreshold: 80, // pdf-parse default; skips tiny/decorative images (icons, tracking pixels)
  captionConcurrency: 3, // vision calls in flight at once (lower than embedding batches - heavier per-call cost)
  maxImagesPerDocument: 30, // hard cap so a scanned/image-heavy PDF can't trigger unbounded vision calls
  maxRetries: 2, // per-image retry budget before giving up on that image
  maxOutputTokens: 220, // bounds worst-case decode latency; enough for a dense-but-terse caption
  imageDetail: "auto" as const, // OpenAI-specific: "low" measurably blurred small in-diagram text/labels in testing - not worth the latency trade
  screenshotWidth: 1000, // width for the whole-page screenshot fallback below
};

export interface ImageCaption {
  pageNumber: number;
  caption: string;
}

// A capturable image is either a precisely-cropped embedded image (ideal) or,
// when pdf-parse/pdfjs can't resolve the underlying image object, a
// whole-page screenshot used as a fallback (see extractPageImages).
interface CaptionableImage {
  name: string;
  dataUrl: string;
}

// ============================================================================
// VISION CAPTIONING AGENT
// ============================================================================

const imageCaptionAgent = new Agent({
  id: "image-captioner",
  name: "Image Captioner",
  description:
    "Internal utility agent that captions images extracted from ingested documents for search retrieval purposes. Not part of the agent orchestration team - used only by the document ingestion pipeline.",
  ...openAiModelWithFallback("openai/gpt-4o-mini", "anthropic/claude-haiku-4-5-20251001"),
  instructions: `Caption the image for search retrieval in 2-4 sentences. Name every labeled component and the flow/relationship between them (e.g. "A connects to B"). Include any visible numbers or axis labels. Be terse and factual - no preamble, no speculation beyond what is visibly present.`,
});

// "low" image detail and a short output cap both trade a little descriptive
// depth for materially lower per-image latency (fewer input tiles to
// process, fewer output tokens to decode). Measured: the vision call is the
// dominant cost in ingestion (~9-11s of a ~11-14s total for a single image),
// not extraction/chunking/embedding.
async function captionImage(image: CaptionableImage): Promise<string> {
  const response = await imageCaptionAgent.generate(
    [
      {
        role: "user",
        content: [
          {
            type: "image",
            image: image.dataUrl,
            providerOptions: { openai: { imageDetail: IMAGE_CAPTION_CONFIG.imageDetail } },
          },
          { type: "text", text: "Caption this image for search retrieval." },
        ],
      },
    ],
    { modelSettings: { maxOutputTokens: IMAGE_CAPTION_CONFIG.maxOutputTokens } }
  );
  return response.text;
}

// ============================================================================
// PER-PAGE EXTRACTION (WITH WHOLE-PAGE SCREENSHOT FALLBACK)
// ============================================================================
//
// pdf-parse's getImage() has no per-image error isolation: if pdfjs can't
// resolve one embedded image object (a real gap for some image encodings -
// confirmed against real-world PDFs, e.g. "Image object img_p0_1 not found"),
// the call throws and aborts extraction for the ENTIRE document, silently
// dropping every other image too - even ones on other pages that would have
// resolved fine. Running getImage() per page isolates a failure to just that
// page, and falling back to a whole-page screenshot (a different pdfjs code
// path that doesn't hit the same resolution bug) means the page's visual
// content still gets captioned instead of being dropped entirely.
//
// `seenFailedNames` dedupes repeated failures of the exact same object name
// across pages - typically a shared header/logo/watermark resource
// referenced by many pages, not distinct content - so a document where that
// shared resource fails to resolve doesn't pay for a full-page screenshot on
// every single page just to recapture the same decorative image N times.
async function extractPageImages(
  parser: PDFParse,
  pageNumber: number,
  seenFailedNames: Set<string>,
  documentId?: string
): Promise<CaptionableImage[]> {
  try {
    const pageResult = await parser.getImage({
      partial: [pageNumber],
      imageThreshold: IMAGE_CAPTION_CONFIG.imageThreshold,
    });
    return pageResult.pages.flatMap((page) =>
      page.images.map((image) => ({ name: image.name, dataUrl: image.dataUrl }))
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedName = message.match(/Image object (\S+) not found/)?.[1];

    if (failedName && seenFailedNames.has(failedName)) {
      logger.info("[ImageCaptioner] Skipping repeated unresolvable image (likely shared/decorative)", {
        documentId,
        pageNumber,
        imageName: failedName,
      });
      return [];
    }
    if (failedName) seenFailedNames.add(failedName);

    logger.warn("[ImageCaptioner] Failed to extract embedded image, falling back to full-page screenshot", {
      documentId,
      pageNumber,
      error: message,
    });

    try {
      const screenshotResult = await parser.getScreenshot({
        partial: [pageNumber],
        imageDataUrl: true,
        imageBuffer: false,
        desiredWidth: IMAGE_CAPTION_CONFIG.screenshotWidth,
      });
      const screenshot = screenshotResult.pages[0];
      if (!screenshot) return [];
      return [{ name: `page-${pageNumber}-screenshot`, dataUrl: screenshot.dataUrl }];
    } catch (screenshotError) {
      logger.warn("[ImageCaptioner] Full-page screenshot fallback also failed, skipping page", {
        documentId,
        pageNumber,
        error: screenshotError instanceof Error ? screenshotError.message : screenshotError,
      });
      return [];
    }
  }
}

// ============================================================================
// EXTRACT + CAPTION IMAGES FROM A PDF
// ============================================================================

export async function extractAndCaptionImages(
  buffer: Buffer,
  documentId?: string
): Promise<ImageCaption[]> {
  try {
    logger.info("[ImageCaptioner] Extracting images from PDF", { documentId });

    const parser = new PDFParse({ data: buffer });
    const info = await parser.getInfo();

    const seenFailedNames = new Set<string>();
    const allImages: { pageNumber: number; image: CaptionableImage }[] = [];
    for (let pageNumber = 1; pageNumber <= info.total; pageNumber++) {
      const images = await extractPageImages(parser, pageNumber, seenFailedNames, documentId);
      for (const image of images) allImages.push({ pageNumber, image });
    }
    await parser.destroy();

    if (allImages.length === 0) {
      logger.info("[ImageCaptioner] No images found", { documentId });
      return [];
    }

    if (allImages.length > IMAGE_CAPTION_CONFIG.maxImagesPerDocument) {
      logger.warn("[ImageCaptioner] Image count exceeds cap, captioning only the first N", {
        documentId,
        totalImages: allImages.length,
        cap: IMAGE_CAPTION_CONFIG.maxImagesPerDocument,
      });
    }
    const toCaption = allImages.slice(0, IMAGE_CAPTION_CONFIG.maxImagesPerDocument);

    // Bounded worker pool, mirroring generateEmbeddings' pattern in embeddings.ts -
    // caption several images concurrently without unbounded parallelism.
    const results: (ImageCaption | null)[] = new Array(toCaption.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const i = nextIndex++;
        if (i >= toCaption.length) return;

        const { pageNumber, image } = toCaption[i];
        try {
          const caption = await withRetry(() => captionImage(image), {
            maxRetries: IMAGE_CAPTION_CONFIG.maxRetries,
            label: `image caption (page ${pageNumber}, ${image.name})`,
          });
          results[i] = { pageNumber, caption };
        } catch (error) {
          // One bad image must not fail the whole document ingestion.
          logger.warn("[ImageCaptioner] Failed to caption image, skipping", {
            documentId,
            pageNumber,
            imageName: image.name,
            error: error instanceof Error ? error.message : error,
          });
          results[i] = null;
        }
      }
    }

    const workerCount = Math.min(IMAGE_CAPTION_CONFIG.captionConcurrency, toCaption.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const captions = results.filter((r): r is ImageCaption => r !== null);

    logger.info("[ImageCaptioner] Captioning completed", {
      documentId,
      found: allImages.length,
      captioned: captions.length,
    });

    return captions;
  } catch (error) {
    // Extraction-level failure (e.g. a corrupt image stream) must not fail
    // the whole document ingestion - fall back to text-only.
    logger.error("[ImageCaptioner] Image extraction failed, continuing without image captions", {
      documentId,
      error: error instanceof Error ? error.message : error,
    });
    return [];
  }
}

// ============================================================================
// MASTRA TOOL - CAPTION PDF IMAGES
// ============================================================================

export const imageCaptioningTool = {
  id: "caption-pdf-images",
  description:
    "Extract embedded images from a PDF and generate detailed, retrieval-friendly captions using a vision-capable model",
  inputSchema: {
    type: "object" as const,
    properties: {
      buffer: {
        type: "string",
        description: "Base64 encoded PDF content",
      },
      documentId: {
        type: "string",
        description: "Optional document ID for logging",
      },
    },
    required: ["buffer"],
  },
  execute: async (input: { buffer: string; documentId?: string }) => {
    try {
      const fileBuffer = Buffer.from(input.buffer, "base64");
      const captions = await extractAndCaptionImages(fileBuffer, input.documentId);

      return {
        success: true,
        imagesCaptioned: captions.length,
        captions,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Image captioning failed",
      };
    }
  },
};
