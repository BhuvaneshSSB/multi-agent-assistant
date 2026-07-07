import { logger } from "./logger";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  // Only errors this returns true for are retried — anything else (bad
  // input, auth failure, 4xx other than 429) fails immediately instead of
  // wasting attempts on something that will just fail again.
  isRetryable?: (error: unknown) => boolean;
  label: string;
}

// Exponential backoff (base * 2^attempt, capped at maxDelayMs) around any
// async operation. Shared by the embedding pipeline and the web-search
// clients so both get the same transient-failure handling instead of each
// reimplementing its own loop.
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxRetries,
    baseDelayMs = 1000,
    maxDelayMs = 8000,
    isRetryable = () => true,
    label,
  } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      logger.warn(
        `[Retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying`,
        {
          delayMs,
          error: error instanceof Error ? error.message : error,
        }
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Classifier for axios-style HTTP errors: retry rate limits, server errors,
// and connection-level failures (no response ever came back); leave 4xx
// client errors (bad request, not found, auth) alone since retrying those
// just repeats the same failure.
export function isRetryableHttpError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const err = error as {
      response?: { status?: number };
      code?: string;
      isRetryable?: boolean;
    };
    if (typeof err.isRetryable === "boolean") return err.isRetryable;

    const status = err.response?.status;
    if (typeof status === "number") return status === 429 || status >= 500;

    // No response object means the request never got a reply (timeout, DNS,
    // connection reset) rather than the server rejecting it — worth a retry.
    if (
      err.code &&
      ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN"].includes(
        err.code
      )
    ) {
      return true;
    }
  }
  return false;
}
