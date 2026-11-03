/**
 * @fileoverview Task manager exports for background shell process management.
 * @packageDocumentation
 */

export {
  TaskManager,
  defaultRetentionTtlMs,
  defaultMaxRetainedTasks,
  defaultMaxOutputBytes,
  defaultTerminationGraceMs,
} from "./TaskManager.js";

export type {
  ShellTaskStatus,
  ShellTaskMetadata,
  TaskSummary,
  TaskReadResult,
  TaskSendInputResult,
  TaskStopResult,
  TaskWaitResult,
  TaskCreateOptions,
  CreateTaskInput,
  TaskManagerOptions,
} from "./types.js";
