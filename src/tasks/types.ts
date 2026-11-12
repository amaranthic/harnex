/**
 * @fileoverview Type definitions and interfaces for the core task execution engine.
 * Defines process lifecycle states, metadata records, paged log slicing,
 * and options for background subprocess management.
 * @packageDocumentation
 */

/**
 * Lifecycle execution status of a background shell task.
 */
export type ShellTaskStatus =
  "running" | "stopping" | "exited" | "killed" | "failed" | "orphaned";

/**
 * Input configuration for creating a managed subprocess task in the engine.
 */
export interface CreateTaskInput {
  /** The shell command string to execute. */
  readonly command: string;
  /** Working directory override. Defaults to workingDirectory of the TaskManager. */
  readonly cwd?: string | undefined;
  /** Hard task lifetime in milliseconds. Timeout stops the process. */
  readonly timeoutMs?: number | undefined;
  /** Optional explicit allowlist of environment variable names to pass to the process. */
  readonly envAllowlist?: readonly string[] | undefined;
}

/**
 * Options for configuring a TaskManager instance.
 */
export interface TaskManagerOptions {
  /** The parent thread identifier associated with this task manager. */
  readonly threadId: string;
  /** Root working directory for spawned processes. */
  readonly workingDirectory: string;
  /** Optional base home directory override for storage. */
  readonly homeDirectory?: string | undefined;
  /** Whether the thread is persistent (true) or ephemeral (false). Defaults to false. */
  readonly persist?: boolean | undefined;
  /** Milliseconds to retain completed tasks before eviction (defaults to 10 minutes). */
  readonly retentionTtlMs?: number | undefined;
  /** Maximum capacity of completed tasks to retain before LRU pruning (defaults to 50). */
  readonly maxRetainedTasks?: number | undefined;
  /** Maximum output bytes persisted to the disk log before truncation (defaults to 1MB). */
  readonly maxOutputBytes?: number | undefined;
  /** Grace period in milliseconds before escalating SIGTERM to SIGKILL (defaults to 3000ms). */
  readonly terminationGraceMs?: number | undefined;
}

/**
 * Metadata record for a background shell task.
 */
export interface ShellTaskMetadata {
  /** Unique task identifier (e.g. "task_01944e..."). */
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
  /** Total count of output bytes captured so far. */
  readonly outputBytes: number;
  /** Whether the output was truncated after exceeding maxOutputBytes. */
  readonly outputTruncated: boolean;
  /** Absolute path to the on-disk output.log file. */
  readonly logPath: string;
}

/**
 * Lightweight summary of a task returned by list operations.
 */
export interface TaskSummary {
  /** Unique task identifier. */
  readonly id: string;
  /** Shell command string. */
  readonly command: string;
  /** Current status of the task. */
  readonly status: ShellTaskStatus;
  /** Total elapsed runtime in milliseconds. */
  readonly runtimeMs: number;
  /** Exit code if completed, otherwise null. */
  readonly exitCode: number | null;
  /** Total output lines recorded so far. */
  readonly totalLines: number;
  /** Total output bytes recorded so far. */
  readonly outputBytes: number;
  /** Whether output logging was truncated due to exceeding maxOutputBytes. */
  readonly outputTruncated: boolean;
}

/**
 * Result returned by line-paged task read operations.
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
  /** Whether the underlying log was truncated due to the byte cap. */
  readonly outputTruncated: boolean;
}

/**
 * Result of delivering standard input text to a task.
 */
export interface TaskSendInputResult {
  /** Unique task identifier. */
  readonly taskId: string;
  /** Status of the task (must be "running"). */
  readonly status: "running";
  /** Number of bytes written to the stdin stream. */
  readonly bytesWritten: number;
}

/**
 * Result of requesting process termination.
 */
export interface TaskStopResult {
  /** Unique task identifier. */
  readonly taskId: string;
  /** Terminal status following the termination request. */
  readonly status: "killed" | "exited" | "failed";
  /** Exit code if captured, otherwise null. */
  readonly exitCode: number | null;
  /** Termination signal if captured, otherwise null. */
  readonly signal: string | null;
}

/**
 * Result of waiting for a task to reach a terminal state or timeout.
 */
export interface TaskWaitResult {
  /** Current snapshot metadata of the target task. */
  readonly task: ShellTaskMetadata;
  /** Whether the wait operation timed out before the process terminated. */
  readonly timedOut: boolean;
}

/**
 * Optional callbacks and configuration when creating a task.
 */
export interface TaskCreateOptions {
  /** Live streaming observer callback for real-time output chunks. */
  readonly onOutput?: ((chunk: string) => void) | undefined;
}
