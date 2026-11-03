/**
 * @fileoverview Core serializable types and the composite AgentEvent union for Hernex.
 * @packageDocumentation
 */

import type { ThoughtDeltaEvent, TokenDeltaEvent } from "./streamEvents.js";
import type {
  ToolCallProposedEvent,
  ToolExecutionDeltaEvent,
  ToolExecutionFinishedEvent,
  ToolExecutionStartedEvent,
} from "./toolEvents.js";
import type {
  StepFinishedEvent,
  StepStartedEvent,
  TurnFinishedEvent,
  TurnStartedEvent,
} from "./stepEvents.js";
import type { CheckpointCreatedEvent } from "./checkpointEvents.js";
import type { ErrorEvent } from "./errorEvents.js";

/**
 * Primitive, array, and object types representing pure JSON data structures.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Standardized serializable error information emitted in events.
 */
export interface ErrorInfo {
  /** The name of the error class. */
  readonly name: string;
  /** Detailed error message. */
  readonly message: string;
  /** Optional stack trace string. */
  readonly stack?: string;
  /** Optional error code or status identifier. */
  readonly code?: string;
}

/**
 * Origin subsystem where an error or failure originated.
 */
export type ErrorOrigin =
  | "model"
  | "tool"
  | "checkpoint"
  | "permission"
  | "hook"
  | "engine";

/**
 * Discriminated union of all outward streaming events emitted by the AgentEngine turn stream.
 */
export type AgentEvent =
  | TokenDeltaEvent
  | ThoughtDeltaEvent
  | ToolCallProposedEvent
  | ToolExecutionStartedEvent
  | ToolExecutionDeltaEvent
  | ToolExecutionFinishedEvent
  | TurnStartedEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TurnFinishedEvent
  | CheckpointCreatedEvent
  | ErrorEvent;
