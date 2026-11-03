/**
 * @fileoverview ProviderRegistry managing built-in and custom provider adapters.
 * @packageDocumentation
 */

import type { ProviderAdapter } from "./types.js";
import { HernexUnsupportedProviderError } from "../errors.js";
import { openAIProviderAdapter } from "./providers/openai.js";
import { anthropicProviderAdapter } from "./providers/anthropic.js";
import { googleProviderAdapter } from "./providers/google.js";
import { xaiProviderAdapter } from "./providers/xai.js";
import { deepSeekProviderAdapter } from "./providers/deepseek.js";
import { groqProviderAdapter } from "./providers/groq.js";
import { mistralProviderAdapter } from "./providers/mistral.js";
import { cohereProviderAdapter } from "./providers/cohere.js";
import { togetherAIProviderAdapter } from "./providers/togetherai.js";
import { alibabaProviderAdapter } from "./providers/alibaba.js";
import { openRouterProviderAdapter } from "./providers/openrouter.js";
import { compatibleProviderAdapter } from "./providers/compatible.js";
import { vercelGatewayProviderAdapter } from "./providers/vercelGateway.js";

/**
 * Built-in provider adapters bundled with Hernex.
 */
export const builtInAdapters: readonly ProviderAdapter[] = [
  openAIProviderAdapter,
  anthropicProviderAdapter,
  googleProviderAdapter,
  xaiProviderAdapter,
  deepSeekProviderAdapter,
  groqProviderAdapter,
  mistralProviderAdapter,
  cohereProviderAdapter,
  togetherAIProviderAdapter,
  alibabaProviderAdapter,
  openRouterProviderAdapter,
  compatibleProviderAdapter,
  vercelGatewayProviderAdapter,
];

/**
 * Isolated provider registry mapping provider identifiers to their concrete ProviderAdapter instances.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  /**
   * Constructs a new ProviderRegistry instance.
   *
   * @param initialAdapters - Optional initial adapters to register. If omitted (undefined),
   * registers all built-in adapters. Passing an array (e.g. `[]`) registers only the provided adapters.
   */
  public constructor(initialAdapters?: readonly ProviderAdapter[]) {
    const adaptersToRegister = initialAdapters ?? builtInAdapters;
    for (const adapter of adaptersToRegister) {
      this.register(adapter);
    }
  }

  /**
   * Registers a provider adapter in this registry instance.
   *
   * @param adapter - The provider adapter to register.
   * @throws Error if the provider identifier is already registered.
   */
  public register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.providerId)) {
      throw new Error(
        `Provider "${adapter.providerId}" is already registered. Duplicate provider registration is not allowed.`,
      );
    }
    this.adapters.set(adapter.providerId, adapter);
  }

  /**
   * Unregisters a provider by its identifier.
   *
   * @param providerId - The provider identifier to remove.
   * @returns True if a provider was found and removed, false otherwise.
   */
  public unregister(providerId: string): boolean {
    return this.adapters.delete(providerId);
  }

  /**
   * Checks whether a provider is registered in this registry.
   *
   * @param providerId - The provider name to test.
   * @returns True if registered, false otherwise.
   */
  public has(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  /**
   * Returns an array of all currently registered provider identifiers.
   *
   * @returns Array of provider identifier strings.
   */
  public list(): readonly string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Resolves the provider adapter for a provider identifier.
   *
   * @param providerId - Provider identifier to resolve.
   * @returns The resolved ProviderAdapter.
   * @throws {HernexUnsupportedProviderError} If the provider is not registered.
   */
  public resolve(providerId: string): ProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new HernexUnsupportedProviderError({
        provider: providerId,
        supportedProviders: this.list(),
      });
    }
    return adapter;
  }
}

/**
 * Global default registry instance used when no custom registry is supplied.
 */
export const defaultProviderRegistry = new ProviderRegistry();
