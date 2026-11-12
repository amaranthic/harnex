/**
 * @fileoverview Built-in tool for fetching web page content and converting to Markdown.
 * Features SSRF protection (ipaddr.js), cross-host redirect detection, 15-minute in-memory caching,
 * HTML conversion via Turndown, and optional focused extraction using Hernex generateText.
 * @packageDocumentation
 */

import TurndownService from "turndown";
import { z } from "zod";
import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { isPermittedRedirect, validateWebUrl } from "./internal/ssrfGuard.js";
import { webFetchDescription } from "./prompts.js";
import { generateText } from "../runtime.js";

/**
 * Maximum character count returned before truncating web content output.
 */
const maxWebFetchCharacters = 150000;

/**
 * Default maximum redirects permitted per fetch invocation.
 */
const defaultMaxRedirects = 5;

/**
 * Default request timeout in milliseconds (15 seconds).
 */
const defaultTimeoutMs = 15000;

/**
 * Default cache time-to-live in milliseconds (15 minutes).
 */
const defaultCacheTtlMs = 15 * 60 * 1000;

/**
 * Default maximum response body size in bytes (5 MB).
 */
const defaultMaxResponseBytes = 5 * 1024 * 1024;

/**
 * Maximum extraction retry attempts for Hernex generateText.
 */
const maxExtractionRetries = 5;

/**
 * Initial backoff delay for extraction retries in milliseconds.
 */
const initialExtractionDelayMs = 500;

/**
 * Default system instructions for secondary prompt extraction.
 */
const defaultExtractionInstructions =
  "You are a web content analysis assistant. Your task is to extract, analyze, or summarize " +
  "the provided webpage content in direct response to the user's request.\n" +
  "Base your answer strictly on the provided content. If the content does not contain sufficient " +
  "information to answer the request, state that clearly without guessing or fabricating facts.";

/**
 * Input parameter schema for WebFetchTool.
 */
export const webFetchInputSchema = z.object({
  url: z
    .string()
    .url()
    .describe("The HTTP or HTTPS URL of the webpage or resource to fetch."),
  prompt: z
    .string()
    .optional()
    .describe(
      "Optional question or instruction to extract specific information from the fetched webpage. " +
        "If omitted, returns the page content converted to Markdown.",
    ),
});

/**
 * Validated input type for WebFetchTool.
 */
export type WebFetchInput = z.infer<typeof webFetchInputSchema>;

/**
 * Result structure produced by WebFetchTool.
 */
export interface WebFetchOutput {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly content: string;
  readonly cached?: boolean | undefined;
  readonly durationMs?: number | undefined;
  readonly extractedWithPrompt?: boolean | undefined;
}

/**
 * Configuration options for customizing WebFetchTool behavior.
 */
export interface WebFetchToolOptions {
  /**
   * Maximum allowed HTTP redirects before halting. Defaults to 5.
   */
  readonly maxRedirects?: number | undefined;

  /**
   * Fetch timeout per network request in milliseconds. Defaults to 15,000ms.
   */
  readonly timeoutMs?: number | undefined;

  /**
   * Cache entry expiration lifetime in milliseconds. Defaults to 15 minutes (900,000ms).
   */
  readonly cacheTtlMs?: number | undefined;

  /**
   * Maximum response body byte size permitted before aborting. Defaults to 5MB.
   */
  readonly maxResponseBytes?: number | undefined;

  /**
   * Optional custom fetch implementation for testing or sandboxed network routing.
   */
  readonly customFetch?: typeof fetch | undefined;
}

/**
 * Internal cache record structure for storing fetched web pages.
 */
interface CachedPage {
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly markdownContent: string;
  readonly timestamp: number;
}

/**
 * Executes an async operation with up to maxRetries attempts using exponential backoff.
 *
 * @param operation - The asynchronous function to execute.
 * @param maxRetries - Maximum retry attempts after an initial failure.
 * @param initialDelayMs - Base delay in milliseconds before exponential scaling.
 * @param abortSignal - Optional signal to abort wait delays immediately.
 * @returns The resolved result of the operation.
 */
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  initialDelayMs: number,
  abortSignal?: AbortSignal,
): Promise<T> {
  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new Error("Operation aborted");
    }

    try {
      return await operation();
    } catch (error: unknown) {
      attempt++;
      if (attempt > maxRetries || abortSignal?.aborted) {
        throw error;
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);

        if (abortSignal) {
          const onAbort = () => {
            clearTimeout(timer);
            abortSignal.removeEventListener("abort", onAbort);
            reject(abortSignal.reason ?? new Error("Operation aborted"));
          };
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      });

      delay = Math.min(delay * 2, 8000);
    }
  }
}

/**
 * Built-in agent tool for fetching external web pages and converting them to Markdown.
 *
 * Implements strict SSRF protection against private or loopback networks, detects
 * cross-host redirects to preserve agent control, maintains a 15-minute response cache,
 * and enables optional model extraction via Hernex's generateText runtime.
 */
export class WebFetchTool implements AgentTool<
  typeof webFetchInputSchema,
  WebFetchOutput
> {
  public static readonly toolName = "webFetch";

  public readonly name = WebFetchTool.toolName;
  public readonly description = webFetchDescription;
  public readonly inputSchema = webFetchInputSchema;

  private readonly maxRedirects: number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchFn: typeof fetch;
  private readonly turndown: TurndownService;
  private readonly cache = new Map<string, CachedPage>();

  /**
   * Constructs a new WebFetchTool instance with configurable options.
   *
   * @param options - Optional configuration parameters.
   */
  public constructor(options?: WebFetchToolOptions) {
    this.maxRedirects = options?.maxRedirects ?? defaultMaxRedirects;
    this.timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
    this.cacheTtlMs = options?.cacheTtlMs ?? defaultCacheTtlMs;
    this.maxResponseBytes =
      options?.maxResponseBytes ?? defaultMaxResponseBytes;
    this.fetchFn = options?.customFetch ?? globalThis.fetch;

    this.turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      hr: "---",
      bulletListMarker: "-",
      emDelimiter: "_",
      strongDelimiter: "**",
    });

    this.turndown.remove([
      "script",
      "style",
      "noscript",
      "svg",
      "iframe",
      "canvas",
    ]);
  }

  /**
   * Converts HTML text into clean Markdown using TurndownService.
   *
   * @param html - Raw HTML response body string.
   * @returns Cleaned Markdown text.
   */
  private convertHtmlToMarkdown(html: string): string {
    const cleaned = html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

    const markdown = this.turndown.turndown(cleaned);
    return markdown.replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * Normalizes raw response text based on content type.
   *
   * @param rawText - The raw response body text.
   * @param contentType - The Content-Type header value.
   * @returns Formatted Markdown or text.
   */
  private formatContentByMimeType(
    rawText: string,
    contentType: string,
  ): string {
    const lowerType = contentType.toLowerCase();

    if (
      lowerType.includes("text/html") ||
      lowerType.includes("application/xhtml+xml")
    ) {
      return this.convertHtmlToMarkdown(rawText);
    }

    if (lowerType.includes("application/json")) {
      try {
        const parsed = JSON.parse(rawText);
        return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
      } catch {
        return rawText.trim();
      }
    }

    if (
      lowerType.startsWith("image/") ||
      lowerType.startsWith("video/") ||
      lowerType.startsWith("audio/") ||
      lowerType.includes("application/pdf") ||
      lowerType.includes("application/zip") ||
      lowerType.includes("application/octet-stream")
    ) {
      return `[Binary content of type '${contentType}' received. WebFetch converts text and HTML to Markdown.]`;
    }

    return rawText.trim();
  }

  /**
   * Fetches the resource across allowed redirects while checking SSRF constraints.
   *
   * @param initialUrl - The validated initial URL.
   * @param abortSignal - Optional signal to abort the fetch operation.
   * @returns An object containing the final URL, status, contentType, and raw text body.
   */
  private async performFetch(
    initialUrl: URL,
    abortSignal?: AbortSignal,
  ): Promise<{
    finalUrl: string;
    status: number;
    contentType: string;
    bodyText: string;
    crossHostRedirect?: string | undefined;
  }> {
    let currentUrl = initialUrl.toString();
    let redirectCount = 0;

    while (redirectCount <= this.maxRedirects) {
      validateWebUrl(currentUrl);

      const controller = new AbortController();
      let combinedSignal: AbortSignal;

      if (abortSignal) {
        const onAbort = () => controller.abort(abortSignal.reason);
        abortSignal.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(
          () => controller.abort(new Error("Web fetch timed out.")),
          this.timeoutMs,
        );
        combinedSignal = controller.signal;
        combinedSignal.addEventListener("abort", () => clearTimeout(timer), {
          once: true,
        });
      } else {
        const timer = setTimeout(
          () => controller.abort(new Error("Web fetch timed out.")),
          this.timeoutMs,
        );
        combinedSignal = controller.signal;
        combinedSignal.addEventListener("abort", () => clearTimeout(timer), {
          once: true,
        });
      }

      const response = await this.fetchFn(currentUrl, {
        method: "GET",
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Hernex/0.3 WebFetch",
        },
        redirect: "manual",
        signal: combinedSignal,
      });

      const isRedirect =
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has("location");

      if (isRedirect) {
        const location = response.headers.get("location")!;
        const targetUrl = new URL(location, currentUrl).toString();

        if (!isPermittedRedirect(currentUrl, targetUrl)) {
          return {
            finalUrl: currentUrl,
            status: response.status,
            contentType: response.headers.get("content-type") ?? "text/plain",
            bodyText: "",
            crossHostRedirect: targetUrl,
          };
        }

        currentUrl = targetUrl;
        redirectCount++;
        continue;
      }

      const contentType =
        response.headers.get("content-type") ?? "text/plain; charset=utf-8";

      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader) {
        const length = parseInt(contentLengthHeader, 10);
        if (!isNaN(length) && length > this.maxResponseBytes) {
          throw new Error(
            `Response size (${(length / (1024 * 1024)).toFixed(1)}MB) exceeds maximum allowed size of ${(this.maxResponseBytes / (1024 * 1024)).toFixed(1)}MB.`,
          );
        }
      }

      const bodyText = await response.text();
      if (bodyText.length > this.maxResponseBytes) {
        throw new Error(
          `Response body size exceeds maximum allowed size of ${(this.maxResponseBytes / (1024 * 1024)).toFixed(1)}MB.`,
        );
      }

      return {
        finalUrl: currentUrl,
        status: response.status,
        contentType,
        bodyText,
      };
    }

    throw new Error(
      `Maximum redirect limit of ${this.maxRedirects} hops exceeded.`,
    );
  }

  /**
   * Executes the web fetch operation with SSRF validation, caching, and optional extraction.
   *
   * @param parameters - Validated parameters containing url and optional prompt.
   * @param context - The execution context with model, credentials, and abortSignal.
   * @returns A promise resolving to the structured web fetch output.
   */
  public async execute(
    parameters: WebFetchInput,
    context: ToolExecutionContext,
  ): Promise<WebFetchOutput> {
    const startTime = Date.now();
    const validatedUrl = validateWebUrl(parameters.url);
    const cacheKey = validatedUrl.toString();

    let pageData: CachedPage | undefined;
    let isCached = false;

    const existing = this.cache.get(cacheKey);
    if (existing && Date.now() - existing.timestamp < this.cacheTtlMs) {
      pageData = existing;
      isCached = true;
    }

    if (!pageData) {
      const fetchResult = await this.performFetch(
        validatedUrl,
        context.abortSignal,
      );

      if (fetchResult.crossHostRedirect) {
        const redirectMessage =
          `Redirect detected to: ${fetchResult.crossHostRedirect}. ` +
          "Automatic cross-host redirect halted for security and oversight. " +
          "Call webFetch with this new URL if desired.";

        return {
          url: parameters.url,
          finalUrl: fetchResult.finalUrl,
          status: fetchResult.status,
          contentType: fetchResult.contentType,
          content: redirectMessage,
          cached: false,
          durationMs: Date.now() - startTime,
        };
      }

      let markdown = this.formatContentByMimeType(
        fetchResult.bodyText,
        fetchResult.contentType,
      );

      if (markdown.length > maxWebFetchCharacters) {
        markdown =
          markdown.slice(0, maxWebFetchCharacters) +
          `\n\n... [Webpage content truncated at ${maxWebFetchCharacters.toLocaleString()} characters]`;
      }

      pageData = {
        finalUrl: fetchResult.finalUrl,
        status: fetchResult.status,
        contentType: fetchResult.contentType,
        markdownContent: markdown,
        timestamp: Date.now(),
      };

      if (fetchResult.status >= 200 && fetchResult.status < 300) {
        this.cache.set(cacheKey, pageData);
      }
    }

    if (!parameters.prompt || parameters.prompt.trim().length === 0) {
      return {
        url: parameters.url,
        finalUrl: pageData.finalUrl,
        status: pageData.status,
        contentType: pageData.contentType,
        content: pageData.markdownContent,
        cached: isCached,
        durationMs: Date.now() - startTime,
        extractedWithPrompt: false,
      };
    }

    if (!context.model) {
      throw new Error(
        "Extraction with 'prompt' requires an active model in ToolExecutionContext. " +
          "Ensure the tool is executed within an agent turn or provide context.model.",
      );
    }

    const promptText =
      `Webpage URL: ${pageData.finalUrl}\n\n` +
      `Webpage Content:\n${pageData.markdownContent}\n\n` +
      `User Request:\n${parameters.prompt.trim()}`;

    const extractionResult = await executeWithRetry(
      async () => {
        return generateText({
          model: context.model!,
          apiKey: context.apiKey ?? "",
          baseUrl: context.baseUrl ?? "",
          instructions: defaultExtractionInstructions,
          prompt: promptText,
          ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
        });
      },
      maxExtractionRetries,
      initialExtractionDelayMs,
      context.abortSignal,
    );

    return {
      url: parameters.url,
      finalUrl: pageData.finalUrl,
      status: pageData.status,
      contentType: pageData.contentType,
      content: extractionResult.text.trim(),
      cached: isCached,
      durationMs: Date.now() - startTime,
      extractedWithPrompt: true,
    };
  }
}

/**
 * Convenience factory for creating a configured WebFetchTool instance.
 *
 * @param options - Optional configuration settings.
 * @returns An initialized WebFetchTool instance.
 */
export function createWebFetchTool(
  options?: WebFetchToolOptions,
): WebFetchTool {
  return new WebFetchTool(options);
}
