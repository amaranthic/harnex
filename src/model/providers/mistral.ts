import { createMistral } from "@ai-sdk/mistral";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for Mistral provider (`@ai-sdk/mistral`).
 */
export class MistralProviderAdapter implements ProviderAdapter {
  readonly providerId = "mistral";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createMistral({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const mistralProviderAdapter = new MistralProviderAdapter();
