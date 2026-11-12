/**
 * @fileoverview Threads, transcript entries, and store contracts.
 * @packageDocumentation
 */

import type { StepTokenUsage } from "../events/stepEvents.js";
import type { ModelMessage } from "../model/types.js";

/**
 * Thread lifecycle status.
 */
export type ThreadStatus = "idle" | "running" | "error";

/**
 * Supported reasoning effort levels in the native Vercel AI SDK v7.
 */
export type AgentReasoningLevel =
  | "provider-default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * Persisted summary metadata for a conversational thread.
 */
export interface ThreadMetadata {
  /** Schema version identifier. */
  readonly version: 1;
  /** Unique safe thread identifier. */
  readonly id: string;
  /** ISO 8601 creation timestamp string. */
  readonly createdAt: string;
  /** ISO 8601 last update timestamp string. */
  readonly updatedAt: string;
  /** Optional human-readable title. */
  readonly title?: string | null | undefined;
  /** Categorization tags for thread discovery. */
  readonly tags: readonly string[];
  /** Canonical workspace root directory for this thread. */
  readonly workingDirectory: string;
  /** Model identifier bound to this thread. */
  readonly model?: string | null | undefined;
  /** Provider identifier bound to this thread. */
  readonly provider?: string | null | undefined;
  /** Optional reasoning effort level. */
  readonly reasoning?: string | null | undefined;
  /** Cumulative count of executed agent turns. */
  readonly turnCount: number;
  /** Current lifecycle status of the thread. */
  readonly status: ThreadStatus;
  /** Highest sequence number written to the append-only transcript. */
  readonly activeTranscriptSequence: number;
  /** Preview snippet of the most recent user prompt. */
  readonly lastUserPromptPreview?: string | null | undefined;
  /** Cumulative token consumption for the thread. */
  readonly usage: StepTokenUsage;
}

/**
 * Authoritative append-only log entries recorded in transcript.jsonl.
 */
export type TranscriptEntry =
  | {
      readonly type: "turnStarted";
      readonly sequence: number;
      readonly turnIndex: number;
      readonly userPrompt: string;
      readonly timestamp: number;
    }
  | {
      readonly type: "modelMessage";
      readonly sequence: number;
      readonly message: ModelMessage;
      readonly timestamp: number;
    }
  | {
      readonly type: "toolCall";
      readonly sequence: number;
      readonly callId: string;
      readonly toolName: string;
      readonly parameters: unknown;
      readonly timestamp: number;
    }
  | {
      readonly type: "toolResult";
      readonly sequence: number;
      readonly callId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError: boolean;
      readonly timestamp: number;
    }
  | {
      readonly type: "checkpointRef";
      readonly sequence: number;
      readonly checkpointId: string;
      readonly checkpointSequence: number;
      readonly timestamp: number;
    }
  | {
      readonly type: "turnFinished";
      readonly sequence: number;
      readonly turnIndex: number;
      readonly finishReason: string;
      readonly usage?: StepTokenUsage | undefined;
      readonly timestamp: number;
    };

/**
 * Input entry for appending to a thread's transcript before sequence assignment.
 */
export type NewTranscriptEntry =
  | {
      readonly type: "turnStarted";
      readonly turnIndex: number;
      readonly userPrompt: string;
      readonly timestamp: number;
    }
  | {
      readonly type: "modelMessage";
      readonly message: ModelMessage;
      readonly timestamp: number;
    }
  | {
      readonly type: "toolCall";
      readonly callId: string;
      readonly toolName: string;
      readonly parameters: unknown;
      readonly timestamp: number;
    }
  | {
      readonly type: "toolResult";
      readonly callId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError: boolean;
      readonly timestamp: number;
    }
  | {
      readonly type: "checkpointRef";
      readonly checkpointId: string;
      readonly checkpointSequence: number;
      readonly timestamp: number;
    }
  | {
      readonly type: "turnFinished";
      readonly turnIndex: number;
      readonly finishReason: string;
      readonly usage?: StepTokenUsage | undefined;
      readonly timestamp: number;
    };

/**
 * Parameters for creating a new thread.
 */
export interface CreateThreadInput {
  /** Optional custom safe identifier. If omitted, a random UUID is generated. */
  readonly id?: string | undefined;
  /** Optional human-readable title. */
  readonly title?: string | undefined;
  /** Categorization tags. */
  readonly tags?: readonly string[] | undefined;
  /** Canonical workspace root directory. */
  readonly workingDirectory: string;
  /** Target model identifier. */
  readonly model?: string | undefined;
  /** Target provider identifier. */
  readonly provider?: string | undefined;
  /** Target reasoning effort level. */
  readonly reasoning?: string | undefined;
}

/**
 * Allowed mutation patch parameters for updating thread metadata.
 */
export interface UpdateThreadInput {
  /** Updated title or null to clear. */
  readonly title?: string | null | undefined;
  /** Updated tags list. */
  readonly tags?: readonly string[] | undefined;
  /** Updated model identifier or null to clear. */
  readonly model?: string | null | undefined;
  /** Updated provider identifier or null to clear. */
  readonly provider?: string | null | undefined;
  /** Updated reasoning effort level or null to clear. */
  readonly reasoning?: string | null | undefined;
}

/**
 * Authoritative thread store contract managing thread metadata and transcripts.
 */
export interface ThreadStore {
  /**
   * Creates a new persistent thread.
   *
   * @param input - Thread creation options including workspace directory.
   * @returns Newly created thread metadata snapshot.
   */
  createThread(input: CreateThreadInput): Promise<ThreadMetadata>;

  /**
   * Retrieves metadata for an existing thread.
   *
   * @param threadId - Safe thread identifier.
   * @returns Thread metadata or undefined if not found.
   */
  getThread(threadId: string): Promise<ThreadMetadata | undefined>;

  /**
   * Lists available thread metadata snapshots matching optional filters.
   *
   * @param options - Filtering and pagination options.
   * @returns Readonly array of thread metadata summaries.
   */
  listThreads(options?: {
    readonly workingDirectory?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ThreadMetadata[]>;

  /**
   * Updates an existing thread's metadata fields using an explicit patch.
   *
   * @param threadId - Safe thread identifier.
   * @param patch - Allowed metadata patch fields.
   * @returns Updated thread metadata snapshot.
   */
  updateThread(
    threadId: string,
    patch: UpdateThreadInput,
  ): Promise<ThreadMetadata>;

  /**
   * Deletes a thread directory and its associated persistent artifacts.
   *
   * @param threadId - Safe thread identifier.
   * @returns True if thread existed and was removed, false otherwise.
   */
  deleteThread(threadId: string): Promise<boolean>;

  /**
   * Appends an entry to the append-only thread transcript log under thread lock.
   *
   * @param threadId - Safe thread identifier.
   * @param entry - New unsequenced transcript entry.
   * @returns Sequenced and persisted transcript entry.
   */
  appendTranscript(
    threadId: string,
    entry: NewTranscriptEntry,
  ): Promise<TranscriptEntry>;

  /**
   * Reads the full append-only transcript log for a thread.
   *
   * @param threadId - Safe thread identifier.
   * @returns Readonly array of sequenced transcript entries.
   */
  getTranscript(threadId: string): Promise<readonly TranscriptEntry[]>;

  /**
   * Projects conversational model messages from the authoritative transcript.
   *
   * @param threadId - Safe thread identifier.
   * @returns Readonly array of ModelMessage items for model invocation.
   */
  getMessages(threadId: string): Promise<readonly ModelMessage[]>;
}
