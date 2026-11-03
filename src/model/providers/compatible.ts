import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for generic OpenAI-compatible API providers.
 */
export class CompatibleProviderAdapter implements ProviderAdapter {
  readonly providerId = "compatible";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createOpenAICompatible({
      name: "compatible",
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const compatibleProviderAdapter = new CompatibleProviderAdapter();
