import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for the OpenRouter provider using `@ai-sdk/openai-compatible`.
 *
 * Configures OpenRouter routing with mandatory credentials.
 * Preserves multi-slash model identifiers (e.g. "openrouter/free" or "anthropic/claude-3-7-sonnet").
 */
export class OpenRouterProviderAdapter implements ProviderAdapter {
  readonly providerId = "openrouter";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createOpenAICompatible({
      name: "openrouter",
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const openRouterProviderAdapter = new OpenRouterProviderAdapter();
