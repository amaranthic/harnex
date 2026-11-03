import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for DeepSeek provider (`@ai-sdk/deepseek`).
 */
export class DeepSeekProviderAdapter implements ProviderAdapter {
  readonly providerId = "deepseek";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createDeepSeek({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const deepSeekProviderAdapter = new DeepSeekProviderAdapter();
