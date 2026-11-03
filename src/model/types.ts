/**
 * @fileoverview Canonical types and contracts for Hernex models and provider adapters.
 * @packageDocumentation
 */

import type {
  LanguageModel,
  ModelMessage,
  generateText,
  streamText,
} from "ai";
import type { ProviderRegistry } from "./ProviderRegistry.js";

export type { LanguageModel, ModelMessage };

/**
 * Parsed representation of a Hernex model specification.
 */
export interface ParsedModelString {
  /**
   * The provider segment extracted from before the first slash.
   *
   * @example "openai", "anthropic", "compatible"
   */
  readonly provider: string;

  /**
   * The model identifier segment extracted from after the first slash.
   * Preserves all subsequent slashes intact.
   *
   * @example "gpt-4o", "openrouter/free"
   */
  readonly modelId: string;
}

/**
 * Mandatory credentials required for all Hernex requests.
 *
 * Every Hernex execution mandates both `apiKey` and `baseUrl`.
 */
export interface HernexCredentials {
  /**
   * The authentication key for the target model or provider.
   * Where an endpoint requires no authentication, a non-empty placeholder may be provided.
   */
  readonly apiKey: string;

  /**
   * The base URL endpoint for the target provider or proxy.
   */
  readonly baseUrl: string;
}

/**
 * Contract implemented by each dedicated provider adapter in Hernex.
 */
export interface ProviderAdapter {
  /**
   * Unique identifier of the provider handled by this adapter.
   *
   * @example "openai", "anthropic", "google", "compatible"
   */
  readonly providerId: string;

  /**
   * Instantiates a concrete AI SDK LanguageModel using the provided model ID and credentials.
   *
   * @param modelId - The provider-specific model identifier.
   * @param credentials - Mandatory apiKey and baseUrl credentials.
   * @returns A concrete AI SDK LanguageModel instance.
   */
  createModel(modelId: string, credentials: HernexCredentials): LanguageModel;
}

/**
 * Form of a Hernex model reference: either a `provider/model_id` string or an existing LanguageModel instance.
 */
export type HernexModelInput = string | LanguageModel;

/**
 * Wrapper utility type transforming native AI SDK call options into Hernex request options.
 *
 * Replaces the `model` property with `HernexModelInput` and mandates `apiKey` and `baseUrl`.
 */
export type HernexRequest<TNativeParams> = Omit<TNativeParams, "model"> & {
  /**
   * The model to use, expressed as a "provider/model_id" string or a pre-instantiated LanguageModel.
   *
   * @example "openai/gpt-4o", "anthropic/claude-3-7-sonnet", "compatible/meta-llama/llama-3-8b"
   */
  readonly model: HernexModelInput;

  /**
   * API key used to authenticate with the model endpoint.
   */
  readonly apiKey: string;

  /**
   * Base URL endpoint for the provider.
   */
  readonly baseUrl: string;

  /**
   * Optional custom provider registry for isolated resolution.
   */
  readonly providerRegistry?: ProviderRegistry;
};

/**
 * Hernex parameters for `generateText`, derived directly from AI SDK's `generateText` parameters.
 */
export type HernexGenerateTextParameters = HernexRequest<Parameters<typeof generateText>[0]>;

/**
 * Hernex parameters for `streamText`, derived directly from AI SDK's `streamText` parameters.
 */
export type HernexStreamTextParameters = HernexRequest<Parameters<typeof streamText>[0]>;
