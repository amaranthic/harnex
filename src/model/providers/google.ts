import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for the Google provider (`@ai-sdk/google`).
 */
export class GoogleProviderAdapter implements ProviderAdapter {
  readonly providerId = "google";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createGoogleGenerativeAI({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const googleProviderAdapter = new GoogleProviderAdapter();
