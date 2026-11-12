/**
 * @fileoverview Built-in tool for web searching using a high-reliability native DuckDuckGo engine.
 * Converts snippets and instant answers into clean Markdown via Turndown, unwraps redirects,
 * supports pagination, SafeSearch, time ranges, domain filtering, and 15-minute response caching.
 * @packageDocumentation
 */

import { z } from "zod";
import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import {
  executeDuckDuckGoSearch,
  type DuckDuckGoInstantAnswer,
  type DuckDuckGoSearchResultItem,
  type SafeSearchLevel,
  type SearchTimeFilter,
} from "./internal/duckDuckGo.js";
import { webSearchDescription } from "./prompts.js";

/**
 * Default cache time-to-live in milliseconds (15 minutes).
 */
const defaultCacheTtlMs = 15 * 60 * 1000;

/**
 * Zod schema defining valid input parameters for WebSearchTool.
 */
export const webSearchInputSchema = z.object({
  query: z
    .string()
    .min(1, "Search query cannot be empty.")
    .describe("The search query terms to find on the web."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .optional()
    .describe(
      "Maximum number of search results to return (1-25, default: 10).",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .optional()
    .describe(
      "Pagination offset index for results (e.g. 0 for first page, 10 for second page).",
    ),
  time: z
    .enum(["all", "day", "week", "month", "year"])
    .optional()
    .describe(
      "Time range filter for results: 'day' (past 24h), 'week' (past 7 days), 'month', 'year', or 'all'.",
    ),
  safeSearch: z
    .enum(["strict", "moderate", "off"])
    .optional()
    .describe(
      "SafeSearch moderation filter level: 'strict', 'moderate' (default), or 'off'.",
    ),
  region: z
    .string()
    .optional()
    .describe(
      "Geographic region / country code for search results (e.g. 'us-en', 'uk-en', 'in-en', 'wt-wt').",
    ),
  allowedDomains: z
    .array(z.string())
    .optional()
    .describe(
      "Optional whitelist of domain names to restrict results to (e.g. ['github.com', 'wikipedia.org']).",
    ),
  blockedDomains: z
    .array(z.string())
    .optional()
    .describe("Optional blacklist of domain names to exclude from results."),
});

/**
 * Inferred input type for WebSearchTool parameters.
 */
export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

/**
 * Structured output returned by WebSearchTool upon execution.
 */
export interface WebSearchOutput {
  /**
   * The query string that was searched.
   */
  readonly query: string;

  /**
   * Array of parsed organic search result items with clean canonical URLs.
   */
  readonly results: readonly DuckDuckGoSearchResultItem[];

  /**
   * Total number of results returned in this response batch.
   */
  readonly totalResults: number;

  /**
   * Current pagination offset.
   */
  readonly offset: number;

  /**
   * Next pagination offset index if additional result pages are available.
   */
  readonly nextOffset?: number | undefined;

  /**
   * Whether subsequent pages of search results exist.
   */
  readonly hasNextPage: boolean;

  /**
   * Whether this response was served from the in-memory cache.
   */
  readonly cached: boolean;

  /**
   * Duration of the search execution in milliseconds.
   */
  readonly durationMs: number;

  /**
   * Optional DuckDuckGo instant answer summary and Wikipedia abstract.
   */
  readonly instantAnswer?: DuckDuckGoInstantAnswer | undefined;

  /**
   * Clean Markdown representation of all search results and instant answers.
   */
  readonly content: string;
}

/**
 * Configuration options for initializing a WebSearchTool instance.
 */
export interface WebSearchToolOptions {
  /**
   * In-memory cache time-to-live in milliseconds. Defaults to 15 minutes.
   */
  readonly cacheTtlMs?: number | undefined;

  /**
   * Optional custom fetch implementation for testing or sandboxing.
   */
  readonly customFetch?: typeof fetch | undefined;

  /**
   * Whether to enable human-like timing jitter between queries. Defaults to true.
   */
  readonly enableJitter?: boolean | undefined;
}

/**
 * Cached search result record.
 */
interface CachedSearchResult {
  readonly output: Omit<WebSearchOutput, "cached" | "durationMs">;
  readonly timestamp: number;
}

/**
 * Built-in agent tool for searching the web via DuckDuckGo with automatic URL unwrapping,
 * HTML-to-Markdown conversion via Turndown, pagination, filtering, and caching.
 */
export class WebSearchTool implements AgentTool<
  typeof webSearchInputSchema,
  WebSearchOutput
> {
  /**
   * Unique name of the tool in the agent registry.
   */
  public readonly name = "webSearch";

  /**
   * Detailed system instruction prompt describing the tool.
   */
  public readonly description = webSearchDescription;

  /**
   * Zod input schema for parameter validation.
   */
  public readonly inputSchema = webSearchInputSchema;

  /**
   * In-memory cache time-to-live in milliseconds.
   */
  private readonly cacheTtlMs: number;

  /**
   * Custom fetch function override.
   */
  private readonly fetchFn?: typeof fetch | undefined;

  /**
   * Whether human-like timing jitter is enabled.
   */
  private readonly enableJitter: boolean;

  /**
   * In-memory response cache mapped by normalized query key.
   */
  private readonly cache = new Map<string, CachedSearchResult>();

  /**
   * Creates a new WebSearchTool instance with optional caching and fetch overrides.
   *
   * @param options - Configuration options for the search tool.
   */
  public constructor(options?: WebSearchToolOptions) {
    this.cacheTtlMs = options?.cacheTtlMs ?? defaultCacheTtlMs;
    this.fetchFn = options?.customFetch;
    this.enableJitter = options?.enableJitter ?? true;
  }

  /**
   * Generates a stable deterministic cache key from input parameters.
   *
   * @param parameters - Search input parameters.
   * @returns Deterministic cache key string.
   */
  private getCacheKey(parameters: WebSearchInput): string {
    return JSON.stringify({
      q: parameters.query.trim().toLowerCase(),
      limit: parameters.limit ?? 10,
      offset: parameters.offset ?? 0,
      time: parameters.time,
      safeSearch: parameters.safeSearch,
      region: parameters.region,
      allowedDomains: parameters.allowedDomains
        ? [...parameters.allowedDomains].sort()
        : undefined,
      blockedDomains: parameters.blockedDomains
        ? [...parameters.blockedDomains].sort()
        : undefined,
    });
  }

  /**
   * Executes the web search operation, respecting in-memory caching and fail-soft semantics.
   *
   * @param parameters - Validated search parameters.
   * @param context - The execution context with abortSignal and credentials.
   * @returns A promise resolving to the structured search output.
   */
  public async execute(
    parameters: WebSearchInput,
    context: ToolExecutionContext,
  ): Promise<WebSearchOutput> {
    const startTime = Date.now();
    const cacheKey = this.getCacheKey(parameters);

    const existing = this.cache.get(cacheKey);
    if (existing && Date.now() - existing.timestamp < this.cacheTtlMs) {
      return {
        ...existing.output,
        cached: true,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      const searchResult = await executeDuckDuckGoSearch({
        query: parameters.query,
        limit: parameters.limit,
        offset: parameters.offset,
        time: parameters.time as SearchTimeFilter | undefined,
        safeSearch: parameters.safeSearch as SafeSearchLevel | undefined,
        region: parameters.region,
        allowedDomains: parameters.allowedDomains,
        blockedDomains: parameters.blockedDomains,
        abortSignal: context.abortSignal,
        customFetch: this.fetchFn,
        enableJitter: this.enableJitter,
      });

      const outputData: Omit<WebSearchOutput, "cached" | "durationMs"> = {
        query: searchResult.query,
        results: searchResult.results,
        totalResults: searchResult.totalResults,
        offset: searchResult.offset,
        ...(searchResult.nextOffset !== undefined
          ? { nextOffset: searchResult.nextOffset }
          : {}),
        hasNextPage: searchResult.hasNextPage,
        ...(searchResult.instantAnswer
          ? { instantAnswer: searchResult.instantAnswer }
          : {}),
        content: searchResult.markdown,
      };

      this.cache.set(cacheKey, {
        output: outputData,
        timestamp: Date.now(),
      });

      return {
        ...outputData,
        cached: false,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      // Return structured fail-soft response rather than unhandled exception
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const failSoftContent =
        `## Web Search Error\n\n` +
        `Failed to retrieve search results for "${parameters.query}": ${errorMessage}\n\n` +
        `_Suggestion: You may try rewording the query, removing restrictive filters, or using webFetch if you have a specific URL._`;

      return {
        query: parameters.query,
        results: [],
        totalResults: 0,
        offset: parameters.offset ?? 0,
        hasNextPage: false,
        cached: false,
        durationMs: Date.now() - startTime,
        content: failSoftContent,
      };
    }
  }
}

/**
 * Factory helper function to create a configured WebSearchTool instance.
 *
 * @param options - Optional configuration options for the search tool.
 * @returns An initialized WebSearchTool instance.
 */
export function createWebSearchTool(
  options?: WebSearchToolOptions,
): WebSearchTool {
  return new WebSearchTool(options);
}
