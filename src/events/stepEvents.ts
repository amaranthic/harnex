/**
 * @fileoverview Turn and step execution lifecycle event definitions.
 * @packageDocumentation
 */

/**
 * Token usage summary for a step or entire turn.
 */
export interface StepTokenUsage {
  /** Number of prompt tokens processed. */
  readonly promptTokens: number;
  /** Number of completion tokens generated. */
  readonly completionTokens: number;
  /** Total tokens consumed. */
  readonly totalTokens: number;
  /** Optional reasoning or thinking tokens consumed. */
  readonly reasoningTokens?: number;
}

/**
 * Reason explaining why a turn reached completion.
 */
export type TurnFinishReason =
  | "completed"
  | "maxSteps"
  | "interrupted"
  | "error"
  | "vetoed"
  | "lengthExceeded"
  | "contentFilter";

/**
 * Event emitted when a new turn is initiated by a user message or prompt.
 */
export interface TurnStartedEvent {
  /** Discriminant event type. */
  readonly type: "turnStarted";
  /** One-based index of the active turn within the thread. */
  readonly turnIndex: number;
  /** The user prompt that initiated the turn. */
  readonly userMessage: string;
}

/**
 * Event emitted when a discrete step starts within the autonomous multi-step turn loop.
 */
export interface StepStartedEvent {
  /** Discriminant event type. */
  readonly type: "stepStarted";
  /** One-based index of the step within the turn loop. */
  readonly stepIndex: number;
  /** Millisecond epoch timestamp when the step started. */
  readonly timestamp: number;
}

/**
 * Event emitted when a step completes, recording step finish details and token metrics.
 */
export interface StepFinishedEvent {
  /** Discriminant event type. */
  readonly type: "stepFinished";
  /** One-based index of the step within the turn loop. */
  readonly stepIndex: number;
  /** Token usage statistics for this specific step. */
  readonly usage?: StepTokenUsage;
}

/**
 * Event emitted when an entire autonomous turn has concluded.
 */
export interface TurnFinishedEvent {
  /** Discriminant event type. */
  readonly type: "turnFinished";
  /** One-based index of the completed turn. */
  readonly turnIndex: number;
  /** Reason why the turn concluded. */
  readonly finishReason: TurnFinishReason;
  /** Cumulative token usage across all steps in the turn. */
  readonly totalUsage: StepTokenUsage;
}
