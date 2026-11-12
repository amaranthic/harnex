/**
 * @fileoverview Built-in tool for fast regex and substring content search in workspace files.
 * Traverses targeted files, matches regex patterns line-by-line, ignores binary and vendor files,
 * and caps output to avoid blowing LLM context windows.
 * @packageDocumentation
 */

import { existsSync } from "node:fs";
import { glob, lstat, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { resolvePathWithinWorkspace } from "./internal/pathGuard.js";
import { grepDescription } from "./prompts.js";

/**
 * Default maximum number of matching lines returned.
 */
const defaultGrepLimit = 250;

/**
 * Common binary file extensions to skip during content searching.
 */
const binaryExtensions = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".wasm",
  ".pyc",
  ".lock",
]);

/**
 * Directory segments excluded from searching.
 */
const excludedDirectorySegments = [
  "node_modules",
  ".git",
  ".turbo",
  ".next",
  "dist",
  "build",
  ".cache",
];

/**
 * Input parameter schema for GrepTool.
 */
export const grepInputSchema = z
  .object({
    pattern: z
      .string()
      .describe("The regular expression pattern to search for."),
    filePath: z
      .string()
      .optional()
      .describe(
        "Optional single file path to search within. Mutually exclusive with directoryPath.",
      ),
    directoryPath: z
      .string()
      .optional()
      .describe(
        "Optional directory path to search within. Mutually exclusive with filePath. Defaults to workspace root directory if neither is specified.",
      ),
    glob: z
      .string()
      .optional()
      .describe(
        "Optional glob pattern to filter search files within a directory (e.g. '*.ts', '*.json').",
      ),
    caseInsensitive: z
      .boolean()
      .optional()
      .describe(
        "Whether to perform case-insensitive matching. Defaults to false.",
      ),
    headLimit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of match entries to return. Defaults to 250."),
  })
  .refine((data) => !(data.filePath && data.directoryPath), {
    message:
      "Cannot specify both filePath and directoryPath. Choose one target scope.",
    path: ["filePath"],
  });

/**
 * Structure of a single grep line match.
 */
export interface GrepMatch {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly line: string;
}

/**
 * Result structure produced by GrepTool.
 */
export interface GrepOutput {
  readonly pattern: string;
  readonly filePath?: string | undefined;
  readonly directoryPath?: string | undefined;
  readonly matches: readonly GrepMatch[];
  readonly totalMatches: number;
  readonly durationMs: number;
  readonly isTruncated: boolean;
}

/**
 * Built-in tool for regex searching across workspace files.
 */
export class GrepTool implements AgentTool<typeof grepInputSchema, GrepOutput> {
  public static readonly toolName = "grep";

  public readonly name = GrepTool.toolName;
  public readonly description = grepDescription;
  public readonly inputSchema = grepInputSchema;

  /**
   * Executes the grep content search.
   *
   * @param parameters - Validated parameters containing pattern, filePath, directoryPath, glob, etc.
   * @param context - The execution context with workingDirectory.
   * @returns A promise resolving to the structured grep output.
   */
  public async execute(
    parameters: z.infer<typeof grepInputSchema>,
    context: ToolExecutionContext,
  ): Promise<GrepOutput> {
    const startTime = Date.now();
    const flags = parameters.caseInsensitive ? "i" : "";
    let regex: RegExp;
    try {
      regex = new RegExp(parameters.pattern, flags);
    } catch (error) {
      throw new Error(
        `Invalid regular expression pattern "${parameters.pattern}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const matches: GrepMatch[] = [];
    let isTruncated = false;
    const limit = parameters.headLimit ?? defaultGrepLimit;

    if (parameters.filePath) {
      const targetPath = resolvePathWithinWorkspace(
        parameters.filePath,
        context.workingDirectory,
      );

      if (!existsSync(targetPath)) {
        throw new Error(`Target file not found: ${parameters.filePath}`);
      }

      const targetStats = await lstat(targetPath);
      if (targetStats.isSymbolicLink()) {
        throw new Error(
          `Target path is a symbolic link: ${parameters.filePath}`,
        );
      }
      if (targetStats.isDirectory()) {
        throw new Error(
          `Target filePath is a directory: ${parameters.filePath}. Use directoryPath instead.`,
        );
      }

      isTruncated = await this.searchFile(
        targetPath,
        context.workingDirectory,
        regex,
        matches,
        limit,
      );
    } else {
      const dirScope = parameters.directoryPath ?? ".";
      const targetPath = resolvePathWithinWorkspace(
        dirScope,
        context.workingDirectory,
      );

      if (!existsSync(targetPath)) {
        throw new Error(`Target directory not found: ${dirScope}`);
      }

      const targetStats = await lstat(targetPath);
      if (targetStats.isSymbolicLink()) {
        throw new Error(`Target path is a symbolic link: ${dirScope}`);
      }
      if (targetStats.isFile()) {
        throw new Error(
          `Target directoryPath is a file: ${dirScope}. Use filePath instead.`,
        );
      }

      const filePattern = parameters.glob ?? "**/*";
      const globIterator = glob(filePattern, { cwd: targetPath });

      for await (const entry of globIterator) {
        if (context.abortSignal?.aborted) {
          throw new Error(
            `Grep search aborted: ${context.abortSignal.reason ?? "Aborted by signal"}`,
          );
        }

        const normalized = entry.replace(/\\/g, "/");
        const isExcluded = excludedDirectorySegments.some((segment) =>
          normalized.split("/").includes(segment),
        );

        if (isExcluded) {
          continue;
        }

        let fullFilePath: string;
        try {
          fullFilePath = resolvePathWithinWorkspace(entry, targetPath);
        } catch (error: unknown) {
          if (
            error instanceof Error &&
            (error.message.includes("symbolic link") ||
              error.message.includes("resolves outside"))
          ) {
            // Deliberately skip symlinks and outside paths during file enumeration
            continue;
          }
          throw error;
        }

        let fileStat;
        try {
          fileStat = await lstat(fullFilePath);
        } catch (error: unknown) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code: string }).code === "ENOENT"
          ) {
            // File vanished between glob enumeration and lstat
            continue;
          }
          throw error;
        }

        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
          continue;
        }

        const reachedLimit = await this.searchFile(
          fullFilePath,
          context.workingDirectory,
          regex,
          matches,
          limit,
        );

        if (reachedLimit) {
          isTruncated = true;
          break;
        }
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      pattern: parameters.pattern,
      ...(parameters.filePath
        ? { filePath: parameters.filePath }
        : { directoryPath: parameters.directoryPath ?? "." }),
      matches,
      totalMatches: matches.length,
      durationMs,
      isTruncated,
    };
  }

  /**
   * Helper that searches a single file for regex line matches.
   *
   * @param fullFilePath - Absolute path of file to read.
   * @param workingDirectory - Workspace root for relative path derivation.
   * @param regex - Compiled regex pattern to test against each line.
   * @param matches - Output array to push matching items into.
   * @param limit - Maximum match count.
   * @returns True if limit is reached, false otherwise.
   */
  private async searchFile(
    fullFilePath: string,
    workingDirectory: string,
    regex: RegExp,
    matches: GrepMatch[],
    limit: number,
  ): Promise<boolean> {
    const lower = fullFilePath.toLowerCase();
    for (const ext of binaryExtensions) {
      if (lower.endsWith(ext)) {
        return false;
      }
    }

    let fileStat;
    try {
      fileStat = await lstat(fullFilePath);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }

    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return false;
    }

    // Skip excessively large files (>10MB) to protect memory
    if (fileStat.size > 10 * 1024 * 1024) {
      return false;
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(fullFilePath);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }

    // Skip binary files containing null bytes
    if (buffer.includes(0)) {
      return false;
    }

    const relPath = relative(workingDirectory, fullFilePath).replace(
      /\\/g,
      "/",
    );
    const content = buffer.toString("utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (regex.test(line)) {
        matches.push({
          filePath: relPath || fullFilePath,
          lineNumber: i + 1,
          line: line.trimEnd(),
        });

        if (matches.length >= limit) {
          return true;
        }
      }
    }

    return false;
  }
}
