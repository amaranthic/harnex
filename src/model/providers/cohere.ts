import { createCohere } from "@ai-sdk/cohere";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for the Cohere provider (`@ai-sdk/cohere`).
 */
export class CohereProviderAdapter implements ProviderAdapter {
  readonly providerId = "cohere";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createCohere({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const cohereProviderAdapter = new CohereProviderAdapter();
