import { createGateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for the Vercel AI Gateway provider using `@ai-sdk/gateway`.
 *
 * Configures Vercel AI Gateway routing with mandatory credentials.
 * Preserves multi-slash model identifiers (e.g. "openai/gpt-4o", "anthropic/claude-3-7-sonnet").
 */
export class VercelGatewayProviderAdapter implements ProviderAdapter {
  readonly providerId = "vercelgateway";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createGateway({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider.languageModel(modelId);
  }
}

export const vercelGatewayProviderAdapter = new VercelGatewayProviderAdapter();
