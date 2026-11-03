/**
 * @fileoverview Atomic file write operations with temporary sibling staging.
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Options for configuring atomic file write behavior.
 */
export interface AtomicWriteOptions {
  /** File mode permission bits. */
  readonly mode?: number;
}

/**
 * Writes data to a file atomically by writing to an exclusive sibling temporary file
 * and then renaming it over the destination.
 *
 * Sibling temp files use a cryptographically random UUID to prevent collision across
 * concurrent writers. If an error occurs during write or rename and temp file cleanup
 * also fails, an AggregateError preserving both failures is thrown.
 *
 * @param filePath - The destination file path.
 * @param content - Data string or Uint8Array buffer to write.
 * @param options - Optional file mode options.
 * @returns Total bytes written.
 * @throws {AggregateError} If writing/renaming fails and cleanup also encounters an error.
 * @throws {Error} If write or rename fails and cleanup succeeds.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  options?: AtomicWriteOptions,
): Promise<number> {
  const absolutePath = path.resolve(filePath);
  const parentDir = path.dirname(absolutePath);

  if (!existsSync(parentDir)) {
    await mkdir(parentDir, { recursive: true });
  }

  const tempPath = `${absolutePath}.tmp.${randomUUID()}`;
  const buffer =
    typeof content === "string" ? Buffer.from(content, "utf-8") : content;

  try {
    await writeFile(tempPath, buffer, {
      mode: options?.mode,
      flag: "wx",
    });
    await rename(tempPath, absolutePath);
    return buffer.length;
  } catch (primaryError) {
    let cleanupError: unknown = null;
    try {
      await unlink(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        cleanupError = error;
      }
    }

    if (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        `Failed to atomically write "${absolutePath}" and failed to clean up temporary file "${tempPath}".`,
      );
    }

    throw primaryError;
  }
}
