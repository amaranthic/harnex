/**
 * @fileoverview Deterministic multi-file workspace mutation locking.
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import path from "node:path";
import {
  resolveHomeDirectory,
  type ResolveHomeDirectoryOptions,
} from "./homeDirectory.js";
import { withFileLock, type FileLockOptions } from "./lock.js";

/**
 * Computes a deterministic hexadecimal hash digest of a path string.
 *
 * @param input - The raw path string to hash.
 * @returns A 24-character hexadecimal hash digest.
 */
function hashPathSegment(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

/**
 * Derives the exclusive lock file path for a specific target file within a workspace.
 *
 * Placed in `<homeDirectory>/locks/workspaces/<workspaceHash>/<targetHash>.lock` outside
 * the workspace tree so locking never interferes with workspace file content or git status.
 *
 * @param workingDirectory - Absolute workspace root path.
 * @param relativeFilePath - Normalized relative path within the workspace.
 * @param homeDirectory - Optional explicit storage home directory override.
 * @returns Absolute path to the lock file.
 */
export function getWorkspaceLockPath(
  workingDirectory: string,
  relativeFilePath: string,
  homeDirectory?: string,
): string {
  const canonicalWorkspace = path.resolve(workingDirectory);
  const normalizedRelative = path.normalize(relativeFilePath);
  const workspaceHash = hashPathSegment(canonicalWorkspace);
  const fileHash = hashPathSegment(normalizedRelative);

  const storageHome = resolveHomeDirectory({ homeDirectory });
  return path.join(
    storageHome,
    "locks",
    "workspaces",
    workspaceHash,
    `${fileHash}.lock`,
  );
}

/**
 * Executes an operation under exclusive file locks for one or more workspace target files.
 *
 * Invariants enforced:
 * - Target paths are normalized, made relative to `workingDirectory`, and deduplicated.
 * - Multi-file locks are acquired in strictly deterministic lexicographical order.
 *   This mathematically prevents lock inversion and deadlocks across concurrent mutations.
 * - Holds locks across the entire transaction boundary (before pre-state capture/reading,
 *   through mutation, and through post-state checkpoint finalization).
 * - All acquired locks are safely released in reverse order upon completion or failure.
 *
 * @typeParam T - The return type of the executed operation.
 * @param workingDirectory - Absolute workspace root path.
 * @param targetPaths - One or more target file paths relative to or within the workspace.
 * @param operation - The asynchronous transaction callback to execute.
 * @param options - Optional file lock and home directory configuration.
 * @returns The resolved result of the executed operation.
 */
export async function withWorkspaceFileLock<T>(
  workingDirectory: string,
  targetPaths: string | readonly string[],
  operation: () => Promise<T>,
  options?: FileLockOptions & ResolveHomeDirectoryOptions,
): Promise<T> {
  const rawList = Array.isArray(targetPaths) ? targetPaths : [targetPaths];
  if (rawList.length === 0) {
    return await operation();
  }

  const canonicalWorkspace = path.resolve(workingDirectory);
  const normalizedPaths = Array.from(
    new Set(
      rawList.map((p) => {
        const resolved = path.isAbsolute(p)
          ? path.resolve(p)
          : path.resolve(canonicalWorkspace, p);
        return path.relative(canonicalWorkspace, resolved);
      }),
    ),
  ).sort();

  const acquireRecursive = async (index: number): Promise<T> => {
    if (index >= normalizedPaths.length) {
      return await operation();
    }
    const relPath = normalizedPaths[index]!;
    const lockPath = getWorkspaceLockPath(
      canonicalWorkspace,
      relPath,
      options?.homeDirectory,
    );
    return await withFileLock(
      lockPath,
      () => acquireRecursive(index + 1),
      options,
    );
  };

  return await acquireRecursive(0);
}
