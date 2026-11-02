/**
 * @fileoverview Task manager exports for background shell process management.
 * @packageDocumentation
 */

export {
  TaskManager,
  defaultRetentionTtlMs,
  defaultMaxRetainedTasks,
} from "./TaskManager.js";

export {
  taskManagerInputSchema,
} from "./types.js";

export type {
  ShellTaskStatus,
  ShellTaskMetadata,
  TaskSummary,
  TaskReadResult,
  TaskSendInputResult,
  TaskStopResult,
  TaskManagerOptions,
  TaskManagerInput,
} from "./types.js";
