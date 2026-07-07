import { config } from "./env";

// Shared "primary model with resilience" config for every agent whose
// primary provider is OpenAI. Two layers of protection:
//   1. maxRetries on the primary model — retries the same model/provider on
//      a transient failure (rate limit, timeout, 5xx) before giving up.
//   2. A second Anthropic model in the fallback array — only added when
//      ANTHROPIC_API_KEY is actually configured. Without a real key, Mastra
//      would just fail resolving the fallback provider too, which isn't
//      resilience, just a second guaranteed failure. The moment the key is
//      added to .env, every agent using this helper gets real cross-provider
//      failover with no further code changes.
export function openAiModelWithFallback(
  primaryModel: string,
  fallbackModel: string
): { model: string | { model: string; maxRetries: number }[]; maxRetries: number } {
  if (config.mastra.anthropicApiKey) {
    return {
      model: [
        { model: primaryModel, maxRetries: 2 },
        { model: fallbackModel, maxRetries: 1 },
      ],
      maxRetries: 2,
    };
  }
  return { model: primaryModel, maxRetries: 2 };
}
