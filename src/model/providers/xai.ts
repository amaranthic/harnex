import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for xAI provider (`@ai-sdk/xai`).
 */
export class XAIProviderAdapter implements ProviderAdapter {
  readonly providerId = "xai";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createXai({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const xaiProviderAdapter = new XAIProviderAdapter();
