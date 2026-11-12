/**
 * @fileoverview File-based exclusive locking for multi-process and multi-worker coordination.
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
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
  /**
   * Maximum age of a lock in milliseconds before it is considered stale, even if process
   * liveness cannot be disproven.
   *
   * Note on distributed/network filesystems:
   * Process liveness checks (`process.kill(pid, 0)`) are strictly local to the current host kernel.
   * Clustered or shared network file systems (NFS, SMB, CIFS) span multiple hosts that do not share
   * process identifiers; in multi-host topologies, configure `staleMs` to recover abandoned locks.
   */
  readonly staleMs?: number;
}

/**
 * Checks whether a process with the given PID is running on the local host.
 *
 * Uses `process.kill(pid, 0)` which performs permission and existence checks without
 * sending an actual signal.
 *
 * @param pid - Local operating system process identifier to probe.
 * @returns `true` if the process exists and is active; `false` if `ESRCH` (process not found).
 */
export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== "number" || pid <= 0 || !Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") {
      return false;
    }
    // EPERM indicates the process exists on this host but is owned by another user
    return true;
  }
}

/**
 * Internal result of inspecting an existing lock file.
 */
interface LockInspection {
  readonly isStale: boolean;
  readonly payload?: LockPayload | undefined;
  readonly reason?: string | undefined;
}

/**
 * Inspects an existing lock file to determine if it is stale or abandoned.
 *
 * @param lockPath - Absolute path to the lock file.
 * @param staleMs - Optional stale threshold in milliseconds.
 * @returns Lock inspection result.
 */
async function inspectLock(
  lockPath: string,
  staleMs?: number,
): Promise<LockInspection> {
  let content: string;
  try {
    content = await readFile(lockPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { isStale: false };
    }
    throw error;
  }

  if (!content || content.trim() === "") {
    try {
      const stats = await stat(lockPath);
      if (Date.now() - stats.mtimeMs > (staleMs ?? 1000)) {
        return { isStale: true, reason: "empty_or_abandoned" };
      }
    } catch {
      return { isStale: false };
    }
    return { isStale: false };
  }

  let parsed: LockPayload;
  try {
    parsed = JSON.parse(content) as LockPayload;
  } catch {
    try {
      const stats = await stat(lockPath);
      if (Date.now() - stats.mtimeMs > (staleMs ?? 1000)) {
        return { isStale: true, reason: "corrupted_payload" };
      }
    } catch {
      return { isStale: false };
    }
    return { isStale: false };
  }

  if (
    typeof parsed?.pid !== "number" ||
    typeof parsed?.token !== "string" ||
    typeof parsed?.createdAt !== "number"
  ) {
    return { isStale: true, reason: "malformed_fields" };
  }

  if (staleMs !== undefined && Date.now() - parsed.createdAt > staleMs) {
    return { isStale: true, payload: parsed, reason: "stale_ms_exceeded" };
  }

  if (!isProcessAlive(parsed.pid)) {
    return { isStale: true, payload: parsed, reason: "process_terminated" };
  }

  return { isStale: false, payload: parsed };
}

/**
 * Executes an operation while holding an exclusive file lock.
 *
 * Contention (`EEXIST`) is retried until `timeoutMs` expires. All non-contention
 * errors (such as `EACCES`, `ENOSPC`, or `EIO`) fail immediately without retry.
 * If an existing lock is held by a terminated local process or its age exceeds `staleMs`,
 * it is safely reclaimed via an atomic staging and compare-and-swap sequence without
 * displacing live owners.
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
  const staleMs =
    typeof optionsOrTimeout === "object" && optionsOrTimeout !== null
      ? optionsOrTimeout.staleMs
      : undefined;

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

      // Check if existing lock is stale and can be safely reclaimed
      const inspection = await inspectLock(absoluteLock, staleMs);
      if (inspection.isStale) {
        const reclaimLockPath = `${absoluteLock}.reclaim`;
        let reclaimHandle: { close: () => Promise<void> } | null = null;
        try {
          reclaimHandle = await open(reclaimLockPath, "wx");
        } catch (reclaimErr) {
          if ((reclaimErr as NodeJS.ErrnoException)?.code === "EEXIST") {
            try {
              const reclaimStats = await stat(reclaimLockPath);
              if (Date.now() - reclaimStats.mtimeMs > 5000) {
                await unlink(reclaimLockPath);
              }
            } catch {
              // Ignore stats/unlink errors on secondary contention
            }
          }
        }

        if (reclaimHandle !== null) {
          try {
            await reclaimHandle.close();
            // Re-verify under arbitration lock to avoid displacing newly active owners
            const recheck = await inspectLock(absoluteLock, staleMs);
            if (recheck.isStale) {
              const stagingPath = `${absoluteLock}.staging.${process.pid}.${token}.${Date.now()}`;
              await writeFile(stagingPath, JSON.stringify(payload), "utf-8");
              try {
                await rename(stagingPath, absoluteLock);
                acquired = true;
              } catch (renameErr) {
                try {
                  await unlink(stagingPath);
                } catch {
                  // Ignore staging cleanup error
                }
                throw renameErr;
              }
            }
          } finally {
            try {
              await unlink(reclaimLockPath);
            } catch {
              // Ignore reclaim lock unlink error
            }
          }
        }
      }

      if (acquired) {
        break;
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
