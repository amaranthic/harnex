/**
 * @fileoverview Type definitions and interfaces for the background task manager subsystem.
 * @packageDocumentation
 */

import { z } from "zod";

/**
 * Lifecycle execution status of a background shell task.
 */
export type ShellTaskStatus = "running" | "exited" | "killed";

/**
 * Metadata record for a background shell task.
 */
export interface ShellTaskMetadata {
  /** Unique task identifier (e.g. "task_1", "task_2"). */
  readonly id: string;
  /** Shell command executed by this task. */
  readonly command: string;
  /** Subprocess PID, if running or recorded. */
  readonly pid?: number | undefined;
  /** Working directory where the command was initiated. */
  readonly cwd: string;
  /** Current execution status. */
  readonly status: ShellTaskStatus;
  /** Timestamp in milliseconds when execution commenced. */
  readonly startedAt: number;
  /** Timestamp in milliseconds when execution terminated, if settled. */
  readonly endedAt?: number | undefined;
  /** Process exit code, or null if terminated by signal or still active. */
  readonly exitCode: number | null;
  /** Termination signal name if killed (e.g. "SIGTERM", "SIGKILL"). */
  readonly signal: string | null;
  /** Total count of newline-delimited output lines captured. */
  readonly totalLines: number;
  /** Absolute path to the on-disk output.log file. */
  readonly logPath: string;
}

/**
 * Lightweight summary of a task returned by the "list" action.
 */
export interface TaskSummary {
  /** Unique task identifier. */
  readonly id: string;
  /** Shell command string (or truncated preview). */
  readonly command: string;
  /** Current status of the task. */
  readonly status: ShellTaskStatus;
  /** Total elapsed runtime in milliseconds. */
  readonly runtimeMs: number;
  /** Exit code if completed, otherwise null. */
  readonly exitCode: number | null;
  /** Total output lines recorded so far. */
  readonly totalLines: number;
}

/**
 * Result returned by the line-paged "read" action.
 */
export interface TaskReadResult {
  /** Unique task identifier. */
  readonly taskId: string;
  /** Current status of the task. */
  readonly status: ShellTaskStatus;
  /** Process exit code if settled, otherwise null. */
  readonly exitCode: number | null;
  /** 1-based line number of the first line in this page. */
  readonly offset: number;
  /** Maximum number of lines requested. */
  readonly limit: number;
  /** Total lines written to output.log to date. */
  readonly totalLines: number;
  /** Whether additional lines exist beyond this page. */
  readonly hasMore: boolean;
  /** Array of line strings retrieved for this slice. */
  readonly lines: readonly string[];
}

/**
 * Result of delivering standard input text to a task.
 */
export interface TaskSendInputResult {
  /** Unique task identifier. */
  readonly taskId: string;
  /** Current status of the task. */
  readonly status: ShellTaskStatus;
  /** Number of bytes written to the stdin stream. */
  readonly bytesWritten: number;
  /** Informative status message. */
  readonly message: string;
}

/**
 * Result of requesting process termination.
 */
export interface TaskStopResult {
  /** Unique task identifier. */
  readonly taskId: string;
  /** Status following the termination request. */
  readonly status: ShellTaskStatus;
  /** Informative status message. */
  readonly message: string;
}

/**
 * Configuration options for initializing a TaskManager instance.
 */
export interface TaskManagerOptions {
  /** Optional base home directory override for storage. */
  readonly homeDirectory?: string;
  /** The parent thread identifier, if associated with a thread session. */
  readonly threadId?: string;
  /** Whether the thread session is persistent (true) or ephemeral (false). */
  readonly persist?: boolean;
  /** Milliseconds to retain completed tasks before eviction (defaults to 10 minutes). */
  readonly retentionTtlMs?: number;
  /** Maximum capacity of completed tasks to retain before LRU pruning (defaults to 50). */
  readonly maxRetainedTasks?: number;
}

/**
 * Zod schema for TaskManagerTool inputs using a discriminated union on the "action" field.
 */
export const taskManagerInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z
      .literal("list")
      .describe("List all active and recently completed background tasks."),
  }),
  z.object({
    action: z
      .literal("read")
      .describe("Read a line-paged slice of output logs from a task."),
    taskId: z.string().describe("The unique task identifier to inspect."),
    offset: z
      .number()
      .int()
      .min(1)
      .describe("1-based line number to begin reading from (required)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .describe("Maximum number of lines to return, up to 500 (required)."),
  }),
  z.object({
    action: z
      .literal("sendInput")
      .describe("Deliver text into standard input of a running background task."),
    taskId: z.string().describe("The unique task identifier of the target process."),
    input: z.string().describe("Text payload to write into stdin."),
    newline: z
      .boolean()
      .optional()
      .describe("Whether to append a trailing newline (defaults to true)."),
  }),
  z.object({
    action: z
      .literal("stop")
      .describe("Terminate a background task process and its process tree."),
    taskId: z.string().describe("The unique task identifier to terminate."),
    signal: z
      .enum(["SIGTERM", "SIGKILL"])
      .optional()
      .describe("Termination signal to dispatch (defaults to SIGTERM)."),
  }),
]);

/**
 * TypeScript type inferred from taskManagerInputSchema.
 */
export type TaskManagerInput = z.infer<typeof taskManagerInputSchema>;
