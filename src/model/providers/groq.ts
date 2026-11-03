import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for Groq provider (`@ai-sdk/groq`).
 */
export class GroqProviderAdapter implements ProviderAdapter {
  readonly providerId = "groq";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createGroq({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const groqProviderAdapter = new GroqProviderAdapter();
