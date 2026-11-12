/**
 * @fileoverview Single-string model resolution with mandatory credentials and first-slash routing.
 * @packageDocumentation
 */

import type { LanguageModel } from "ai";
import type {
  HernexCredentials,
  HernexModelInput,
  ParsedModelString,
} from "./types.js";
import {
  HernexInvalidModelStringError,
  HernexMissingCredentialsError,
} from "../errors.js";
import {
  defaultProviderRegistry,
  ProviderRegistry,
} from "./ProviderRegistry.js";

/**
 * Parses a Hernex model string according to the strict first-slash rule.
 *
 * Segments before the first slash represent the provider identifier, and all segments
 * after the first slash (including subsequent slashes) represent the model identifier.
 *
 * @param modelString - The model string to parse (e.g. "openai/gpt-4o", "openrouter/openrouter/free").
 * @returns The parsed model representation containing provider and modelId.
 * @throws {HernexInvalidModelStringError} If the string is malformed, lacks a slash, or contains an empty provider or modelId.
 */
export function parseModelString(modelString: string): ParsedModelString {
  if (typeof modelString !== "string") {
    throw new HernexInvalidModelStringError({
      modelString: String(modelString),
      reason: "Model identifier must be a string",
    });
  }

  const firstSlashIndex = modelString.indexOf("/");

  if (firstSlashIndex === -1) {
    throw new HernexInvalidModelStringError({
      modelString,
      reason: "No '/' delimiter found",
    });
  }

  const provider = modelString.slice(0, firstSlashIndex).trim();

  if (provider.length === 0) {
    throw new HernexInvalidModelStringError({
      modelString,
      reason: "Provider identifier before '/' is empty",
    });
  }

  const modelId = modelString.slice(firstSlashIndex + 1).trim();

  if (modelId.length === 0) {
    throw new HernexInvalidModelStringError({
      modelString,
      reason: "Model identifier after '/' is empty",
    });
  }

  return {
    provider,
    modelId,
  };
}

/**
 * Validates mandatory credentials for a Hernex request.
 *
 * Every Hernex request mandates non-empty `apiKey` and `baseUrl` strings.
 *
 * @param credentials - The credentials object to validate.
 * @param provider - The target provider name for descriptive error messaging.
 * @throws {HernexMissingCredentialsError} If either `apiKey` or `baseUrl` is missing or empty.
 */
export function validateCredentials(
  credentials: HernexCredentials,
  provider: string,
): void {
  if (
    !credentials ||
    typeof credentials.apiKey !== "string" ||
    credentials.apiKey.trim().length === 0
  ) {
    throw new HernexMissingCredentialsError({
      missingField: "apiKey",
      provider,
    });
  }

  if (
    typeof credentials.baseUrl !== "string" ||
    credentials.baseUrl.trim().length === 0
  ) {
    throw new HernexMissingCredentialsError({
      missingField: "baseUrl",
      provider,
    });
  }
}

/**
 * Resolves a Hernex model input (either a `provider/model_id` string or an existing LanguageModel)
 * into an instantiated AI SDK LanguageModel.
 *
 * Completely avoids fallthrough to default AI Gateway resolution by directly routing
 * through Hernex's provider registry.
 *
 * @param model - A `provider/model_id` string or an existing LanguageModel instance.
 * @param credentials - Mandatory credentials containing non-empty apiKey and baseUrl.
 * @param providerRegistry - Optional isolated ProviderRegistry instance.
 * @returns A concrete AI SDK LanguageModel instance ready for execution.
 * @throws {HernexInvalidModelStringError} If the model string is malformed.
 * @throws {HernexMissingCredentialsError} If apiKey or baseUrl are missing.
 * @throws {HernexUnsupportedProviderError} If the provider is unknown.
 */
export function resolveModel(
  model: HernexModelInput,
  credentials: HernexCredentials,
  providerRegistry?: ProviderRegistry,
): LanguageModel {
  // If model is an object, treat as an existing pre-instantiated LanguageModel
  if (typeof model !== "string") {
    if (model && typeof model === "object") {
      validateCredentials(credentials, "custom");
      return model as LanguageModel;
    }

    throw new HernexInvalidModelStringError({
      modelString: String(model),
      reason:
        "Model must be a valid 'provider/model_id' string or an instantiated LanguageModel",
    });
  }

  const { provider, modelId } = parseModelString(model);

  validateCredentials(credentials, provider);

  const registry = providerRegistry ?? defaultProviderRegistry;
  const adapter = registry.resolve(provider);

  return adapter.createModel(modelId, credentials);
}
