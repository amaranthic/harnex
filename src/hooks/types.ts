/**
 * @fileoverview Complete hook type definitions and contracts for Hernex.
 * @packageDocumentation
 */

import type { ModelMessage } from "../model/types.js";
import type { StepTokenUsage, TurnFinishReason } from "../events/stepEvents.js";
import type { ErrorOrigin } from "../events/types.js";

/**
 * Context provided before an autonomous turn begins.
 */
export interface BeforeTurnContext {
  /** One-based index of the upcoming turn. */
  readonly turnIndex: number;
  /** The user prompt submitted for this turn. */
  readonly userPrompt: string;
}

/**
 * Optional modifications returned by a before-turn hook.
 */
export interface BeforeTurnResult {
  /** Modified user prompt string. */
  readonly userPrompt?: string | undefined;
  /** Additional system instructions to append for this turn. */
  readonly injectedInstructions?: string | undefined;
  /** Whether to veto and cancel the turn before executing. */
  readonly veto?: boolean | undefined;
  /** Reason for vetoing the turn. */
  readonly vetoReason?: string | undefined;
}

/**
 * Hook invoked before a turn commences.
 */
export type BeforeTurnHook = (
  context: BeforeTurnContext,
) => Promise<BeforeTurnResult | void> | BeforeTurnResult | void;

/**
 * Context provided after a turn finishes.
 */
export interface AfterTurnContext {
  /** One-based index of the concluded turn. */
  readonly turnIndex: number;
  /** Reason why the turn finished. */
  readonly finishReason: TurnFinishReason;
  /** Cumulative token usage for the turn. */
  readonly totalUsage: StepTokenUsage;
}

/**
 * Hook invoked after a turn completes.
 */
export type AfterTurnHook = (
  context: AfterTurnContext,
) => Promise<void> | void;

/**
 * Context provided when evaluating whether the agent loop should terminate.
 */
export interface ShouldStopContext {
  /** Active turn index. */
  readonly turnIndex: number;
  /** Candidate finish reason. */
  readonly finishReason: TurnFinishReason;
  /** Conversational message snapshot for the current session. */
  readonly transcript?: readonly ModelMessage[] | undefined;
}

/**
 * Decision whether the engine should stop or continue iterating.
 */
export type StopDecision =
  | { readonly shouldStop: true }
  | { readonly shouldStop: false; readonly reminderPrompt: string };

/**
 * Hook invoked when the agent proposes to stop.
 */
export type ShouldStopHook = (
  context: ShouldStopContext,
) => Promise<StopDecision> | StopDecision;

/**
 * Context provided when authorizing a proposed tool call.
 */
export interface AuthorizeToolContext {
  /** Name of the tool requesting execution. */
  readonly toolName: string;
  /** Parameters supplied by the model for the tool call. */
  readonly parameters: unknown;
  /** Active working directory for the thread. */
  readonly workingDirectory: string;
}

/**
 * Authorization decision outcome returned by the authorization hook.
 */
export type PermissionDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: string };

/**
 * Hook invoked before tool execution to determine authorization.
 */
export type AuthorizeToolHook = (
  context: AuthorizeToolContext,
) => Promise<PermissionDecision> | PermissionDecision;

/**
 * Context provided when an unhandled error occurs during execution.
 */
export interface ErrorContext {
  /** The error instance encountered. */
  readonly error: Error;
  /** Origin subsystem where the error occurred. */
  readonly origin: ErrorOrigin;
  /** Active turn index when the error occurred. */
  readonly turnIndex: number;
  /** Associated tool name if the error happened during tool execution. */
  readonly toolName?: string | undefined;
  /** Associated hook name if the error happened during hook execution. */
  readonly hookName?: string | undefined;
  /** Whether the error is fatal and halts the turn. */
  readonly isFatal: boolean;
}

/**
 * Hook invoked when an error occurs during turn execution.
 */
export type ErrorHook = (
  context: ErrorContext,
) => Promise<void> | void;

/**
 * Composite hooks collection provided by products to customize agent core behavior.
 */
export interface AgentHooks {
  /** Invoked before a turn begins. Can augment prompt, inject instructions, or veto. */
  readonly onBeforeTurn?: BeforeTurnHook | undefined;
  /** Invoked after a turn finishes with final usage and finish reason. */
  readonly onAfterTurn?: AfterTurnHook | undefined;
  /** Invoked to evaluate whether the autonomous agent loop is permitted to terminate. */
  readonly onShouldStop?: ShouldStopHook | undefined;
  /** Invoked to authorize proposed tool execution. Fails closed by default if omitted. */
  readonly onAuthorizeTool?: AuthorizeToolHook | undefined;
  /** Invoked when an unhandled error occurs during turn execution. */
  readonly onError?: ErrorHook | undefined;
}
