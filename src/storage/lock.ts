/**
 * @fileoverview File-based exclusive locking for multi-process and multi-worker coordination.
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { HernexLockError } from "../errors.js";

/**
 * Payload written to the exclusive lock file for ownership validation.
 */
export interface LockPayload {
  /** Process identifier of the lock owner. */
  readonly pid: number;
  /** Unique cryptographically random token verifying ownership. */
  readonly token: string;
  /** Epoch timestamp in milliseconds when the lock was created. */
  readonly createdAt: number;
}

/**
 * Options for acquiring an exclusive file lock.
 */
export interface FileLockOptions {
  /**
   * Maximum duration in milliseconds to wait before timing out.
   * Defaults to 10,000ms.
   */
  readonly timeoutMs?: number;
  /**
   * Polling retry interval in milliseconds when contention (`EEXIST`) occurs.
   * Defaults to 25ms.
   */
  readonly retryIntervalMs?: number;
}

/**
 * Executes an operation while holding an exclusive file lock.
 *
 * Contention (`EEXIST`) is retried until `timeoutMs` expires. All non-contention
 * errors (such as `EACCES`, `ENOSPC`, or `EIO`) fail immediately without retry.
 * Ownership is verified on release using a cryptographic token. If both the inner
 * operation and lock release encounter errors, they are preserved via `AggregateError`.
 *
 * @param lockPath - Path to the lock file.
 * @param operation - Async function to run under the lock.
 * @param optionsOrTimeout - Optional lock options or timeout in milliseconds (defaults to 10000ms).
 * @returns Result of the executed operation.
 * @throws {HernexLockError} When acquisition times out or token validation fails.
 * @throws {AggregateError} When both the operation and lock release throw.
 */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  optionsOrTimeout?: number | FileLockOptions,
): Promise<T> {
  const timeoutMs =
    typeof optionsOrTimeout === "number"
      ? optionsOrTimeout
      : (optionsOrTimeout?.timeoutMs ?? 10000);
  const retryIntervalMs =
    typeof optionsOrTimeout === "object" && optionsOrTimeout !== null
      ? (optionsOrTimeout.retryIntervalMs ?? 25)
      : 25;

  const absoluteLock = path.resolve(lockPath);
  const parentDir = path.dirname(absoluteLock);
  if (!existsSync(parentDir)) {
    await mkdir(parentDir, { recursive: true });
  }

  const token = randomUUID();
  const payload: LockPayload = {
    pid: process.pid,
    token,
    createdAt: Date.now(),
  };

  const startTime = Date.now();
  let acquired = false;

  while (!acquired) {
    try {
      const handle = await open(absoluteLock, "wx");
      try {
        await handle.writeFile(JSON.stringify(payload), "utf-8");
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException)?.code;
      if (errno !== "EEXIST") {
        // Clean up partial lock file if open succeeded before writeFile threw
        try {
          await unlink(absoluteLock);
        } catch {
          // Ignore unlink error on write failure cleanup
        }
        throw error;
      }

      if (Date.now() - startTime >= timeoutMs) {
        throw new HernexLockError(
          `Failed to acquire lock at "${absoluteLock}" within ${timeoutMs}ms.`,
          absoluteLock,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
    }
  }

  let operationError: unknown = null;
  let operationResult: T;

  try {
    operationResult = await operation();
  } catch (error) {
    operationError = error;
  }

  let releaseError: unknown = null;
  try {
    let content: string | null = null;
    try {
      content = await readFile(absoluteLock, "utf-8");
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw readError;
      }
    }

    if (content !== null) {
      let parsed: LockPayload | null = null;
      try {
        parsed = JSON.parse(content) as LockPayload;
      } catch {
        throw new HernexLockError(
          `Corrupted lock file at "${absoluteLock}": invalid JSON content.`,
          absoluteLock,
        );
      }

      if (parsed?.token === token) {
        await unlink(absoluteLock);
      } else {
        throw new HernexLockError(
          `Lock token mismatch at "${absoluteLock}": expected "${token}", found "${parsed?.token ?? "unknown"}".`,
          absoluteLock,
        );
      }
    } else {
      throw new HernexLockError(
        `Lock file at "${absoluteLock}" was unexpectedly removed before release.`,
        absoluteLock,
      );
    }
  } catch (error) {
    releaseError = error;
  }

  if (operationError && releaseError) {
    throw new AggregateError(
      [operationError, releaseError],
      `Operation failed and lock release also failed at "${absoluteLock}".`,
    );
  }

  if (operationError) {
    throw operationError;
  }

  if (releaseError) {
    throw releaseError;
  }

  return operationResult!;
}
