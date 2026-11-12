/**
 * @fileoverview Subprocess task manager handling live disk output streaming,
 * line-paged inspection, stdin interaction, and process group lifecycle controls.
 * Single owner of subprocess spawning, signalling, waiting, and deletion.
 * @packageDocumentation
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  createReadStream,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { atomicWriteFile } from "../storage/atomicFile.js";
import { resolveHomeDirectory } from "../storage/homeDirectory.js";
import { getSafeBashEnvironment } from "../tools/internal/bashEnvironment.js";
import type {
  CreateTaskInput,
  ShellTaskMetadata,
  ShellTaskStatus,
  TaskCreateOptions,
  TaskManagerOptions,
  TaskReadResult,
  TaskSendInputResult,
  TaskStopResult,
  TaskSummary,
  TaskWaitResult,
} from "./types.js";

/** Default retention time for terminated tasks (10 minutes). */
export const defaultRetentionTtlMs = 10 * 60 * 1000;

/** Default capacity limit for completed tasks before pruning (50 tasks). */
export const defaultMaxRetainedTasks = 50;

/** Default maximum output bytes persisted to disk log before truncation (1MB). */
export const defaultMaxOutputBytes = 1_000_000;

/** Default termination grace period before escalating from SIGTERM to SIGKILL (3000ms). */
export const defaultTerminationGraceMs = 3000;

/** Safe identifier regex pattern matching thread and task identifiers. */
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Internal active representation of a managed subprocess execution.
 */
interface InternalTaskRecord {
  metadata: ShellTaskMetadata;
  child: ChildProcess;
  logPath: string;
  persistedBytes: number;
  newlineCount: number;
  pendingBuffer: string;
  statusWasFailed: boolean;
  killTimer?: NodeJS.Timeout | undefined;
  escalationTimer?: NodeJS.Timeout | undefined;
  terminalTimestamp?: number | undefined;
  stdinClosed: boolean;
  readonly waiters: Set<(meta: ShellTaskMetadata) => void>;
}

/**
 * Manages background shell executions, live logging, and line-paged retrieval.
 * Sole owner of process spawning, signalling, output persistence, and termination.
 */
export class TaskManager {
  private readonly rootDir: string;
  private readonly threadId: string;
  private readonly workingDirectory: string;
  private readonly isPersist: boolean;
  private readonly retentionTtlMs: number;
  private readonly maxRetainedTasks: number;
  private readonly maxOutputBytes: number;
  private readonly terminationGraceMs: number;
  private readonly tasks = new Map<string, InternalTaskRecord>();
  private readonly evictedReasons = new Map<string, string>();
  private isDisposed = false;

  /**
   * Initializes a new TaskManager instance.
   *
   * @param options - Configuration options for directory resolution, retention, and thread identity.
   * @throws Error if threadId is provided and fails safe identifier validation.
   */
  public constructor(options: TaskManagerOptions) {
    this.threadId = options.threadId;
    if (!safeIdPattern.test(this.threadId)) {
      throw new Error(
        `Invalid threadId "${this.threadId}". Thread IDs must match ${safeIdPattern.source}`,
      );
    }
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.rootDir = resolveHomeDirectory(
      options.homeDirectory !== undefined
        ? { homeDirectory: options.homeDirectory }
        : undefined,
    );
    this.isPersist = options.persist ?? false;
    this.retentionTtlMs = options.retentionTtlMs ?? defaultRetentionTtlMs;
    this.maxRetainedTasks = options.maxRetainedTasks ?? defaultMaxRetainedTasks;
    this.maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
    this.terminationGraceMs =
      options.terminationGraceMs ?? defaultTerminationGraceMs;

    this.loadPersistedTasks();
  }

  /**
   * Validates that a task identifier conforms to the safe identifier specification.
   *
   * @param taskId - The task identifier to validate.
   * @throws Error if the identifier is malformed.
   */
  private assertValidTaskId(taskId: string): void {
    if (!taskId || !safeIdPattern.test(taskId)) {
      throw new Error(
        `Invalid taskId "${taskId}". Task IDs must match ${safeIdPattern.source}`,
      );
    }
  }

  /**
   * Generates a unique task identifier using UUIDv4.
   *
   * @returns Formatted task identifier string.
   */
  private createUniqueTaskId(): string {
    return `task_${randomUUID()}`;
  }

  /**
   * Resolves the on-disk storage directory for a specific task.
   *
   * @param taskId - The validated task identifier.
   * @returns Fully resolved directory path.
   */
  private getTaskDirectory(taskId: string): string {
    this.assertValidTaskId(taskId);
    if (this.isPersist) {
      return path.join(this.rootDir, "threads", this.threadId, "tasks", taskId);
    }
    return path.join(os.tmpdir(), "hernex", "tasks", this.threadId, taskId);
  }

  /**
   * Spawns and registers a new shell process as a managed task.
   * This is the sole execution owner for subprocess spawning across Hernex.
   *
   * @param input - Process parameters including command string, cwd, timeout, and environment allowlist.
   * @param options - Optional observers such as streaming onOutput callback.
   * @returns Snapshot metadata of the newly created task.
   * @throws Error if the task manager has been shut down or command is invalid.
   */
  public async createTask(
    input: CreateTaskInput,
    options?: TaskCreateOptions,
  ): Promise<ShellTaskMetadata> {
    if (this.isDisposed) {
      throw new Error("Cannot create task: TaskManager has been shut down.");
    }
    if (
      !input.command ||
      typeof input.command !== "string" ||
      input.command.trim().length === 0
    ) {
      throw new Error("Command must be a non-empty string.");
    }

    this.evictExpiredTasks();

    const taskId = this.createUniqueTaskId();
    const taskDir = this.getTaskDirectory(taskId);
    if (!existsSync(taskDir)) {
      mkdirSync(taskDir, { recursive: true });
    }

    const logPath = path.join(taskDir, "output.log");
    appendFileSync(logPath, "");

    const cwd = input.cwd ?? this.workingDirectory;
    const env = getSafeBashEnvironment(input.envAllowlist);

    const child = spawn(input.command, {
      shell: true,
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const now = Date.now();
    const initialMetadata: ShellTaskMetadata = {
      id: taskId,
      command: input.command,
      pid: child.pid,
      cwd,
      status: "running",
      startedAt: now,
      exitCode: null,
      signal: null,
      totalLines: 0,
      outputBytes: 0,
      outputTruncated: false,
      logPath,
    };

    const record: InternalTaskRecord = {
      metadata: initialMetadata,
      child,
      logPath,
      persistedBytes: 0,
      newlineCount: 0,
      pendingBuffer: "",
      statusWasFailed: false,
      stdinClosed: false,
      waiters: new Set(),
    };

    const stdoutDecoder = new StringDecoder("utf-8");
    const stderrDecoder = new StringDecoder("utf-8");

    const appendChunk = (text: string): void => {
      if (text.length === 0) return;
      const chunkBytes = Buffer.byteLength(text, "utf-8");
      record.metadata = {
        ...record.metadata,
        outputBytes: record.metadata.outputBytes + chunkBytes,
      };

      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") {
          record.newlineCount += 1;
        }
      }
      record.pendingBuffer += text;
      const hasTrailingNewline = text.endsWith("\n");
      const currentTotalLines =
        record.newlineCount +
        (hasTrailingNewline || record.pendingBuffer.length === 0 ? 0 : 1);

      record.metadata = {
        ...record.metadata,
        totalLines: currentTotalLines,
      };

      if (record.persistedBytes < this.maxOutputBytes) {
        const available = this.maxOutputBytes - record.persistedBytes;
        if (chunkBytes <= available) {
          appendFileSync(logPath, text, "utf-8");
          record.persistedBytes += chunkBytes;
        } else {
          const slice = Buffer.from(text, "utf-8")
            .subarray(0, available)
            .toString("utf-8");
          if (slice.length > 0) {
            appendFileSync(logPath, slice, "utf-8");
            record.persistedBytes += Buffer.byteLength(slice, "utf-8");
          }
          record.metadata = {
            ...record.metadata,
            outputTruncated: true,
          };
        }
      } else {
        record.metadata = {
          ...record.metadata,
          outputTruncated: true,
        };
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      if (text.length > 0) {
        if (options?.onOutput) {
          try {
            options.onOutput(text);
          } catch {
            // Live observer errors must not interrupt process output draining
          }
        }
        appendChunk(text);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      if (text.length > 0) {
        if (options?.onOutput) {
          try {
            options.onOutput(text);
          } catch {
            // Live observer errors must not interrupt process output draining
          }
        }
        appendChunk(text);
      }
    });

    child.stdin?.on("error", () => {
      record.stdinClosed = true;
    });

    child.on("error", () => {
      record.statusWasFailed = true;
      record.metadata = {
        ...record.metadata,
        status: "failed",
      };
    });

    if (input.timeoutMs && input.timeoutMs > 0) {
      record.killTimer = setTimeout(() => {
        this.stopTask(taskId, { signal: "SIGTERM" }).catch(() => {});
      }, input.timeoutMs);
      record.killTimer.unref();
    }

    child.once("close", (code, signal) => {
      const restOut = stdoutDecoder.end();
      if (restOut.length > 0) {
        if (options?.onOutput) {
          try {
            options.onOutput(restOut);
          } catch {
            // Live observer errors must not interrupt process output draining
          }
        }
        appendChunk(restOut);
      }

      const restErr = stderrDecoder.end();
      if (restErr.length > 0) {
        if (options?.onOutput) {
          try {
            options.onOutput(restErr);
          } catch {
            // Live observer errors must not interrupt process output draining
          }
        }
        appendChunk(restErr);
      }

      record.stdinClosed = true;

      if (record.killTimer) {
        clearTimeout(record.killTimer);
        record.killTimer = undefined;
      }
      if (record.escalationTimer) {
        clearTimeout(record.escalationTimer);
        record.escalationTimer = undefined;
      }

      const endedAt = Date.now();
      let finalStatus: ShellTaskStatus = "exited";
      if (record.statusWasFailed) {
        finalStatus = "failed";
      } else if (
        record.metadata.status === "stopping" ||
        record.metadata.status === "killed" ||
        signal !== null
      ) {
        finalStatus = "killed";
      }

      record.metadata = {
        ...record.metadata,
        status: finalStatus,
        endedAt,
        exitCode: code,
        signal,
      };
      record.terminalTimestamp = endedAt;

      const metaPath = path.join(taskDir, "meta.json");
      atomicWriteFile(metaPath, JSON.stringify(record.metadata, null, 2)).catch(
        () => {},
      );

      for (const waiter of record.waiters) {
        waiter(record.metadata);
      }
      record.waiters.clear();
    });

    this.tasks.set(taskId, record);
    return record.metadata;
  }

  /**
   * Retrieves current metadata for a task, or undefined if unknown or expired.
   *
   * @param taskId - Unique task identifier.
   * @returns Snapshot metadata of the task, or undefined if not found.
   */
  public getTask(taskId: string): ShellTaskMetadata | undefined {
    this.assertValidTaskId(taskId);
    this.evictExpiredTasks();
    return this.tasks.get(taskId)?.metadata;
  }

  /**
   * Lists lightweight summaries of all active and recently completed tasks.
   *
   * @returns Readonly array of task summaries.
   */
  public listTasks(): readonly TaskSummary[] {
    this.evictExpiredTasks();
    const now = Date.now();
    const summaries: TaskSummary[] = [];

    for (const record of this.tasks.values()) {
      const meta = record.metadata;
      const runtimeMs = (meta.endedAt ?? now) - meta.startedAt;
      summaries.push({
        id: meta.id,
        command: meta.command,
        status: meta.status,
        runtimeMs,
        exitCode: meta.exitCode,
        totalLines: meta.totalLines,
        outputBytes: meta.outputBytes,
        outputTruncated: meta.outputTruncated,
      });
    }

    return summaries;
  }

  /**
   * Reads a line-paged slice from a task's log output file on disk.
   *
   * @param taskId - The unique task identifier.
   * @param offset - 1-based starting line number (required).
   * @param limit - Maximum lines to read in this slice (capped at 500).
   * @returns Promise resolving to the paged task log slice.
   * @throws Error if the task is not found, expired, or parameters are out of range.
   */
  public async readTask(
    taskId: string,
    offset: number,
    limit: number,
  ): Promise<TaskReadResult> {
    this.assertValidTaskId(taskId);
    this.evictExpiredTasks();

    const record = this.tasks.get(taskId);
    if (!record) {
      const reason = this.evictedReasons.get(taskId);
      if (reason) {
        throw new Error(`Task "${taskId}" was ${reason}.`);
      }
      throw new Error(`Task "${taskId}" not found.`);
    }

    if (offset < 1) {
      throw new Error(`Invalid offset: ${offset}. Offset must be >= 1.`);
    }
    const clampedLimit = Math.min(Math.max(1, limit), 500);

    const logPath = record.metadata.logPath;
    if (!existsSync(logPath)) {
      return {
        taskId,
        status: record.metadata.status,
        exitCode: record.metadata.exitCode,
        offset,
        limit: clampedLimit,
        totalLines: 0,
        hasMore: false,
        lines: [],
        outputTruncated: record.metadata.outputTruncated,
      };
    }

    const lines: string[] = [];
    let currentLineIndex = 0;
    const targetStart = offset;
    const targetEnd = offset + clampedLimit - 1;

    const fileStream = createReadStream(logPath, { encoding: "utf-8" });
    const readlineInterface = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of readlineInterface) {
      currentLineIndex += 1;
      if (currentLineIndex >= targetStart && currentLineIndex <= targetEnd) {
        lines.push(line);
      }
    }

    const totalLines = Math.max(record.metadata.totalLines, currentLineIndex);
    const hasMore = totalLines > targetEnd;

    return {
      taskId,
      status: record.metadata.status,
      exitCode: record.metadata.exitCode,
      offset,
      limit: clampedLimit,
      totalLines,
      hasMore,
      lines,
      outputTruncated: record.metadata.outputTruncated,
    };
  }

  /**
   * Delivers text into a running task's standard input stream.
   *
   * @param taskId - The unique task identifier.
   * @param input - Text payload to write.
   * @param options - Optional parameters, such as appending a newline.
   * @returns Promise resolving to input delivery confirmation.
   * @throws Error if the task is not found, not running, or stdin is closed.
   */
  public async sendTaskInput(
    taskId: string,
    input: string,
    options?: { readonly newline?: boolean | undefined },
  ): Promise<TaskSendInputResult> {
    this.assertValidTaskId(taskId);
    this.evictExpiredTasks();

    const record = this.tasks.get(taskId);
    if (!record) {
      throw new Error(`Task "${taskId}" not found.`);
    }

    if (
      record.metadata.status !== "running" ||
      record.stdinClosed ||
      !record.child?.stdin ||
      record.child.stdin.destroyed
    ) {
      throw new Error(
        `Cannot write to task "${taskId}": process has ${record.metadata.status} or stdin is closed.`,
      );
    }

    const payload = (options?.newline ?? true) ? `${input}\n` : input;
    const bytesWritten = Buffer.byteLength(payload, "utf-8");

    await new Promise<void>((resolve, reject) => {
      record.child.stdin!.write(payload, "utf-8", (err) => {
        if (err) {
          record.stdinClosed = true;
          reject(err);
        } else {
          resolve();
        }
      });
    });

    return {
      taskId,
      status: "running",
      bytesWritten,
    };
  }

  /**
   * Terminates a task process gracefully with SIGTERM, escalating to SIGKILL after grace period.
   * Blocks until child close is observed to guarantee complete termination.
   *
   * @param taskId - The unique task identifier to terminate.
   * @param options - Signal to dispatch and termination grace timeout before escalating to SIGKILL.
   * @returns Promise resolving to final termination details.
   * @throws Error if the task is not found.
   */
  public async stopTask(
    taskId: string,
    options?: {
      readonly signal?: "SIGTERM" | "SIGKILL" | undefined;
      readonly graceMs?: number | undefined;
    },
  ): Promise<TaskStopResult> {
    this.assertValidTaskId(taskId);
    this.evictExpiredTasks();

    const record = this.tasks.get(taskId);
    if (!record) {
      throw new Error(`Task "${taskId}" not found.`);
    }

    if (
      record.metadata.status !== "running" &&
      record.metadata.status !== "stopping"
    ) {
      return {
        taskId,
        status: (record.metadata.status === "orphaned"
          ? "exited"
          : record.metadata.status) as "killed" | "exited" | "failed",
        exitCode: record.metadata.exitCode,
        signal: record.metadata.signal,
      };
    }

    record.metadata = {
      ...record.metadata,
      status: "stopping",
    };

    const signal = options?.signal ?? "SIGTERM";
    const pid = record.child?.pid;
    if (pid) {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          record.child.kill(signal);
        } catch {
          // Process already terminated or signal rejected
        }
      }

      const graceMs = options?.graceMs ?? this.terminationGraceMs;
      record.escalationTimer = setTimeout(() => {
        if (
          record.metadata.status === "stopping" ||
          record.metadata.status === "running"
        ) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              record.child.kill("SIGKILL");
            } catch {
              // Process already terminated or signal rejected
            }
          }
        }
      }, graceMs);
      record.escalationTimer.unref();
    }

    await new Promise<void>((resolve) => {
      if (
        record.metadata.status !== "running" &&
        record.metadata.status !== "stopping"
      ) {
        resolve();
        return;
      }
      const onTerm = () => resolve();
      record.waiters.add(onTerm);
    });

    if (record.escalationTimer) {
      clearTimeout(record.escalationTimer);
      record.escalationTimer = undefined;
    }

    const finalStatus: "killed" | "exited" | "failed" =
      record.metadata.status === "stopping"
        ? "killed"
        : (record.metadata.status as "killed" | "exited" | "failed");

    return {
      taskId,
      status: finalStatus,
      exitCode: record.metadata.exitCode,
      signal: record.metadata.signal,
    };
  }

  /**
   * Waits for a task to terminate or for the specified wait timeout to expire.
   *
   * @param taskId - The unique task identifier.
   * @param options - Timeout in milliseconds and optional abort signal.
   * @returns Snapshot metadata and whether the wait timed out.
   * @throws Error if the task is not found or abort signal triggers.
   */
  public async waitForTask(
    taskId: string,
    options?: {
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<TaskWaitResult> {
    this.assertValidTaskId(taskId);
    this.evictExpiredTasks();

    const record = this.tasks.get(taskId);
    if (!record) {
      throw new Error(`Task "${taskId}" not found.`);
    }

    if (
      record.metadata.status !== "running" &&
      record.metadata.status !== "stopping"
    ) {
      return {
        task: record.metadata,
        timedOut: false,
      };
    }

    return new Promise<TaskWaitResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener("abort", abortHandler);
        }
        record.waiters.delete(onClose);
      };

      const onClose = (meta: ShellTaskMetadata) => {
        cleanup();
        resolve({
          task: meta,
          timedOut: false,
        });
      };

      record.waiters.add(onClose);

      if (options?.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          resolve({
            task: this.getTask(taskId)!,
            timedOut: true,
          });
        }, options.timeoutMs);
        timer.unref();
      }

      if (options?.signal) {
        if (options.signal.aborted) {
          cleanup();
          reject(
            new Error(
              `waitForTask aborted: ${options.signal.reason ?? "Aborted by signal"}`,
            ),
          );
          return;
        }
        abortHandler = () => {
          cleanup();
          reject(
            new Error(
              `waitForTask aborted: ${options.signal?.reason ?? "Aborted by signal"}`,
            ),
          );
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }

  /**
   * Deletes a terminal task record and cleans up its directory and log assets.
   *
   * @param taskId - The unique task identifier to remove.
   * @returns True if deleted, false if task was not found.
   * @throws Error if the task is still running or stopping.
   */
  public async deleteTask(taskId: string): Promise<boolean> {
    this.assertValidTaskId(taskId);
    this.evictExpiredTasks();

    const record = this.tasks.get(taskId);
    if (!record) {
      return false;
    }

    if (
      record.metadata.status === "running" ||
      record.metadata.status === "stopping"
    ) {
      throw new Error(
        `Cannot delete task "${taskId}" because it is still ${record.metadata.status}. Only terminal tasks may be deleted.`,
      );
    }

    const taskDir = this.getTaskDirectory(taskId);
    if (existsSync(taskDir)) {
      rmSync(taskDir, { recursive: true, force: true });
    }

    this.tasks.delete(taskId);
    return true;
  }

  /**
   * Scans and loads persisted tasks from the persistent thread storage root.
   * Any previously active task is marked as orphaned without signalling stale PIDs.
   */
  private loadPersistedTasks(): void {
    if (!this.isPersist) return;
    const tasksBaseDir = path.join(
      this.rootDir,
      "threads",
      this.threadId,
      "tasks",
    );
    if (!existsSync(tasksBaseDir)) return;

    try {
      const entries = readdirSync(tasksBaseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const taskId = entry.name;
        if (!safeIdPattern.test(taskId)) continue;

        const taskDir = path.join(tasksBaseDir, taskId);
        const metaPath = path.join(taskDir, "meta.json");
        if (!existsSync(metaPath)) continue;

        try {
          const raw = readFileSync(metaPath, "utf-8");
          const parsed = JSON.parse(raw) as ShellTaskMetadata;
          const status: ShellTaskStatus =
            parsed.status === "running" || parsed.status === "stopping"
              ? "orphaned"
              : parsed.status;

          const updatedMeta: ShellTaskMetadata = {
            ...parsed,
            status,
          };

          if (status === "orphaned" && parsed.status !== "orphaned") {
            atomicWriteFile(
              metaPath,
              JSON.stringify(updatedMeta, null, 2),
            ).catch(() => {});
          }

          const logPath = path.join(taskDir, "output.log");
          this.tasks.set(taskId, {
            metadata: updatedMeta,
            child: undefined as unknown as ChildProcess,
            logPath,
            persistedBytes: updatedMeta.outputBytes,
            newlineCount: updatedMeta.totalLines,
            pendingBuffer: "",
            statusWasFailed: updatedMeta.status === "failed",
            stdinClosed: true,
            waiters: new Set(),
          });
        } catch {
          // Skip corrupt task record
        }
      }
    } catch {
      // Ignore directory scan error
    }
  }

  /**
   * Evicts completed tasks that exceed retention TTL or capacity limits.
   */
  private evictExpiredTasks(): void {
    const now = Date.now();
    const terminalEntries: Array<[string, InternalTaskRecord]> = [];

    for (const [id, record] of this.tasks.entries()) {
      if (
        record.metadata.status !== "running" &&
        record.metadata.status !== "stopping"
      ) {
        terminalEntries.push([id, record]);
      }
    }

    for (const [id, record] of terminalEntries) {
      const finishedAt =
        record.terminalTimestamp ?? record.metadata.endedAt ?? now;
      if (now - finishedAt > this.retentionTtlMs) {
        this.pruneTask(
          id,
          `evicted due to ${Math.round(this.retentionTtlMs / 60000)}-minute retention TTL`,
        );
      }
    }

    const remaining = Array.from(this.tasks.entries())
      .filter(
        ([, r]) =>
          r.metadata.status !== "running" && r.metadata.status !== "stopping",
      )
      .sort(
        (a, b) => (a[1].terminalTimestamp ?? 0) - (b[1].terminalTimestamp ?? 0),
      );

    while (remaining.length > this.maxRetainedTasks) {
      const [oldestId] = remaining.shift()!;
      this.pruneTask(
        oldestId,
        `evicted due to task capacity limit (${this.maxRetainedTasks} tasks max)`,
      );
    }
  }

  /**
   * Prunes a single task from memory and cleans up on-disk assets.
   */
  private pruneTask(taskId: string, reason: string): void {
    const record = this.tasks.get(taskId);
    if (!record) return;

    if (!this.isPersist) {
      try {
        const dir = this.getTaskDirectory(taskId);
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // Ignore directory cleanup error
      }
    }

    this.tasks.delete(taskId);
    if (this.evictedReasons.size >= 100) {
      const oldestKey = this.evictedReasons.keys().next().value;
      if (oldestKey) {
        this.evictedReasons.delete(oldestKey);
      }
    }
    this.evictedReasons.set(taskId, reason);
  }

  /**
   * Terminates all active running tasks and frees resources on engine shutdown.
   */
  public async shutdown(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const [taskId, record] of this.tasks.entries()) {
      if (record.killTimer) {
        clearTimeout(record.killTimer);
      }
      if (record.escalationTimer) {
        clearTimeout(record.escalationTimer);
      }
      if (
        record.metadata.status === "running" ||
        record.metadata.status === "stopping"
      ) {
        await this.stopTask(taskId, { signal: "SIGKILL", graceMs: 500 }).catch(
          () => {},
        );
      }
    }

    if (!this.isPersist) {
      try {
        const baseTempDir = path.join(
          os.tmpdir(),
          "hernex",
          "tasks",
          this.threadId,
        );
        if (existsSync(baseTempDir)) {
          rmSync(baseTempDir, { recursive: true, force: true });
        }
      } catch {
        // Ephemeral task directory cleanup error ignored on shutdown
      }
    }

    this.tasks.clear();
  }
}
