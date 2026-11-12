/**
 * @fileoverview Path containment and filesystem security guards for agent tools.
 * @packageDocumentation
 */

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Validates and resolves a target path, ensuring it stays strictly within the workspace root
 * and does not traverse through or terminate at any symbolic links.
 *
 * Enforces strict filesystem containment:
 * - Canonicalizes the workspace root directory.
 * - Rejects directory traversals (`..`) and outside absolute paths using strict relative boundary checks.
 * - Inspects every existing path segment with `lstatSync` to reject all symbolic links (both intermediate directories and target files).
 * - Stops at the first `ENOENT` so writes to not-yet-created files remain possible.
 * - Propagates permission and I/O failures without swallowing.
 *
 * @param targetPath - Path requested by tool arguments.
 * @param workingDirectory - Workspace root directory.
 * @returns Fully resolved absolute path within the workspace root.
 * @throws Error if the path escapes the workspace root or encounters a symbolic link.
 *
 * @example
 * ```typescript
 * const safePath = resolvePathWithinWorkspace("src/index.ts", "/path/to/workspace");
 * ```
 */
export function resolvePathWithinWorkspace(
  targetPath: string,
  workingDirectory: string,
): string {
  const normalizedRoot = resolve(workingDirectory);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(normalizedRoot);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "ENOENT"
    ) {
      canonicalRoot = normalizedRoot;
    } else {
      throw error;
    }
  }

  let resolvedTarget: string;
  if (isAbsolute(targetPath)) {
    const relFromNormalized = relative(normalizedRoot, resolve(targetPath));
    const isInsideNormalized =
      relFromNormalized === "" ||
      (!isAbsolute(relFromNormalized) &&
        relFromNormalized !== ".." &&
        !relFromNormalized.startsWith(".." + sep));

    if (isInsideNormalized) {
      resolvedTarget = resolve(canonicalRoot, relFromNormalized);
    } else {
      resolvedTarget = resolve(targetPath);
    }
  } else {
    resolvedTarget = resolve(canonicalRoot, targetPath);
  }

  const rel = relative(canonicalRoot, resolvedTarget);
  const isWithin =
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));

  if (!isWithin) {
    throw new Error(
      `Access denied: path "${targetPath}" resolves outside the allowed workspace directory.`,
    );
  }

  if (rel !== "") {
    const segments = rel.split(sep).filter(Boolean);
    let currentPath = canonicalRoot;

    for (const segment of segments) {
      currentPath = resolve(currentPath, segment);
      try {
        const stats = lstatSync(currentPath);
        if (stats.isSymbolicLink()) {
          throw new Error(
            `Access denied: path "${targetPath}" contains symbolic link "${segment}".`,
          );
        }
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message.startsWith("Access denied:")
        ) {
          throw error;
        }

        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: string }).code === "ENOENT"
        ) {
          // Missing component encountered: stop inspecting further components
          // so writes to not-yet-created files remain possible.
          break;
        }

        // Propagate all other permission/IO errors
        throw error;
      }
    }
  }

  return resolvedTarget;
}
