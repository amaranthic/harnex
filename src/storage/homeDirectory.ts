/**
 * @fileoverview Resolves home directory configuration for Hernex state storage.
 * @packageDocumentation
 */

import os from "node:os";
import path from "node:path";

export interface ResolveHomeDirectoryOptions {
  /** Explicit override for the storage home directory. */
  readonly homeDirectory?: string | undefined;
}

/**
 * Resolves the authoritative home directory for Hernex threads and checkpoints.
 *
 * Precedence:
 * 1. Explicit `options.homeDirectory`
 * 2. `process.env.HERNEX_HOME`
 * 3. Default fallback: `path.join(os.homedir(), '.greg')`
 *
 * @param options - Optional configuration parameters.
 * @returns Fully normalized absolute directory path.
 */
export function resolveHomeDirectory(
  options?: ResolveHomeDirectoryOptions,
): string {
  let resolved: string;

  if (options?.homeDirectory && options.homeDirectory.trim().length > 0) {
    resolved = options.homeDirectory.trim();
  } else if (
    process.env.HERNEX_HOME &&
    process.env.HERNEX_HOME.trim().length > 0
  ) {
    resolved = process.env.HERNEX_HOME.trim();
  } else {
    resolved = path.join(os.homedir(), ".greg");
  }

  // Expand leading tilde
  if (resolved === "~" || resolved.startsWith("~" + path.sep)) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }

  return path.resolve(resolved);
}
