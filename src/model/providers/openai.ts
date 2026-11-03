import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for the official OpenAI provider (`@ai-sdk/openai`).
 */
export class OpenAIProviderAdapter implements ProviderAdapter {
  readonly providerId = "openai";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createOpenAI({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider.responses(modelId);
  }
}

export const openAIProviderAdapter = new OpenAIProviderAdapter();
