import { createTogetherAI } from "@ai-sdk/togetherai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for Together AI provider (`@ai-sdk/togetherai`).
 */
export class TogetherAIProviderAdapter implements ProviderAdapter {
  readonly providerId = "togetherai";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createTogetherAI({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const togetherAIProviderAdapter = new TogetherAIProviderAdapter();
