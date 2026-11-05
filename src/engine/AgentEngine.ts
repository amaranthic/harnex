/**
 * @fileoverview Stateful microkernel class orchestrating turns, tools, and lifecycle hooks.
 * @packageDocumentation
 */

import type { HernexModelInput, ModelMessage } from "../model/types.js";
import type { ProviderRegistry } from "../model/ProviderRegistry.js";
import type { AgentEvent } from "../events/index.js";
import {
  FileThreadStore,
  type AgentReasoningLevel,
  type ThreadStore,
} from "../threads/index.js";
import {
  FileCheckpointStore,
  type CheckpointStore,
} from "../checkpoints/index.js";
import type { ToolRegistry } from "../tools/index.js";
import { TaskManager } from "../tools/index.js";
import type { AgentEngineConfig, RunTurnOptions } from "./engineConfig.js";
import { runTurn } from "./runTurn.js";

/**
 * The core agent engine microkernel.
 *
 * Encapsulates thread state, conversational message history, tool registry access,
 * autonomous multi-step turn execution, and checkpoint/rollback management.
 */
export class AgentEngine {
  private readonly config: AgentEngineConfig;
  private readonly conversationMessages: ModelMessage[];
  private readonly resolvedThreadStore: ThreadStore | undefined;
  private readonly resolvedCheckpointStore: CheckpointStore | undefined;
  private readonly resolvedTaskManager: TaskManager;
  private readonly isPersistActive: boolean;
  private readonly isCheckpointActive: boolean;
  private turnCounter = 0;
  private isTurnRunning = false;
  private currentTurnAbortController: AbortController | null = null;

  /**
   * Instantiates a new AgentEngine.
   *
   * @param config - Static engine configuration options.
   * @param initialMessages - Optional previous conversation messages to seed or resume the session.
   * @param initialTurnCount - Optional initial turn count (e.g. from persisted thread metadata).
   */
  public constructor(
    config: AgentEngineConfig,
    initialMessages?: readonly ModelMessage[],
    initialTurnCount?: number,
  ) {
    this.conversationMessages = initialMessages ? [...initialMessages] : [];
    this.turnCounter = initialTurnCount ?? 0;

    // Evaluate persistence: default is false (ephemeral) unless explicitly set or store provided
    this.isPersistActive = Boolean(config.persist ?? Boolean(config.threadStore));

    // Enforce invariant: checkpoints require persistent thread storage
    if (config.checkpoint && !this.isPersistActive) {
      throw new Error(
        "Checkpoints require persistent thread storage (`persist: true` or `threadStore`). Checkpointing cannot be enabled for ephemeral sessions.",
      );
    }

    // Resolve checkpoint active state
    this.isCheckpointActive =
      this.isPersistActive && Boolean(config.checkpoint ?? Boolean(config.checkpointStore));

    // Resolve stores according to persistence flags
    if (this.isPersistActive) {
      this.resolvedThreadStore = config.threadStore ?? new FileThreadStore();
    } else {
      this.resolvedThreadStore = undefined;
    }

    if (this.isCheckpointActive) {
      this.resolvedCheckpointStore =
        config.checkpointStore ?? new FileCheckpointStore();
    } else {
      this.resolvedCheckpointStore = undefined;
    }

    this.resolvedTaskManager =
      config.taskManager ??
      new TaskManager({
        threadId: config.threadId,
        workingDirectory: config.workingDirectory,
        persist: this.isPersistActive,
      });

    this.config = {
      ...config,
      threadStore: this.resolvedThreadStore,
      checkpointStore: this.resolvedCheckpointStore,
      taskManager: this.resolvedTaskManager,
      persist: this.isPersistActive,
      checkpoint: this.isCheckpointActive,
    };
  }

  /**
   * Resumes an engine instance from an existing thread in a ThreadStore.
   *
   * @param threadId - The identifier of the thread to load.
   * @param options - Configuration options for resuming.
   * @returns An instantiated AgentEngine loaded with the thread's messages and metadata.
   */
  public static async fromThread(
    threadId: string,
    options: {
      readonly threadStore: ThreadStore;
      readonly checkpointStore?: CheckpointStore;
      readonly tools: ToolRegistry;
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly model?: HernexModelInput;
      readonly providerRegistry?: ProviderRegistry;
      readonly taskManager?: TaskManager;
      readonly instructions?: string;
      readonly reasoning?: AgentReasoningLevel;
      readonly maxSteps?: number;
      readonly abortSignal?: AbortSignal;
      readonly checkpoint?: boolean;
    },
  ): Promise<AgentEngine> {
    const metadata = await options.threadStore.getThread(threadId);
    if (!metadata) {
      throw new Error(`Thread not found: "${threadId}"`);
    }

    const messages = await options.threadStore.getMessages(threadId);

    const resolvedModel = options.model ?? metadata.model;
    if (!resolvedModel) {
      throw new Error(
        `Thread "${threadId}" was stored without a model string identifier. An explicit model must be provided in fromThread options.`,
      );
    }

    return new AgentEngine(
      {
        threadId,
        workingDirectory: metadata.workingDirectory,
        model: resolvedModel,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        instructions: options.instructions,
        tools: options.tools,
        providerRegistry: options.providerRegistry,
        taskManager: options.taskManager,
        reasoning:
          (metadata.reasoning as AgentReasoningLevel) ?? options.reasoning,
        maxSteps: options.maxSteps,
        persist: true,
        checkpoint: options.checkpoint ?? Boolean(options.checkpointStore),
        threadStore: options.threadStore,
        checkpointStore: options.checkpointStore,
        abortSignal: options.abortSignal,
      },
      messages,
      metadata.turnCount,
    );
  }

  /**
   * Creates a new thread in the thread store and initializes a corresponding AgentEngine.
   *
   * @param options - Thread creation and engine configuration options.
   * @returns An instantiated AgentEngine for the newly created thread.
   */
  public static async create(options: {
    readonly threadStore: ThreadStore;
    readonly checkpointStore?: CheckpointStore;
    readonly workingDirectory: string;
    readonly model: HernexModelInput;
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly providerRegistry?: ProviderRegistry;
    readonly taskManager?: TaskManager;
    readonly title?: string;
    readonly tags?: readonly string[];
    readonly instructions?: string;
    readonly tools: ToolRegistry;
    readonly reasoning?: AgentReasoningLevel;
    readonly maxSteps?: number;
    readonly abortSignal?: AbortSignal;
    readonly checkpoint?: boolean;
  }): Promise<AgentEngine> {
    const metadata = await options.threadStore.createThread({
      workingDirectory: options.workingDirectory,
      model: typeof options.model === "string" ? options.model : undefined,
      reasoning: options.reasoning,
      title: options.title,
      tags: options.tags,
    });

    return new AgentEngine(
      {
        threadId: metadata.id,
        workingDirectory: options.workingDirectory,
        model: options.model,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        providerRegistry: options.providerRegistry,
        taskManager: options.taskManager,
        instructions: options.instructions,
        tools: options.tools,
        reasoning: options.reasoning,
        maxSteps: options.maxSteps,
        persist: true,
        checkpoint: options.checkpoint ?? Boolean(options.checkpointStore),
        threadStore: options.threadStore,
        checkpointStore: options.checkpointStore,
        abortSignal: options.abortSignal,
      },
      [],
      0,
    );
  }

  /**
   * Gets the thread session identifier.
   */
  public get threadId(): string {
    return this.config.threadId;
  }

  /**
   * Gets the active workspace root directory path.
   */
  public get workingDirectory(): string {
    return this.config.workingDirectory;
  }

  /**
   * Gets the tool registry bound to this engine instance.
   */
  public get tools(): ToolRegistry {
    return this.config.tools;
  }

  /**
   * Gets a readonly snapshot of the current conversational messages.
   */
  public get messages(): readonly ModelMessage[] {
    return [...this.conversationMessages];
  }

  /**
   * Gets the number of completed or executed turns in this session.
   */
  public get currentTurn(): number {
    return this.turnCounter;
  }

  /**
   * Gets the top-level reasoning level configured on the engine, if any.
   */
  public get reasoning(): AgentReasoningLevel | undefined {
    return this.config.reasoning;
  }

  /**
   * Whether thread state and transcripts are actively persisted to disk.
   */
  public get isPersisted(): boolean {
    return this.isPersistActive;
  }

  /**
   * Whether content-addressed file delta checkpointing is actively enabled.
   */
  public get isCheckpointEnabled(): boolean {
    return this.isCheckpointActive;
  }

  /**
   * Gets the TaskManager instance associated with this engine session.
   */
  public get taskManager(): TaskManager {
    return this.resolvedTaskManager;
  }

  /**
   * Gets the persistent ThreadStore attached to this engine, if any.
   */
  public get threadStore(): ThreadStore | undefined {
    return this.resolvedThreadStore;
  }

  /**
   * Gets the CheckpointStore attached to this engine, if any.
   */
  public get checkpointStore(): CheckpointStore | undefined {
    return this.resolvedCheckpointStore;
  }

  /**
   * Aborts the currently active turn, if any.
   *
   * @param reason - Optional cancellation reason.
   */
  public abort(reason?: string): void {
    if (this.currentTurnAbortController && this.isTurnRunning) {
      this.currentTurnAbortController.abort(reason ?? "Turn aborted by caller");
    }
  }

  /**
   * Appends an external message into the conversation history.
   * If threadStore is present, appends to the persistent transcript first.
   *
   * @param message - The ModelMessage to append.
   */
  public async addMessage(message: ModelMessage): Promise<void> {
    if (this.isTurnRunning) {
      throw new Error(
        "Cannot add messages to conversation history while an active turn is running.",
      );
    }
    if (this.resolvedThreadStore) {
      await this.resolvedThreadStore.appendTranscript(this.threadId, {
        type: "modelMessage",
        message,
        timestamp: Date.now(),
      });
    }
    this.conversationMessages.push(message);
  }

  /**
   * Executes a single autonomous agent turn.
   *
   * Turn reservation occurs lazily when the returned async generator is first consumed.
   *
   * @param promptOrOptions - User prompt string or full turn execution options.
   * @returns An async generator yielding stream deltas, tool lifecycle, and turn events.
   * @throws Error if another turn is actively running on this engine instance when iteration begins.
   */
  public runTurn(
    promptOrOptions: string | RunTurnOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    const rawOptions: RunTurnOptions =
      typeof promptOrOptions === "string"
        ? { userPrompt: promptOrOptions }
        : promptOrOptions;

    return this.executeTurn(rawOptions);
  }

  /**
   * Internal generator driving turn execution and tracking concurrency state lazily on consumption.
   */
  private async *executeTurn(
    rawOptions: RunTurnOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    if (this.isTurnRunning) {
      throw new Error(
        `AgentEngine for thread "${this.threadId}" is already running an active turn. Simultaneous turns on a single engine instance are not permitted.`,
      );
    }

    this.isTurnRunning = true;
    this.turnCounter++;
    this.currentTurnAbortController = new AbortController();

    const turnAbortSignals: AbortSignal[] = [
      this.currentTurnAbortController.signal,
    ];
    if (this.config.abortSignal) {
      turnAbortSignals.push(this.config.abortSignal);
    }
    if (rawOptions.abortSignal) {
      turnAbortSignals.push(rawOptions.abortSignal);
    }
    const combinedSignal = AbortSignal.any(turnAbortSignals);

    const options: RunTurnOptions = {
      ...rawOptions,
      turnIndex: rawOptions.turnIndex ?? this.turnCounter,
      abortSignal: combinedSignal,
    };

    try {
      yield* runTurn(this.config, options, this.conversationMessages);
    } finally {
      this.isTurnRunning = false;
      this.currentTurnAbortController = null;
    }
  }
}
