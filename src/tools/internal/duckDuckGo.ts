/**
 * @fileoverview High-reliability native DuckDuckGo engine for Hernex.
 * Performs web search with automatic link unwrapping, HTML-to-Markdown conversion
 * via Turndown, pagination, time/region filtering, stealth browser headers,
 * jitter timing, and automatic fallback to lite.duckduckgo.com.
 * @packageDocumentation
 */

import TurndownService from "turndown";

/**
 * List of realistic desktop and mobile user agents to mimic real human browsing.
 */
const realisticUserAgents: readonly string[] = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
];

/**
 * Supported time range filters for search results.
 */
export type SearchTimeFilter = "all" | "day" | "week" | "month" | "year";

/**
 * Supported SafeSearch moderation levels.
 */
export type SafeSearchLevel = "strict" | "moderate" | "off";

/**
 * Search mode category.
 */
export type SearchMode = "web" | "instant";

/**
 * Configuration options for executing a search query.
 */
export interface DuckDuckGoSearchOptions {
  /**
   * Search query text.
   */
  readonly query: string;

  /**
   * Maximum number of organic search results to return (1-25, default: 10).
   */
  readonly limit?: number | undefined;

  /**
   * Pagination offset index (e.g. 0 for page 1, 10 for page 2).
   */
  readonly offset?: number | undefined;

  /**
   * Time range filter for results.
   */
  readonly time?: SearchTimeFilter | undefined;

  /**
   * SafeSearch moderation level.
   */
  readonly safeSearch?: SafeSearchLevel | undefined;

  /**
   * Geographic region / language code (e.g. "us-en", "uk-en", "wt-wt").
   */
  readonly region?: string | undefined;

  /**
   * Optional domain whitelist filter (e.g. ["github.com", "typescriptlang.org"]).
   */
  readonly allowedDomains?: readonly string[] | undefined;

  /**
   * Optional domain blacklist filter.
   */
  readonly blockedDomains?: readonly string[] | undefined;

  /**
   * Optional abort signal to cancel in-flight HTTP requests.
   */
  readonly abortSignal?: AbortSignal | undefined;

  /**
   * Optional custom fetch implementation for testing or sandboxing.
   */
  readonly customFetch?: typeof fetch | undefined;

  /**
   * Whether to inject a small random human-like delay before executing (default: true).
   */
  readonly enableJitter?: boolean | undefined;
}

/**
 * Individual organic search result item.
 */
export interface DuckDuckGoSearchResultItem {
  /**
   * Result title in clean text.
   */
  readonly title: string;

  /**
   * Clean, canonical target URL (unwrapped from DuckDuckGo redirect).
   */
  readonly url: string;

  /**
   * Domain name of the destination website.
   */
  readonly domain: string;

  /**
   * Snippet description formatted in clean Markdown.
   */
  readonly snippet: string;
}

/**
 * Instant answer metadata from DuckDuckGo Instant Answer API.
 */
export interface DuckDuckGoInstantAnswer {
  /**
   * Entity or topic heading.
   */
  readonly heading?: string | undefined;

  /**
   * Wikipedia or source abstract summary.
   */
  readonly abstract?: string | undefined;

  /**
   * Name of the abstract provider (e.g. "Wikipedia").
   */
  readonly source?: string | undefined;

  /**
   * Direct URL to the full source article.
   */
  readonly sourceUrl?: string | undefined;

  /**
   * Related entity topic links.
   */
  readonly relatedTopics?:
    readonly { readonly text: string; readonly url: string }[] | undefined;
}

/**
 * Complete structured output returned by DuckDuckGo engine.
 */
export interface DuckDuckGoSearchResult {
  /**
   * Original query searched.
   */
  readonly query: string;

  /**
   * Array of parsed organic search result items.
   */
  readonly results: readonly DuckDuckGoSearchResultItem[];

  /**
   * Total number of results returned in this response.
   */
  readonly totalResults: number;

  /**
   * Current pagination offset index.
   */
  readonly offset: number;

  /**
   * Offset for retrieving the next page of results, or undefined if no next page exists.
   */
  readonly nextOffset?: number | undefined;

  /**
   * Whether subsequent result pages are available.
   */
  readonly hasNextPage: boolean;

  /**
   * Active session token (VQD) if provided by DuckDuckGo.
   */
  readonly vqd?: string | undefined;

  /**
   * Optional instant answer summary when available.
   */
  readonly instantAnswer?: DuckDuckGoInstantAnswer | undefined;

  /**
   * Formatted Markdown representation of all results and instant answers.
   */
  readonly markdown: string;
}

/**
 * Reusable Turndown service instance configured for search snippet and HTML conversion.
 */
const turndownInstance = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "_",
  strongDelimiter: "**",
});

turndownInstance.remove([
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "form",
]);

/**
 * Converts HTML snippet markup into clean, readable Markdown text.
 *
 * @param html - Raw HTML snippet string.
 * @returns Clean Markdown string with entities decoded and excessive whitespace collapsed.
 */
export function convertSnippetToMarkdown(html: string): string {
  if (!html || html.trim().length === 0) {
    return "";
  }
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

  const markdown = turndownInstance.turndown(cleaned);
  return markdown.replace(/\s+/g, " ").trim();
}

/**
 * Unwraps DuckDuckGo redirect tracking URLs into clean, canonical target URLs.
 * Handles formats like `//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=...`.
 *
 * @param rawUrl - The raw URL string from DuckDuckGo search results.
 * @returns Unwrapped canonical target URL.
 */
export function unwrapDuckDuckGoUrl(rawUrl: string): string {
  if (!rawUrl) {
    return "";
  }

  const unescaped = rawUrl.replace(/&amp;/g, "&").trim();

  // If already a standard direct URL without DuckDuckGo redirect wrapping
  if (
    !unescaped.includes("duckduckgo.com/l/") &&
    !unescaped.includes("/l/?uddg=")
  ) {
    if (unescaped.startsWith("//")) {
      return `https:${unescaped}`;
    }
    return unescaped;
  }

  try {
    const fullUrl = unescaped.startsWith("//")
      ? `https:${unescaped}`
      : unescaped.startsWith("/")
        ? `https://duckduckgo.com${unescaped}`
        : unescaped;

    const parsed = new URL(fullUrl);
    const uddgParam = parsed.searchParams.get("uddg");
    if (uddgParam) {
      return decodeURIComponent(uddgParam);
    }
    return fullUrl;
  } catch {
    return unescaped;
  }
}

/**
 * Extracts the hostname domain from a URL safely.
 *
 * @param targetUrl - Valid URL string.
 * @returns Hostname without leading "www.", or empty string on error.
 */
export function extractDomainFromUrl(targetUrl: string): string {
  try {
    const parsed = new URL(targetUrl);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Selects a random modern user agent string to mimic diverse user traffic.
 *
 * @returns Modern browser User-Agent string.
 */
function getRandomUserAgent(): string {
  const index = Math.floor(Math.random() * realisticUserAgents.length);
  return realisticUserAgents[index] ?? realisticUserAgents[0]!;
}

/**
 * Builds realistic browser request headers adhering to modern HTTP standards.
 *
 * @returns Headers dictionary for HTTP requests.
 */
function buildRealisticBrowserHeaders(): Record<string, string> {
  return {
    "User-Agent": getRandomUserAgent(),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
  };
}

/**
 * Maps time filter to DuckDuckGo parameter value.
 *
 * @param time - Semantic time filter.
 * @returns DuckDuckGo df parameter value.
 */
function mapTimeFilter(time?: SearchTimeFilter): string {
  switch (time) {
    case "day":
      return "d";
    case "week":
      return "w";
    case "month":
      return "m";
    case "year":
      return "y";
    default:
      return "";
  }
}

/**
 * Maps SafeSearch level to DuckDuckGo parameter value.
 *
 * @param level - SafeSearch setting.
 * @returns DuckDuckGo kp parameter value.
 */
function mapSafeSearch(level?: SafeSearchLevel): string {
  switch (level) {
    case "strict":
      return "1";
    case "off":
      return "-2";
    case "moderate":
    default:
      return "-1";
  }
}

/**
 * Introduces human-like random jitter delay (100ms - 300ms) to prevent burst patterns.
 *
 * @param abortSignal - Optional signal to abort wait.
 */
async function applyHumanJitter(abortSignal?: AbortSignal): Promise<void> {
  const delayMs = Math.floor(100 + Math.random() * 200);
  await new Promise<void>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason);
      return;
    }
    const timer = setTimeout(() => {
      resolve();
    }, delayMs);

    abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortSignal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Checks whether a given target domain passes allowed and blocked domain filters.
 *
 * @param domain - Domain extracted from result URL.
 * @param allowedDomains - Optional list of permitted domains.
 * @param blockedDomains - Optional list of forbidden domains.
 * @returns True if the domain passes all filters, false otherwise.
 */
export function isDomainAllowed(
  domain: string,
  allowedDomains?: readonly string[],
  blockedDomains?: readonly string[],
): boolean {
  const lowerDomain = domain.toLowerCase();

  if (blockedDomains && blockedDomains.length > 0) {
    const isBlocked = blockedDomains.some((blocked) => {
      const lowerBlocked = blocked.toLowerCase().replace(/^www\./, "");
      return (
        lowerDomain === lowerBlocked || lowerDomain.endsWith(`.${lowerBlocked}`)
      );
    });
    if (isBlocked) {
      return false;
    }
  }

  if (allowedDomains && allowedDomains.length > 0) {
    return allowedDomains.some((allowed) => {
      const lowerAllowed = allowed.toLowerCase().replace(/^www\./, "");
      return (
        lowerDomain === lowerAllowed || lowerDomain.endsWith(`.${lowerAllowed}`)
      );
    });
  }

  return true;
}

/**
 * Fetches instant answers from DuckDuckGo Instant Answer API.
 *
 * @param query - Search query.
 * @param fetchFn - Fetch implementation.
 * @param abortSignal - Optional abort signal.
 * @returns Instant answer metadata if found, or undefined.
 */
export async function fetchDuckDuckGoInstantAnswer(
  query: string,
  fetchFn: typeof fetch,
  abortSignal?: AbortSignal,
): Promise<DuckDuckGoInstantAnswer | undefined> {
  try {
    const apiUrl = new URL("https://api.duckduckgo.com/");
    apiUrl.searchParams.set("q", query);
    apiUrl.searchParams.set("format", "json");
    apiUrl.searchParams.set("no_html", "1");
    apiUrl.searchParams.set("no_redirect", "1");

    const response = await fetchFn(apiUrl.toString(), {
      method: "GET",
      headers: {
        "User-Agent": getRandomUserAgent(),
        Accept: "application/json",
      },
      ...(abortSignal ? { signal: abortSignal } : {}),
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as {
      readonly Heading?: string;
      readonly Abstract?: string;
      readonly AbstractSource?: string;
      readonly AbstractURL?: string;
      readonly RelatedTopics?: readonly {
        readonly Text?: string;
        readonly FirstURL?: string;
      }[];
    };

    if (
      !data.Abstract &&
      (!data.RelatedTopics || data.RelatedTopics.length === 0)
    ) {
      return undefined;
    }

    const relatedTopics =
      data.RelatedTopics?.filter(
        (t): t is { readonly Text: string; readonly FirstURL: string } =>
          typeof t.Text === "string" && typeof t.FirstURL === "string",
      ).map((topic) => ({
        text: topic.Text,
        url: topic.FirstURL,
      })) ?? [];

    return {
      ...(data.Heading ? { heading: data.Heading } : {}),
      ...(data.Abstract ? { abstract: data.Abstract } : {}),
      ...(data.AbstractSource ? { source: data.AbstractSource } : {}),
      ...(data.AbstractURL ? { sourceUrl: data.AbstractURL } : {}),
      ...(relatedTopics.length > 0 ? { relatedTopics } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Parses organic search results from html.duckduckgo.com HTML string.
 *
 * @param html - Raw HTML from html.duckduckgo.com.
 * @returns Parsed items and next page metadata.
 */
function parseHtmlResults(html: string): {
  readonly items: DuckDuckGoSearchResultItem[];
  readonly nextOffset?: number | undefined;
  readonly vqd?: string | undefined;
} {
  const items: DuckDuckGoSearchResultItem[] = [];

  // Match organic web results: exclude ad containers (class="result--ad")
  const resultRegex =
    /<div class="result results_links results_links_deep web-result[\s\S]*?<h2 class="result__title">[\s\S]*?<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const matches = [...html.matchAll(resultRegex)];

  for (const match of matches) {
    const rawUrl = match[1] ?? "";
    const rawTitle = match[2] ?? "";
    const rawSnippet = match[3] ?? "";

    // Skip ad redirect endpoints
    if (rawUrl.includes("duckduckgo.com/y.js")) {
      continue;
    }

    const unwrappedUrl = unwrapDuckDuckGoUrl(rawUrl);
    if (!unwrappedUrl || unwrappedUrl.startsWith("/")) {
      continue;
    }

    const domain = extractDomainFromUrl(unwrappedUrl);
    const title = convertSnippetToMarkdown(rawTitle);
    const snippet = convertSnippetToMarkdown(rawSnippet);

    items.push({
      title,
      url: unwrappedUrl,
      domain,
      snippet,
    });
  }

  // Extract pagination and session tokens from next page form
  let nextOffset: number | undefined;
  let vqd: string | undefined;

  const allForms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)];
  for (const formMatch of allForms) {
    const formHtml = formMatch[0];
    const sMatch = formHtml.match(/name="s" value="(\d+)"/);
    if (sMatch?.[1]) {
      nextOffset = parseInt(sMatch[1], 10);
      const vqdMatch = formHtml.match(/name="vqd" value="([^"]+)"/);
      if (vqdMatch?.[1]) {
        vqd = vqdMatch[1];
      }
      break;
    }
  }

  return { items, nextOffset, vqd };
}

/**
 * Parses organic search results from lite.duckduckgo.com HTML string (fallback).
 *
 * @param html - Raw HTML from lite.duckduckgo.com.
 * @returns Parsed items and next page metadata.
 */
function parseLiteResults(html: string): {
  readonly items: DuckDuckGoSearchResultItem[];
  readonly nextOffset?: number | undefined;
} {
  const items: DuckDuckGoSearchResultItem[] = [];

  // Match result links and corresponding snippets in lite tables
  const rows = [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]?.[0] ?? "";
    if (row.includes("result-sponsored")) {
      continue;
    }

    const linkMatch = row.match(
      /<a rel="nofollow" href="([^"]+)" class='result-link'>([\s\S]*?)<\/a>/,
    );
    if (!linkMatch) {
      continue;
    }

    const rawUrl = linkMatch[1] ?? "";
    const rawTitle = linkMatch[2] ?? "";

    if (rawUrl.includes("duckduckgo.com/y.js")) {
      continue;
    }

    const unwrappedUrl = unwrapDuckDuckGoUrl(rawUrl);
    if (!unwrappedUrl || unwrappedUrl.startsWith("/")) {
      continue;
    }

    // Look for snippet in subsequent row
    let snippet = "";
    if (i + 1 < rows.length) {
      const nextRow = rows[i + 1]?.[0] ?? "";
      const snippetMatch = nextRow.match(
        /<td class='result-snippet'>([\s\S]*?)<\/td>/,
      );
      if (snippetMatch?.[1]) {
        snippet = convertSnippetToMarkdown(snippetMatch[1]);
      }
    }

    const domain = extractDomainFromUrl(unwrappedUrl);
    const title = convertSnippetToMarkdown(rawTitle);

    items.push({
      title,
      url: unwrappedUrl,
      domain,
      snippet,
    });
  }

  let nextOffset: number | undefined;
  const allLiteForms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)];
  for (const formMatch of allLiteForms) {
    const formHtml = formMatch[0];
    const sMatch = formHtml.match(/name="s" value="(\d+)"/);
    if (sMatch?.[1]) {
      nextOffset = parseInt(sMatch[1], 10);
      break;
    }
  }

  return { items, nextOffset };
}

/**
 * Formats structured search results and instant answers into clean Markdown.
 *
 * @param query - Original search query.
 * @param results - Array of organic search results.
 * @param instant - Optional instant answer metadata.
 * @param offset - Current page offset.
 * @returns Clean, structured Markdown representation.
 */
export function formatSearchResultsToMarkdown(
  query: string,
  results: readonly DuckDuckGoSearchResultItem[],
  instant?: DuckDuckGoInstantAnswer,
  offset: number = 0,
): string {
  const lines: string[] = [];
  lines.push(`## Search Results for "${query}"`);

  if (instant?.abstract) {
    lines.push(`\n### Instant Answer: ${instant.heading ?? query}`);
    lines.push(instant.abstract);
    if (instant.sourceUrl) {
      lines.push(
        `_Source: [${instant.source ?? "Source"}](${instant.sourceUrl})_`,
      );
    }
    lines.push("");
  }

  if (results.length === 0) {
    lines.push("\n_No matching results found._");
    return lines.join("\n");
  }

  lines.push(
    `\n**Found ${results.length} results (Page offset: ${offset}):**\n`,
  );

  for (let i = 0; i < results.length; i++) {
    const item = results[i]!;
    const rank = offset + i + 1;
    lines.push(`### ${rank}. [${item.title}](${item.url})`);
    lines.push(`**Domain:** \`${item.domain}\``);
    if (item.snippet) {
      lines.push(`> ${item.snippet}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Executes a DuckDuckGo search query using primary GET html.duckduckgo.com with automatic
 * failover to lite.duckduckgo.com, URL unwrapping, filtering, and Markdown formatting.
 *
 * @param options - Configured search options.
 * @returns Complete structured search result including formatted Markdown.
 */
export async function executeDuckDuckGoSearch(
  options: DuckDuckGoSearchOptions,
): Promise<DuckDuckGoSearchResult> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("Search query cannot be empty.");
  }

  const limit = Math.max(1, Math.min(options.limit ?? 10, 25));
  const offset = Math.max(0, options.offset ?? 0);
  const fetchFn = options.customFetch ?? globalThis.fetch;

  if (options.enableJitter !== false) {
    await applyHumanJitter(options.abortSignal);
  }

  // Concurrently fetch instant answer if on first page
  let instantPromise: Promise<DuckDuckGoInstantAnswer | undefined> =
    Promise.resolve(undefined);
  if (offset === 0) {
    instantPromise = fetchDuckDuckGoInstantAnswer(
      query,
      fetchFn,
      options.abortSignal,
    );
  }

  // Construct GET URL for html.duckduckgo.com
  const primaryUrl = new URL("https://html.duckduckgo.com/html/");
  primaryUrl.searchParams.set("q", query);
  if (offset > 0) {
    primaryUrl.searchParams.set("s", offset.toString());
  }

  const df = mapTimeFilter(options.time);
  if (df) {
    primaryUrl.searchParams.set("df", df);
  }

  const kp = mapSafeSearch(options.safeSearch);
  primaryUrl.searchParams.set("kp", kp);

  if (options.region) {
    primaryUrl.searchParams.set("kl", options.region);
  }

  let items: DuckDuckGoSearchResultItem[] = [];
  let nextOffset: number | undefined;
  let vqd: string | undefined;

  let primarySucceeded = false;

  try {
    const response = await fetchFn(primaryUrl.toString(), {
      method: "GET",
      headers: buildRealisticBrowserHeaders(),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });

    if (response.ok) {
      const html = await response.text();
      // Ensure response is not an anomaly/bot block
      if (
        !html.includes("anomaly-modal") &&
        !html.includes("anomalyDetectionBlock")
      ) {
        const parsed = parseHtmlResults(html);
        if (parsed.items.length > 0) {
          items = parsed.items;
          nextOffset = parsed.nextOffset;
          vqd = parsed.vqd;
          primarySucceeded = true;
        }
      }
    }
  } catch {
    primarySucceeded = false;
  }

  // Automatic fallback to lite.duckduckgo.com if primary failed or yielded 0 items
  if (!primarySucceeded) {
    try {
      const liteBody = new URLSearchParams();
      liteBody.set("q", query);
      if (offset > 0) {
        liteBody.set("s", offset.toString());
      }
      if (df) {
        liteBody.set("df", df);
      }
      if (options.region) {
        liteBody.set("kl", options.region);
      }

      const liteResponse = await fetchFn("https://lite.duckduckgo.com/lite/", {
        method: "POST",
        headers: {
          ...buildRealisticBrowserHeaders(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: liteBody.toString(),
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      });

      if (liteResponse.ok) {
        const liteHtml = await liteResponse.text();
        const parsed = parseLiteResults(liteHtml);
        items = parsed.items;
        nextOffset = parsed.nextOffset;
      }
    } catch (err) {
      if (items.length === 0) {
        throw new Error(
          `DuckDuckGo search failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Filter by allowed / blocked domains if specified
  if (
    (options.allowedDomains && options.allowedDomains.length > 0) ||
    (options.blockedDomains && options.blockedDomains.length > 0)
  ) {
    items = items.filter((item) =>
      isDomainAllowed(
        item.domain,
        options.allowedDomains,
        options.blockedDomains,
      ),
    );
  }

  // Truncate to desired limit
  const finalResults = items.slice(0, limit);
  const instantAnswer = await instantPromise;
  const markdown = formatSearchResultsToMarkdown(
    query,
    finalResults,
    instantAnswer,
    offset,
  );

  return {
    query,
    results: finalResults,
    totalResults: finalResults.length,
    offset,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    hasNextPage: nextOffset !== undefined,
    ...(vqd ? { vqd } : {}),
    ...(instantAnswer ? { instantAnswer } : {}),
    markdown,
  };
}
