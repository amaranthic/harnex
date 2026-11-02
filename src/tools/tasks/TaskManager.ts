/**
 * @fileoverview Subprocess task manager handling live disk output streaming,
 * line-paged inspection, stdin interaction, and process group lifecycle controls.
 * @packageDocumentation
 */

import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { atomicWriteFile } from "../../storage/atomicFile.js";
import { resolveHomeDirectory } from "../../storage/homeDirectory.js";
import type {
  ShellTaskMetadata,
  ShellTaskStatus,
  TaskManagerOptions,
  TaskReadResult,
  TaskSendInputResult,
  TaskStopResult,
  TaskSummary,
} from "./types.js";

/** Default retention time for terminated tasks (10 minutes). */
export const defaultRetentionTtlMs = 10 * 60 * 1000;

/** Default capacity limit for completed tasks before pruning (50 tasks). */
export const defaultMaxRetainedTasks = 50;

/**
 * Internal active representation of a managed subprocess execution.
 */
interface InternalTaskRecord {
  metadata: ShellTaskMetadata;
  child: ChildProcess;
  logPath: string;
  lines: string[];
  pendingLineBuffer: string;
  killTimer?: NodeJS.Timeout | undefined;
  escalationTimer?: NodeJS.Timeout | undefined;
  terminalTimestamp?: number | undefined;
  stdinClosed: boolean;
}

/**
 * Manages background shell executions, live logging, and line-paged retrieval.
 */
export class TaskManager {
  private readonly rootDir: string;
  private readonly threadId: string;
  private readonly isPersist: boolean;
  private readonly retentionTtlMs: number;
  private readonly maxRetainedTasks: number;
  private readonly tasks = new Map<string, InternalTaskRecord>();
  private readonly evictedReasons = new Map<string, string>();
  private taskCounter = 0;
  private isDisposed = false;

  /**
   * Initializes a new TaskManager instance.
   *
   * @param options - Configuration options for directory resolution and retention.
   */
  public constructor(options?: TaskManagerOptions) {
    this.rootDir = resolveHomeDirectory(options);
    this.threadId = options?.threadId ?? "default";
    this.isPersist = options?.persist ?? false;
    this.retentionTtlMs = options?.retentionTtlMs ?? defaultRetentionTtlMs;
    this.maxRetainedTasks = options?.maxRetainedTasks ?? defaultMaxRetainedTasks;
  }

  /**
   * Generates a sequential, readable task identifier.
   */
  public generateTaskId(): string {
    this.taskCounter += 1;
    return `task_${this.taskCounter}`;
  }

  /**
   * Resolves the on-disk storage directory for a specific task.
   *
   * @param taskId - The unique task identifier.
   * @returns Fully resolved directory path.
   */
  public getTaskDirectory(taskId: string): string {
    if (this.isPersist) {
      return path.join(this.rootDir, "threads", this.threadId, "tasks", taskId);
    }
    return path.join(os.tmpdir(), "hernex", "tasks", this.threadId, taskId);
  }

  /**
   * Registers an active child process as a managed background task.
   *
   * Configures real-time output streaming to `output.log`, tracks line counts,
   * configures optional hard kill timeouts, and records task metadata.
   *
   * @param options - Process parameters including child, command, cwd, and timeouts.
   * @returns Snapshot metadata of the registered task.
   */
  public registerProcess(options: {
    readonly taskId?: string | undefined;
    readonly command: string;
    readonly cwd: string;
    readonly child: ChildProcess;
    readonly initialStdout?: string | undefined;
    readonly initialStderr?: string | undefined;
    readonly killTimeoutMs?: number | undefined;
  }): ShellTaskMetadata {
    this.evictExpiredTasks();

    const taskId = options.taskId ?? this.generateTaskId();
    const taskDir = this.getTaskDirectory(taskId);
    if (!existsSync(taskDir)) {
      mkdirSync(taskDir, { recursive: true });
    }

    const logPath = path.join(taskDir, "output.log");
    const lines: string[] = [];
    let pendingLineBuffer = "";

    const appendChunk = (text: string): void => {
      if (text.length === 0) return;
      try {
        appendFileSync(logPath, text, "utf-8");
      } catch {
        // Ignore file append errors
      }

      pendingLineBuffer += text;
      let newlineIndex: number;
      while ((newlineIndex = pendingLineBuffer.indexOf("\n")) !== -1) {
        const line = pendingLineBuffer.slice(0, newlineIndex);
        lines.push(line);
        pendingLineBuffer = pendingLineBuffer.slice(newlineIndex + 1);
      }
    };

    if (options.initialStdout) {
      appendChunk(options.initialStdout);
    }
    if (options.initialStderr) {
      appendChunk(options.initialStderr);
    }

    const now = Date.now();
    const initialMetadata: ShellTaskMetadata = {
      id: taskId,
      command: options.command,
      pid: options.child.pid,
      cwd: options.cwd,
      status: "running",
      startedAt: now,
      exitCode: null,
      signal: null,
      totalLines: lines.length + (pendingLineBuffer.length > 0 ? 1 : 0),
      logPath,
    };

    const record: InternalTaskRecord = {
      metadata: initialMetadata,
      child: options.child,
      logPath,
      lines,
      pendingLineBuffer,
      stdinClosed: false,
    };

    const stdoutDecoder = new StringDecoder("utf-8");
    const stderrDecoder = new StringDecoder("utf-8");

    const onDataChunk = (chunk: Buffer | string, decoder: StringDecoder): void => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (text.length > 0) {
        appendChunk(text);
        const total = lines.length + (pendingLineBuffer.length > 0 ? 1 : 0);
        record.metadata = {
          ...record.metadata,
          totalLines: total,
        };
      }
    };

    options.child.stdout?.on("data", (chunk: Buffer) => onDataChunk(chunk, stdoutDecoder));
    options.child.stderr?.on("data", (chunk: Buffer) => onDataChunk(chunk, stderrDecoder));

    options.child.stdin?.on("error", () => {
      record.stdinClosed = true;
    });

    // Hard kill timer if specified
    if (options.killTimeoutMs && options.killTimeoutMs > 0) {
      record.killTimer = setTimeout(() => {
        this.stop(taskId, "SIGTERM");
      }, options.killTimeoutMs);
      record.killTimer.unref();
    }

    // Process termination listener
    options.child.once("close", (code, signal) => {
      const restOut = stdoutDecoder.end();
      if (restOut.length > 0) {
        appendChunk(restOut);
      }
      const restErr = stderrDecoder.end();
      if (restErr.length > 0) {
        appendChunk(restErr);
      }

      if (pendingLineBuffer.length > 0) {
        lines.push(pendingLineBuffer);
        pendingLineBuffer = "";
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
      const finalStatus: ShellTaskStatus =
        record.metadata.status === "killed" ? "killed" : "exited";

      record.metadata = {
        ...record.metadata,
        status: finalStatus,
        endedAt,
        exitCode: code,
        signal,
        totalLines: lines.length,
      };
      record.terminalTimestamp = endedAt;

      // Persist meta.json
      const metaPath = path.join(taskDir, "meta.json");
      atomicWriteFile(metaPath, JSON.stringify(record.metadata, null, 2)).catch(() => {
        // Ignore background write errors
      });
    });

    this.tasks.set(taskId, record);
    return record.metadata;
  }

  /**
   * Retrieves current metadata for a task, or undefined if unknown or expired.
   *
   * @param taskId - Unique task identifier.
   */
  public getTask(taskId: string): ShellTaskMetadata | undefined {
    this.evictExpiredTasks();
    return this.tasks.get(taskId)?.metadata;
  }

  /**
   * Lists lightweight summaries of all active and recently completed tasks.
   */
  public list(): readonly TaskSummary[] {
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
      });
    }

    return summaries;
  }

  /**
   * Reads a line-paged slice from a task's log output file.
   *
   * @param taskId - The unique task identifier.
   * @param offset - 1-based starting line number (required).
   * @param limit - Maximum lines to read in this slice (required, capped at 500).
   * @throws Error if the task is not found, expired, or parameters are out of range.
   */
  public async read(
    taskId: string,
    offset: number,
    limit: number,
  ): Promise<TaskReadResult> {
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

    // If available in memory, return slice instantly
    if (record.lines.length > 0 || record.pendingLineBuffer.length > 0) {
      const allLines = [...record.lines];
      if (record.pendingLineBuffer.length > 0) {
        allLines.push(record.pendingLineBuffer);
      }
      const targetStart = offset - 1;
      const targetEnd = targetStart + clampedLimit;
      const lines = allLines.slice(targetStart, targetEnd);
      const totalLines = allLines.length;
      const hasMore = allLines.length > targetEnd;

      return {
        taskId,
        status: record.metadata.status,
        exitCode: record.metadata.exitCode,
        offset,
        limit: clampedLimit,
        totalLines,
        hasMore,
        lines,
      };
    }

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
    };
  }

  /**
   * Delivers text into a running task's standard input stream.
   *
   * @param taskId - The unique task identifier.
   * @param input - Text payload to write.
   * @param newline - Whether to append a trailing newline (default: true).
   * @throws Error if the task is not found, not running, or stdin is closed.
   */
  public async sendInput(
    taskId: string,
    input: string,
    newline = true,
  ): Promise<TaskSendInputResult> {
    this.evictExpiredTasks();

    const record = this.tasks.get(taskId);
    if (!record) {
      throw new Error(`Task "${taskId}" not found.`);
    }

    if (record.metadata.status !== "running" || record.stdinClosed) {
      throw new Error(
        `Cannot write to task "${taskId}": process has ${record.metadata.status} or stdin is closed.`,
      );
    }

    const payload = newline ? `${input}\n` : input;
    const bytesWritten = Buffer.byteLength(payload, "utf-8");

    await new Promise<void>((resolve, reject) => {
      record.child.stdin?.write(payload, "utf-8", (err) => {
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
      status: record.metadata.status,
      bytesWritten,
      message: `Successfully wrote ${bytesWritten} bytes to task "${taskId}".`,
    };
  }

  /**
   * Terminates a task process tree gracefully with SIGTERM, escalating to SIGKILL after 3 seconds.
   *
   * @param taskId - The unique task identifier to terminate.
   * @param signal - Initial signal to send (default: "SIGTERM").
   */
  public async stop(
    taskId: string,
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
  ): Promise<TaskStopResult> {
    this.evictExpiredTasks();

    const record = this.tasks.get(taskId);
    if (!record) {
      throw new Error(`Task "${taskId}" not found.`);
    }

    if (record.metadata.status !== "running") {
      return {
        taskId,
        status: record.metadata.status,
        message: `Task "${taskId}" is already ${record.metadata.status}.`,
      };
    }

    record.metadata = {
      ...record.metadata,
      status: "killed",
    };

    const pid = record.child.pid;
    if (pid) {
      try {
        // Kill process group on POSIX
        process.kill(-pid, signal);
      } catch {
        try {
          record.child.kill(signal);
        } catch {
          // Process may have already exited
        }
      }

      // Auto-escalate to SIGKILL if SIGTERM was dispatched and process is stubborn
      if (signal === "SIGTERM") {
        record.escalationTimer = setTimeout(() => {
          if (record.metadata.status === "running" || record.child.exitCode === null) {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              try {
                record.child.kill("SIGKILL");
              } catch {}
            }
          }
        }, 3000);
        record.escalationTimer.unref();
      }
    }

    return {
      taskId,
      status: "killed",
      message: `Signal ${signal} sent to task "${taskId}".`,
    };
  }

  /**
   * Evicts completed tasks that exceed retention TTL or capacity limits.
   */
  private evictExpiredTasks(): void {
    const now = Date.now();
    const terminalEntries: Array<[string, InternalTaskRecord]> = [];

    for (const [id, record] of this.tasks.entries()) {
      if (record.metadata.status !== "running") {
        terminalEntries.push([id, record]);
      }
    }

    // 1. Evict by TTL
    for (const [id, record] of terminalEntries) {
      const finishedAt = record.terminalTimestamp ?? record.metadata.endedAt ?? now;
      if (now - finishedAt > this.retentionTtlMs) {
        this.pruneTask(id, `evicted due to ${Math.round(this.retentionTtlMs / 60000)}-minute retention TTL`);
      }
    }

    // 2. Evict by capacity limit
    const remaining = Array.from(this.tasks.entries())
      .filter(([, r]) => r.metadata.status !== "running")
      .sort((a, b) => (a[1].terminalTimestamp ?? 0) - (b[1].terminalTimestamp ?? 0));

    while (remaining.length > this.maxRetainedTasks) {
      const [oldestId] = remaining.shift()!;
      this.pruneTask(oldestId, `evicted due to task capacity limit (${this.maxRetainedTasks} tasks max)`);
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
   * Terminates all running tasks and frees resources on shutdown.
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
      if (record.metadata.status === "running") {
        await this.stop(taskId, "SIGKILL").catch(() => {});
      }
    }

    if (!this.isPersist) {
      try {
        const baseTempDir = path.join(os.tmpdir(), "hernex", "tasks", this.threadId);
        if (existsSync(baseTempDir)) {
          rmSync(baseTempDir, { recursive: true, force: true });
        }
      } catch {}
    }

    this.tasks.clear();
  }
}
