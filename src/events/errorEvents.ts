/**
 * @fileoverview Runtime error event definitions.
 * @packageDocumentation
 */

import type { ErrorInfo, ErrorOrigin } from "./types.js";

/**
 * Event emitted when an error occurs during turn execution.
 */
export interface ErrorEvent {
  /** Discriminant event type. */
  readonly type: "error";
  /** The serializable error details. */
  readonly error: ErrorInfo;
  /** Subsystem where the failure occurred. */
  readonly origin: ErrorOrigin;
  /** Associated tool name if the error happened during tool execution. */
  readonly toolName?: string;
  /** Associated hook name if the error happened during hook execution. */
  readonly hookName?: string;
  /** Whether this error halted turn execution. */
  readonly isFatal: boolean;
}
