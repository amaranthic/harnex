/**
 * @fileoverview Filesystem-backed ThreadStore with durable thread.json and transcript.jsonl.
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { StepTokenUsage } from "../events/stepEvents.js";
import type { ModelMessage } from "../model/types.js";
import { atomicWriteFile } from "../storage/atomicFile.js";
import {
  resolveHomeDirectory,
  type ResolveHomeDirectoryOptions,
} from "../storage/homeDirectory.js";
import { appendJsonl, readJsonl } from "../storage/jsonl.js";
import { withFileLock } from "../storage/lock.js";
import type {
  CreateThreadInput,
  NewTranscriptEntry,
  ThreadMetadata,
  ThreadStatus,
  ThreadStore,
  TranscriptEntry,
  UpdateThreadInput,
} from "./types.js";

/** Regular expression for validating safe thread identifiers. */
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * File-backed ThreadStore implementation managing thread directories,
 * metadata snapshots, and append-only transcripts.
 */
export class FileThreadStore implements ThreadStore {
  private readonly rootDir: string;

  /**
   * Initializes a new FileThreadStore instance.
   *
   * @param options - Optional configuration options including custom home directory.
   */
  public constructor(options?: ResolveHomeDirectoryOptions) {
    this.rootDir = resolveHomeDirectory(options);
  }

  /**
   * Validates that a thread identifier conforms to safe naming grammar.
   *
   * @param threadId - Candidate identifier to validate.
   * @throws Error if threadId is empty, invalid, or contains path traversal characters.
   */
  private validateThreadId(threadId: string): void {
    if (
      !threadId ||
      typeof threadId !== "string" ||
      !THREAD_ID_PATTERN.test(threadId)
    ) {
      throw new Error(`Invalid thread identifier: "${threadId}"`);
    }
  }

  /**
   * Resolves the canonical directory for a given thread identifier.
   *
   * @param threadId - Safe thread identifier.
   * @returns Absolute path to the thread directory.
   */
  private getThreadDir(threadId: string): string {
    this.validateThreadId(threadId);
    return path.join(this.rootDir, "threads", threadId);
  }

  /**
   * Resolves the out-of-directory lock file path for a thread.
   *
   * @param threadId - Safe thread identifier.
   * @returns Absolute path to the thread lock file located in `<rootDir>/locks/threads/<threadId>.lock`.
   */
  private getLockPath(threadId: string): string {
    this.validateThreadId(threadId);
    return path.join(this.rootDir, "locks", "threads", `${threadId}.lock`);
  }

  /**
   * Creates a new thread directory and initializes its `thread.json` metadata.
   *
   * @param input - Thread creation parameters.
   * @returns Newly created thread metadata.
   */
  public async createThread(input: CreateThreadInput): Promise<ThreadMetadata> {
    const id = input.id ?? randomUUID();
    this.validateThreadId(id);

    const threadsParent = path.join(this.rootDir, "threads");
    await mkdir(threadsParent, { recursive: true });

    const threadDir = this.getThreadDir(id);
    if (existsSync(threadDir)) {
      throw new Error(`Thread already exists: "${id}"`);
    }

    try {
      await mkdir(threadDir, { recursive: false });
    } catch (mkdirError) {
      const error = mkdirError as { code?: string };
      if (error?.code === "EEXIST") {
        throw new Error(`Thread already exists: "${id}"`);
      }
      throw mkdirError;
    }

    const now = new Date().toISOString();
    const initialUsage: StepTokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
    };

    const metadata: ThreadMetadata = {
      version: 1,
      id,
      createdAt: now,
      updatedAt: now,
      title: input.title,
      tags: input.tags ?? [],
      workingDirectory: input.workingDirectory,
      model: input.model,
      provider: input.provider,
      reasoning: input.reasoning,
      turnCount: 0,
      status: "idle",
      activeTranscriptSequence: 0,
      usage: initialUsage,
    };

    const metadataPath = path.join(threadDir, "thread.json");
    await atomicWriteFile(metadataPath, JSON.stringify(metadata, null, 2));

    return metadata;
  }

  /**
   * Internal unlocked helper to read thread metadata without acquiring a file lock.
   *
   * @param threadId - Safe thread identifier.
   * @returns Thread metadata snapshot or undefined if not found.
   */
  private async getThreadUnlocked(
    threadId: string,
  ): Promise<ThreadMetadata | undefined> {
    const metadataPath = path.join(this.getThreadDir(threadId), "thread.json");
    if (!existsSync(metadataPath)) {
      return undefined;
    }
    const raw = await readFile(metadataPath, "utf-8");
    return JSON.parse(raw) as ThreadMetadata;
  }

  /**
   * Retrieves metadata for an existing thread under file lock.
   *
   * @param threadId - Safe thread identifier.
   * @returns Thread metadata snapshot or undefined if not found.
   */
  public async getThread(
    threadId: string,
  ): Promise<ThreadMetadata | undefined> {
    this.validateThreadId(threadId);
    const lockPath = this.getLockPath(threadId);
    return await withFileLock(lockPath, async () => {
      return this.getThreadUnlocked(threadId);
    });
  }

  /**
   * Lists available thread metadata snapshots matching optional filters.
   *
   * @param options - Filtering and pagination options.
   * @returns Readonly array of thread metadata summaries.
   */
  public async listThreads(options?: {
    readonly workingDirectory?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ThreadMetadata[]> {
    const threadsRoot = path.join(this.rootDir, "threads");
    if (!existsSync(threadsRoot)) {
      return [];
    }

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(threadsRoot, { withFileTypes: true });
    const list: ThreadMetadata[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && THREAD_ID_PATTERN.test(entry.name)) {
        const thread = await this.getThread(entry.name);
        if (thread) {
          if (
            !options?.workingDirectory ||
            thread.workingDirectory === options.workingDirectory
          ) {
            list.push(thread);
          }
        }
      }
    }

    list.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return options?.limit && options.limit > 0
      ? list.slice(0, options.limit)
      : list;
  }

  /**
   * Updates an existing thread's metadata fields using an explicit UpdateThreadInput patch.
   *
   * @param threadId - Safe thread identifier.
   * @param patch - Allowed metadata patch fields.
   * @returns Updated thread metadata snapshot.
   */
  public async updateThread(
    threadId: string,
    patch: UpdateThreadInput,
  ): Promise<ThreadMetadata> {
    this.validateThreadId(threadId);
    const lockPath = this.getLockPath(threadId);

    return await withFileLock(lockPath, async () => {
      const current = await this.getThreadUnlocked(threadId);
      if (!current) {
        throw new Error(`Thread not found: "${threadId}"`);
      }

      const updated: ThreadMetadata = {
        ...current,
        title: patch.title !== undefined ? patch.title : current.title,
        tags: patch.tags !== undefined ? patch.tags : current.tags,
        model: patch.model !== undefined ? patch.model : current.model,
        provider:
          patch.provider !== undefined ? patch.provider : current.provider,
        reasoning:
          patch.reasoning !== undefined ? patch.reasoning : current.reasoning,
        updatedAt: new Date().toISOString(),
      };

      const metadataPath = path.join(
        this.getThreadDir(threadId),
        "thread.json",
      );
      await atomicWriteFile(metadataPath, JSON.stringify(updated, null, 2));
      return updated;
    });
  }

  /**
   * Deletes a thread directory and its contents under external file lock.
   *
   * @param threadId - Safe thread identifier.
   * @returns True if thread existed and was deleted, false otherwise.
   */
  public async deleteThread(threadId: string): Promise<boolean> {
    this.validateThreadId(threadId);
    const lockPath = this.getLockPath(threadId);

    return await withFileLock(lockPath, async () => {
      const threadDir = this.getThreadDir(threadId);
      if (!existsSync(threadDir)) {
        return false;
      }
      await rm(threadDir, { recursive: true, force: true });
      return true;
    });
  }

  /**
   * Appends an entry to the append-only thread transcript log under thread lock.
   * Updates active sequence, turnCount, status, lastUserPromptPreview, and usage.
   *
   * @param threadId - Safe thread identifier.
   * @param entry - New unsequenced transcript entry.
   * @returns Sequenced and persisted transcript entry.
   */
  public async appendTranscript(
    threadId: string,
    entry: NewTranscriptEntry,
  ): Promise<TranscriptEntry> {
    this.validateThreadId(threadId);
    const lockPath = this.getLockPath(threadId);

    return await withFileLock(lockPath, async () => {
      const current = await this.getThreadUnlocked(threadId);
      if (!current) {
        throw new Error(`Thread not found: "${threadId}"`);
      }

      const sequence = current.activeTranscriptSequence + 1;
      const fullEntry = { ...entry, sequence } as TranscriptEntry;

      const threadDir = this.getThreadDir(threadId);
      const transcriptPath = path.join(threadDir, "transcript.jsonl");
      await appendJsonl(transcriptPath, fullEntry);

      let turnCount = current.turnCount;
      let status: ThreadStatus = current.status;
      let lastUserPromptPreview = current.lastUserPromptPreview;
      let usage = current.usage;

      if (entry.type === "turnStarted") {
        turnCount += 1;
        status = "running";
        lastUserPromptPreview = entry.userPrompt;
      } else if (entry.type === "turnFinished") {
        status = entry.finishReason === "error" ? "error" : "idle";
        if (entry.usage) {
          usage = {
            promptTokens:
              (current.usage.promptTokens ?? 0) +
              (entry.usage.promptTokens ?? 0),
            completionTokens:
              (current.usage.completionTokens ?? 0) +
              (entry.usage.completionTokens ?? 0),
            totalTokens:
              (current.usage.totalTokens ?? 0) + (entry.usage.totalTokens ?? 0),
            reasoningTokens:
              (current.usage.reasoningTokens ?? 0) +
              (entry.usage.reasoningTokens ?? 0),
          };
        }
      }

      const updatedMetadata: ThreadMetadata = {
        ...current,
        turnCount,
        status,
        activeTranscriptSequence: sequence,
        lastUserPromptPreview,
        usage,
        updatedAt: new Date().toISOString(),
      };

      const metadataPath = path.join(threadDir, "thread.json");
      await atomicWriteFile(
        metadataPath,
        JSON.stringify(updatedMetadata, null, 2),
      );

      return fullEntry;
    });
  }

  /**
   * Internal unlocked helper to read the transcript entries from disk.
   *
   * @param threadId - Safe thread identifier.
   * @returns Readonly array of sequenced transcript entries.
   */
  private async getTranscriptUnlocked(
    threadId: string,
  ): Promise<readonly TranscriptEntry[]> {
    const transcriptPath = path.join(
      this.getThreadDir(threadId),
      "transcript.jsonl",
    );
    if (!existsSync(transcriptPath)) {
      return [];
    }
    return await readJsonl<TranscriptEntry>(transcriptPath);
  }

  /**
   * Reads the full append-only transcript log for a thread under thread lock.
   *
   * @param threadId - Safe thread identifier.
   * @returns Readonly array of sequenced transcript entries.
   */
  public async getTranscript(
    threadId: string,
  ): Promise<readonly TranscriptEntry[]> {
    this.validateThreadId(threadId);
    const lockPath = this.getLockPath(threadId);
    return await withFileLock(lockPath, async () => {
      return this.getTranscriptUnlocked(threadId);
    });
  }

  /**
   * Projects conversational model messages from the authoritative transcript under thread lock.
   *
   * @param threadId - Safe thread identifier.
   * @returns Readonly array of ModelMessage items for model invocation.
   */
  public async getMessages(threadId: string): Promise<readonly ModelMessage[]> {
    this.validateThreadId(threadId);
    const lockPath = this.getLockPath(threadId);
    return await withFileLock(lockPath, async () => {
      const transcript = await this.getTranscriptUnlocked(threadId);
      const messages: ModelMessage[] = [];

      for (const entry of transcript) {
        if (entry.type === "modelMessage") {
          messages.push(entry.message);
        }
      }

      return messages;
    });
  }
}
