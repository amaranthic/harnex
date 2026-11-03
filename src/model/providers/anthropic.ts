import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for the official Anthropic provider (`@ai-sdk/anthropic`).
 */
export class AnthropicProviderAdapter implements ProviderAdapter {
  readonly providerId = "anthropic";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createAnthropic({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const anthropicProviderAdapter = new AnthropicProviderAdapter();
