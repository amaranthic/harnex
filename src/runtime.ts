/**
 * @fileoverview Curated Hernex runtime wrappers around Vercel AI SDK functions.
 * @packageDocumentation
 */

import { generateText as aiGenerateText, streamText as aiStreamText } from "ai";
import { resolveModel } from "./model/resolveModel.js";
import type { ProviderRegistry } from "./model/ProviderRegistry.js";
import type { HernexModelInput } from "./model/types.js";

/**
 * Parameters for Hernex generateText runtime call, requiring model, apiKey, and baseUrl
 * while forwarding all native AI SDK options.
 */
export type HernexGenerateTextOptions = Omit<
  Parameters<typeof aiGenerateText>[0],
  "model"
> & {
  /**
   * The model specification, formatted as "provider/model_id" (e.g. "openai/gpt-4o")
   * or a pre-instantiated LanguageModel.
   */
  readonly model: HernexModelInput;

  /**
   * The mandatory API key for the target model or provider.
   */
  readonly apiKey: string;

  /**
   * The mandatory base URL for the target model or provider endpoint.
   */
  readonly baseUrl: string;

  /**
   * Optional custom provider registry for isolated resolution.
   */
  readonly providerRegistry?: ProviderRegistry;
};

/**
 * Generates text using the specified model and credentials.
 *
 * Dynamically resolves the provider and model according to the first-slash rule,
 * applies credentials, and forwards all options to Vercel AI SDK's native `generateText`.
 *
 * @param options - Generation options with required model, apiKey, and baseUrl.
 * @returns The native AI SDK GenerateTextResult promise.
 */
export async function generateText(
  options: HernexGenerateTextOptions,
): ReturnType<typeof aiGenerateText> {
  const { model, apiKey, baseUrl, providerRegistry, ...rest } = options;

  const resolvedModel = resolveModel(
    model,
    { apiKey, baseUrl },
    providerRegistry,
  );

  return aiGenerateText({
    ...rest,
    model: resolvedModel,
  } as Parameters<typeof aiGenerateText>[0]);
}

/**
 * Parameters for Hernex streamText runtime call, requiring model, apiKey, and baseUrl
 * while forwarding all native AI SDK options.
 */
export type HernexStreamTextOptions = Omit<
  Parameters<typeof aiStreamText>[0],
  "model"
> & {
  /**
   * The model specification, formatted as "provider/model_id" (e.g. "openai/gpt-4o")
   * or a pre-instantiated LanguageModel.
   */
  readonly model: HernexModelInput;

  /**
   * The mandatory API key for the target model or provider.
   */
  readonly apiKey: string;

  /**
   * The mandatory base URL for the target model or provider endpoint.
   */
  readonly baseUrl: string;

  /**
   * Optional custom provider registry for isolated resolution.
   */
  readonly providerRegistry?: ProviderRegistry;
};

/**
 * Streams text from the specified model and credentials.
 *
 * Dynamically resolves the provider and model, applies credentials,
 * and delegates to Vercel AI SDK's native `streamText`.
 *
 * @param options - Streaming generation options with required model, apiKey, and baseUrl.
 * @returns The native AI SDK StreamTextResult instance.
 */
export function streamText(
  options: HernexStreamTextOptions,
): ReturnType<typeof aiStreamText> {
  const { model, apiKey, baseUrl, providerRegistry, ...rest } = options;

  const resolvedModel = resolveModel(
    model,
    { apiKey, baseUrl },
    providerRegistry,
  );

  return aiStreamText({
    ...rest,
    model: resolvedModel,
  } as Parameters<typeof aiStreamText>[0]);
}
