/**
 * @fileoverview Configuration contracts for instantiating and running the AgentEngine.
 * @packageDocumentation
 */

import type { LanguageModel } from "../model/types.js";
import type { AgentHooks } from "../hooks/index.js";
import type {
  AgentReasoningLevel,
  ThreadCheckpointConfig,
  ThreadStore,
} from "../threads/index.js";
import type { CheckpointStore } from "../checkpoints/index.js";
import type { TaskManager } from "../tools/index.js";
import type { ToolRegistry } from "../tools/index.js";

/**
 * Static configuration options for instantiating an AgentEngine.
 */
export interface AgentEngineConfig {
  /**
   * Unique identifier of the conversational thread session.
   */
  readonly threadId: string;

  /**
   * Root working directory for tool operations and relative path resolution.
   */
  readonly workingDirectory: string;

  /**
   * Model specification formatted as "provider/model_id" or a pre-instantiated LanguageModel.
   */
  readonly model: string | LanguageModel;

  /**
   * Mandatory API key used for resolving provider credentials.
   */
  readonly apiKey: string;

  /**
   * Mandatory base URL for the model provider endpoint.
   */
  readonly baseUrl: string;

  /**
   * Optional system instructions passed to the model across all turns.
   */
  readonly instructions?: string | undefined;

  /**
   * Tool registry supplying available agent tools and schema definitions.
   */
  readonly tools: ToolRegistry;

  /**
   * Optional TaskManager instance for background shell process management.
   */
  readonly taskManager?: TaskManager | undefined;

  /**
   * Optional consumer lifecycle and authorization hooks.
   */
  readonly hooks?: AgentHooks | undefined;

  /**
   * Optional top-level reasoning/thinking effort level for the model.
   * Controls how much reasoning the model performs before generating a response.
   */
  readonly reasoning?: AgentReasoningLevel | undefined;

  /**
   * Maximum autonomous tool-execution steps allowed within a single turn before stopping.
   * Defaults to 25.
   */
  readonly maxSteps?: number | undefined;

  /**
   * Whether to persist the conversation thread, metadata, and transcript to disk.
   * Defaults to false (completely in-memory and ephemeral).
   */
  readonly persist?: boolean | undefined;

  /**
   * Whether to enable content-addressed file delta checkpoints.
   * Invariant: Requires `persist: true`. If `persist` is false, checkpointing is strictly disabled.
   * Defaults to false.
   */
  readonly checkpoint?: boolean | ThreadCheckpointConfig | undefined;

  /**
   * Optional global abort signal for cancelling in-flight engine operations.
   */
  readonly abortSignal?: AbortSignal | undefined;

  /**
   * Optional custom persistent ThreadStore backing this engine instance.
   * If omitted and `persist: true`, a FileThreadStore is instantiated automatically.
   */
  readonly threadStore?: ThreadStore | undefined;

  /**
   * Optional custom CheckpointStore backing this engine instance.
   * If omitted and `persist: true` & `checkpoint: true`, a FileCheckpointStore is instantiated automatically.
   */
  readonly checkpointStore?: CheckpointStore | undefined;
}

/**
 * Options provided when executing a single autonomous turn via runTurn.
 */
export interface RunTurnOptions {
  /**
   * The user message or prompt initiating the turn.
   */
  readonly userPrompt: string;

  /**
   * One-based sequence index for the active turn within the thread session.
   * Defaults to 1 if not specified.
   */
  readonly turnIndex?: number;

  /**
   * Optional per-turn instructions appended to or overriding base instructions.
   */
  readonly instructions?: string;

  /**
   * Optional per-turn reasoning effort level overriding the engine-level setting.
   */
  readonly reasoning?: AgentReasoningLevel;

  /**
   * Optional per-turn model override formatted as "provider/model_id" or a LanguageModel.
   */
  readonly model?: string | LanguageModel;

  /**
   * Optional API key override for the per-turn model.
   */
  readonly apiKey?: string;

  /**
   * Optional base URL override for the per-turn model endpoint.
   */
  readonly baseUrl?: string;

  /**
   * Maximum autonomous steps for this specific turn.
   */
  readonly maxSteps?: number;

  /**
   * Optional abort signal for cancelling this specific turn.
   */
  readonly abortSignal?: AbortSignal;

  /**
   * Optional product-defined metadata passed through to turn hooks.
   */
  readonly metadataOverride?: Record<string, unknown>;
}
