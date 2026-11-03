import { createAlibaba } from "@ai-sdk/alibaba";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for Alibaba provider (`@ai-sdk/alibaba`).
 */
export class AlibabaProviderAdapter implements ProviderAdapter {
  readonly providerId = "alibaba";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createAlibaba({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const alibabaProviderAdapter = new AlibabaProviderAdapter();
