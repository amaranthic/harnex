/**
 * @fileoverview Built-in tool for fast pattern-based file discovery in the workspace.
 * Leverages native globbing, filters out noise directories (.git, node_modules),
 * and enforces result size caps to protect LLM context limits.
 * @packageDocumentation
 */

import { existsSync } from "node:fs";
import { glob, lstat } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { resolvePathWithinWorkspace } from "./internal/pathGuard.js";
import { globDescription } from "./prompts.js";

/**
 * Maximum number of file paths returned before truncating results.
 */
const maxGlobResults = 250;

/**
 * Directories excluded from search results by default.
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
 * Input parameter schema for GlobTool.
 */
export const globInputSchema = z.object({
  pattern: z
    .string()
    .describe(
      "The glob pattern to match files against (e.g. '**/*.ts', 'packages/*/package.json').",
    ),
  directoryPath: z
    .string()
    .optional()
    .describe(
      "Optional directory path to search within. Defaults to the workspace root directory.",
    ),
});

/**
 * Result structure produced by GlobTool.
 */
export interface GlobOutput {
  readonly pattern: string;
  readonly directoryPath: string;
  readonly matches: readonly string[];
  readonly count: number;
  readonly durationMs: number;
  readonly isTruncated: boolean;
}

/**
 * Built-in tool for finding workspace files using glob patterns.
 */
export class GlobTool implements AgentTool<typeof globInputSchema, GlobOutput> {
  public static readonly toolName = "glob";

  public readonly name = GlobTool.toolName;
  public readonly description = globDescription;
  public readonly inputSchema = globInputSchema;

  /**
   * Executes the glob search operation.
   *
   * @param parameters - Validated parameters containing pattern and optional directoryPath.
   * @param context - The execution context with workingDirectory.
   * @returns A promise resolving to the structured glob output.
   */
  public async execute(
    parameters: z.infer<typeof globInputSchema>,
    context: ToolExecutionContext,
  ): Promise<GlobOutput> {
    const startTime = Date.now();
    const searchDir = resolvePathWithinWorkspace(
      parameters.directoryPath ?? ".",
      context.workingDirectory,
    );

    if (!existsSync(searchDir)) {
      throw new Error(
        `Search directory not found: ${parameters.directoryPath ?? searchDir}`,
      );
    }

    const rootStats = await lstat(searchDir);
    if (!rootStats.isDirectory()) {
      throw new Error(
        `Search path is not a directory: ${parameters.directoryPath ?? searchDir}`,
      );
    }

    const matchedFiles: string[] = [];
    let isTruncated = false;

    // Use native Node 22+ / Bun fs.glob
    const globIterator = glob(parameters.pattern, {
      cwd: searchDir,
    });

    for await (const entry of globIterator) {
      if (context.abortSignal?.aborted) {
        throw new Error(
          `Glob search aborted: ${context.abortSignal.reason ?? "Aborted by signal"}`,
        );
      }

      const normalizedEntry = entry.replace(/\\/g, "/");

      // Check if any path segment matches an excluded directory
      const isExcluded = excludedDirectorySegments.some((segment) =>
        normalizedEntry.split("/").includes(segment),
      );

      if (isExcluded) {
        continue;
      }

      let fullPath: string;
      try {
        fullPath = resolvePathWithinWorkspace(entry, searchDir);
        const entryStats = await lstat(fullPath);
        if (entryStats.isSymbolicLink()) {
          continue;
        }
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.message.includes("symbolic link") ||
            error.message.includes("resolves outside"))
        ) {
          continue;
        }
        throw error;
      }

      if (matchedFiles.length >= maxGlobResults) {
        isTruncated = true;
        break;
      }

      // Convert to relative path from workspace root for clean representation
      const relativePath = relative(context.workingDirectory, fullPath).replace(
        /\\/g,
        "/",
      );

      matchedFiles.push(relativePath || entry);
    }

    const durationMs = Date.now() - startTime;

    return {
      pattern: parameters.pattern,
      directoryPath: parameters.directoryPath ?? ".",
      matches: matchedFiles,
      count: matchedFiles.length,
      durationMs,
      isTruncated,
    };
  }
}
