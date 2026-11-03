/**
 * @fileoverview Stateful microkernel class orchestrating turns, tools, and lifecycle hooks.
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import type { LanguageModel, ModelMessage } from "../model/types.js";
import type { AgentEvent } from "../events/index.js";
import {
  FileThreadStore,
  type AgentReasoningLevel,
  type ThreadMetadata,
  type ThreadStore,
  type TranscriptEntry,
  type UpdateThreadInput,
} from "../threads/index.js";
import {
  FileCheckpointStore,
  type CheckpointRecord,
  type CheckpointStore,
  type RestorePlan,
  type RestoreResult,
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
   */
  public constructor(
    config: AgentEngineConfig,
    initialMessages?: readonly ModelMessage[],
  ) {
    this.conversationMessages = initialMessages ? [...initialMessages] : [];
    this.turnCounter = this.conversationMessages.filter(
      (m) => m.role === "user",
    ).length;

    // Evaluate persistence: default is false (ephemeral) unless explicitly set or store provided
    this.isPersistActive = Boolean(config.persist ?? Boolean(config.threadStore));

    // Enforce invariant: checkpoints require persistent thread identity; if persist is false, checkpoint is strictly false
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

    return new AgentEngine(
      {
        threadId,
        workingDirectory: metadata.workingDirectory,
        model: metadata.model ?? "openai/gpt-4o",
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        instructions: options.instructions,
        tools: options.tools,
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
    readonly model: string | LanguageModel;
    readonly apiKey: string;
    readonly baseUrl: string;
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
   * Appends an external message into the in-memory conversation history.
   *
   * @param message - The ModelMessage to append.
   */
  public addMessage(message: ModelMessage): void {
    if (this.isTurnRunning) {
      throw new Error(
        "Cannot add messages to conversation history while an active turn is running.",
      );
    }
    this.conversationMessages.push(message);
  }

  /**
   * Clears all conversational messages from the active thread history.
   */
  public clearMessages(): void {
    if (this.isTurnRunning) {
      throw new Error(
        "Cannot clear conversation messages while an active turn is running.",
      );
    }
    this.conversationMessages.length = 0;
  }

  /**
   * Fetches persisted metadata for the current thread session.
   *
   * @returns The ThreadMetadata object if persisted, or undefined if ephemeral.
   */
  public async getMetadata(): Promise<ThreadMetadata | undefined> {
    if (!this.resolvedThreadStore) {
      return undefined;
    }
    return await this.resolvedThreadStore.getThread(this.threadId);
  }

  /**
   * Updates metadata fields for the active thread session.
   *
   * @param patch - Partial metadata attributes to update.
   * @returns The updated ThreadMetadata object, or undefined if ephemeral.
   */
  public async updateMetadata(
    patch: UpdateThreadInput,
  ): Promise<ThreadMetadata | undefined> {
    if (!this.resolvedThreadStore) {
      return undefined;
    }
    return await this.resolvedThreadStore.updateThread(
      this.threadId,
      patch,
    );
  }

  /**
   * Loads the full authoritative transcript log for this thread.
   *
   * @returns Readonly array of TranscriptEntry records.
   */
  public async getTranscript(): Promise<readonly TranscriptEntry[]> {
    if (!this.resolvedThreadStore) {
      return [];
    }
    return await this.resolvedThreadStore.getTranscript(this.threadId);
  }

  /**
   * Lists all recorded checkpoints for the active thread session.
   *
   * @returns Readonly array of CheckpointRecord snapshots.
   */
  public async listCheckpoints(): Promise<readonly CheckpointRecord[]> {
    if (!this.resolvedCheckpointStore) {
      return [];
    }
    return await this.resolvedCheckpointStore.listCheckpoints(this.threadId);
  }

  /**
   * Generates a dry-run restore plan for a specific checkpoint with external conflict detection.
   *
   * @param checkpointId - Checkpoint identifier to plan restore for.
   * @returns A RestorePlan detailing file operations and conflict flags.
   */
  public async planRestore(checkpointId: string): Promise<RestorePlan> {
    if (!this.resolvedCheckpointStore) {
      throw new Error(
        `Cannot plan restore: checkpoints are not enabled on engine thread "${this.threadId}".`,
      );
    }
    return await this.resolvedCheckpointStore.planRestore(
      this.threadId,
      checkpointId,
      this.workingDirectory,
    );
  }

  /**
   * Reverts workspace files to the exact state captured in a past checkpoint snapshot.
   *
   * @param checkpointId - Checkpoint identifier to restore.
   * @param options - Restore options, such as `{ force: true }` to overwrite uncommitted external edits.
   * @returns A RestoreResult detailing restored files and ignored conflicts.
   */
  public async restoreCheckpoint(
    checkpointId: string,
    options?: { readonly force?: boolean },
  ): Promise<RestoreResult> {
    if (!this.resolvedCheckpointStore) {
      throw new Error(
        `Cannot restore checkpoint: checkpoints are not enabled on engine thread "${this.threadId}".`,
      );
    }
    return await this.resolvedCheckpointStore.restoreCheckpoint(
      this.threadId,
      checkpointId,
      this.workingDirectory,
      options,
    );
  }

  /**
   * Programmatically creates a manual checkpoint record for the active session.
   *
   * @param options - Label and optional file list for the snapshot.
   * @returns The created CheckpointRecord.
   */
  public async createCheckpoint(options: {
    readonly label?: string;
    readonly files?: readonly string[];
  }): Promise<CheckpointRecord> {
    if (!this.resolvedCheckpointStore) {
      throw new Error(
        `Cannot create checkpoint: checkpoints are not enabled on engine thread "${this.threadId}".`,
      );
    }

    return await this.resolvedCheckpointStore.createCheckpoint(this.threadId, {
      id: `cp_${Date.now()}_${randomUUID().slice(0, 8)}`,
      threadId: this.threadId,
      turnIndex: this.turnCounter,
      toolName: "manualCheckpoint",
      timestamp: Date.now(),
      coverage: options.files && options.files.length > 0 ? "partial" : "complete",
      files: (options.files ?? []).map((file) => ({
        relativePath: file,
        status: "~",
      })),
    });
  }

  /**
   * Executes a single autonomous agent turn.
   *
   * @param promptOrOptions - User prompt string or full turn execution options.
   * @returns An async generator yielding stream deltas, tool lifecycle, and turn events.
   * @throws Error if another turn is currently running on this engine instance.
   */
  public runTurn(
    promptOrOptions: string | RunTurnOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    if (this.isTurnRunning) {
      throw new Error(
        `AgentEngine for thread "${this.threadId}" is already running an active turn. Simultaneous turns on a single engine instance are not permitted.`,
      );
    }

    this.isTurnRunning = true;
    this.turnCounter++;
    this.currentTurnAbortController = new AbortController();

    const options: RunTurnOptions =
      typeof promptOrOptions === "string"
        ? {
            userPrompt: promptOrOptions,
            turnIndex: this.turnCounter,
            abortSignal: this.currentTurnAbortController.signal,
          }
        : {
            ...promptOrOptions,
            turnIndex: promptOrOptions.turnIndex ?? this.turnCounter,
            abortSignal:
              promptOrOptions.abortSignal ??
              this.currentTurnAbortController.signal,
          };

    return this.executeTurn(options);
  }

  /**
   * Internal generator driving turn execution and tracking concurrency state.
   */
  private async *executeTurn(
    options: RunTurnOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    try {
      yield* runTurn(this.config, options, this.conversationMessages);
    } finally {
      this.isTurnRunning = false;
      this.currentTurnAbortController = null;
    }
  }
}
