/**
 * @fileoverview Tool invocation, permission, and execution event definitions.
 * @packageDocumentation
 */

import type { JsonValue } from "./types.js";

/**
 * Event emitted when the model proposes a tool invocation with parsed arguments.
 */
export interface ToolCallProposedEvent {
  /** Discriminant event type. */
  readonly type: "toolCallProposed";
  /** Unique identifier for the proposed tool call. */
  readonly callId: string;
  /** Name of the tool to be executed. */
  readonly toolName: string;
  /** Parsed arguments supplied by the model. */
  readonly parameters: JsonValue;
}

/**
 * Event emitted immediately before a tool starts executing on the host.
 */
export interface ToolExecutionStartedEvent {
  /** Discriminant event type. */
  readonly type: "toolExecutionStarted";
  /** Unique identifier for the tool call. */
  readonly callId: string;
  /** Name of the tool being executed. */
  readonly toolName: string;
  /** Millisecond epoch timestamp when execution started. */
  readonly timestamp: number;
}

/**
 * Event emitted for streaming incremental progress output during tool execution.
 */
export interface ToolExecutionDeltaEvent {
  /** Discriminant event type. */
  readonly type: "toolExecutionDelta";
  /** Unique identifier for the tool call. */
  readonly callId: string;
  /** Name of the tool producing output. */
  readonly toolName: string;
  /** Incremental output chunk (e.g. stdout or status delta). */
  readonly chunk: string;
}

/**
 * Event emitted when a tool finishes execution, yielding data or failure details.
 */
export interface ToolExecutionFinishedEvent {
  /** Discriminant event type. */
  readonly type: "toolExecutionFinished";
  /** Unique identifier for the tool call. */
  readonly callId: string;
  /** Name of the tool that executed. */
  readonly toolName: string;
  /** Execution output or structured return payload. */
  readonly result: JsonValue;
  /** Whether the tool finished in an error state. */
  readonly isError: boolean;
  /** Total wall-clock execution duration in milliseconds. */
  readonly durationMs: number;
}
