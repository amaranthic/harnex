/**
 * @fileoverview Test suite for FileThreadStore persistence and invariants.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileThreadStore,
  CURRENT_TRANSCRIPT_VERSION,
  type StepTokenUsage,
} from "../src/index.js";
import { withFileLock } from "../src/storage/lock.js";
import { readJsonl, writeJsonl } from "../src/storage/jsonl.js";

describe("ThreadStore implementations", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = path.join(
      tmpdir(),
      `hernex_thread_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(testHome, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("FileThreadStore Contract", () => {
    it("creates, retrieves, updates, and deletes threads", async () => {
      const store = new FileThreadStore({ homeDirectory: testHome });

      const thread = await store.createThread({
        title: "Thread Alpha",
        tags: ["test", "ai"],
        workingDirectory: "/workspace/alpha",
        model: "openai/gpt-4o",
      });

      expect(thread.id).toBeDefined();
      expect(thread.title).toBe("Thread Alpha");
      expect(thread.workingDirectory).toBe("/workspace/alpha");
      expect(thread.status).toBe("idle");
      expect(thread.turnCount).toBe(0);
      expect(thread.usage).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
      });

      // getThread
      const fetched = await store.getThread(thread.id);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(thread.id);
      expect(fetched?.title).toBe("Thread Alpha");

      // updateThread
      const updated = await store.updateThread(thread.id, {
        title: "Thread Alpha Updated",
        model: "anthropic/claude-3-5-sonnet",
      });
      expect(updated.title).toBe("Thread Alpha Updated");
      expect(updated.model).toBe("anthropic/claude-3-5-sonnet");

      // listThreads
      const list = await store.listThreads({
        workingDirectory: "/workspace/alpha",
      });
      expect(list.length).toBe(1);
      expect(list[0]?.id).toBe(thread.id);

      // deleteThread
      const deleted = await store.deleteThread(thread.id);
      expect(deleted).toBe(true);

      const afterDelete = await store.getThread(thread.id);
      expect(afterDelete).toBeUndefined();
    });

    it("appends transcript entries, tracks sequence, and reconstructs model messages", async () => {
      const store = new FileThreadStore({ homeDirectory: testHome });

      const thread = await store.createThread({
        workingDirectory: "/workspace/transcript",
      });

      await store.appendTranscript(thread.id, {
        type: "turnStarted",
        turnIndex: 1,
        userPrompt: "Hello assistant",
        timestamp: Date.now(),
      });

      await store.appendTranscript(thread.id, {
        type: "modelMessage",
        message: { role: "user", content: "Hello assistant" },
        timestamp: Date.now(),
      });

      await store.appendTranscript(thread.id, {
        type: "modelMessage",
        turnIndex: 1,
        message: { role: "assistant", content: "Hello human! How can I help?" },
        timestamp: Date.now(),
      });

      await store.appendTranscript(thread.id, {
        type: "turnFinished",
        turnIndex: 1,
        finishReason: "completed",
        timestamp: Date.now(),
      });

      const transcript = await store.getTranscript(thread.id);
      expect(transcript.length).toBe(4);
      expect(transcript[0]?.sequence).toBe(1);
      expect(transcript[1]?.sequence).toBe(2);
      expect(transcript[2]?.sequence).toBe(3);
      expect(transcript[3]?.sequence).toBe(4);

      const messages = await store.getMessages(thread.id);
      expect(messages.length).toBe(2);
      expect(messages[0]?.role).toBe("user");
      expect(messages[1]?.role).toBe("assistant");
    });

    it("tracks turnCount, status, lastUserPromptPreview, and usage across lifecycle entries", async () => {
      const store = new FileThreadStore({ homeDirectory: testHome });

      const thread = await store.createThread({
        workingDirectory: "/workspace/lifecycle",
      });

      // 1. turnStarted increments turnCount, sets status running, records prompt preview
      await store.appendTranscript(thread.id, {
        type: "turnStarted",
        turnIndex: 1,
        userPrompt: "What is the status of project X?",
        timestamp: Date.now(),
      });

      let snapshot = await store.getThread(thread.id);
      expect(snapshot?.turnCount).toBe(1);
      expect(snapshot?.status).toBe("running");
      expect(snapshot?.lastUserPromptPreview).toBe(
        "What is the status of project X?",
      );

      // 2. Interleaved model messages/reminders do not increment turnCount
      await store.appendTranscript(thread.id, {
        type: "modelMessage",
        message: { role: "user", content: "Reminder: stay concise" },
        timestamp: Date.now(),
      });

      snapshot = await store.getThread(thread.id);
      expect(snapshot?.turnCount).toBe(1);
      expect(snapshot?.status).toBe("running");

      // 3. turnFinished updates status to idle and records usage
      const stepUsage: StepTokenUsage = {
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 165,
        reasoningTokens: 10,
      };

      await store.appendTranscript(thread.id, {
        type: "turnFinished",
        turnIndex: 1,
        finishReason: "stop",
        usage: stepUsage,
        timestamp: Date.now(),
      });

      snapshot = await store.getThread(thread.id);
      expect(snapshot?.turnCount).toBe(1);
      expect(snapshot?.status).toBe("idle");
      expect(snapshot?.usage).toEqual(stepUsage);

      // 4. turnFinished with finishReason error sets status to error
      await store.appendTranscript(thread.id, {
        type: "turnStarted",
        turnIndex: 2,
        userPrompt: "Trigger failure",
        timestamp: Date.now(),
      });

      await store.appendTranscript(thread.id, {
        type: "turnFinished",
        turnIndex: 2,
        finishReason: "error",
        timestamp: Date.now(),
      });

      snapshot = await store.getThread(thread.id);
      expect(snapshot?.turnCount).toBe(2);
      expect(snapshot?.status).toBe("error");
    });

    it("rejects unsafe thread IDs across all public methods", async () => {
      const store = new FileThreadStore({ homeDirectory: testHome });
      const unsafeIds = [
        "../escaped_id",
        "sub/dir/id",
        "\\backslash\\id",
        "-leading-dash",
        "_leading_underscore",
        "",
        "has spaces",
        "has$symbols#",
      ];

      for (const id of unsafeIds) {
        await expect(store.getThread(id)).rejects.toThrow(
          "Invalid thread identifier",
        );
        await expect(
          store.createThread({ id, workingDirectory: "/workspace" }),
        ).rejects.toThrow("Invalid thread identifier");
        await expect(store.updateThread(id, { title: "Test" })).rejects.toThrow(
          "Invalid thread identifier",
        );
        await expect(store.deleteThread(id)).rejects.toThrow(
          "Invalid thread identifier",
        );
        await expect(store.getTranscript(id)).rejects.toThrow(
          "Invalid thread identifier",
        );
        await expect(store.getMessages(id)).rejects.toThrow(
          "Invalid thread identifier",
        );
      }
    });

    it("rejects duplicate thread IDs on creation rather than overwriting", async () => {
      const store = new FileThreadStore({ homeDirectory: testHome });
      const customId = "thread-alpha-123";

      const created = await store.createThread({
        id: customId,
        title: "First instance",
        workingDirectory: "/workspace/first",
      });
      expect(created.id).toBe(customId);

      await expect(
        store.createThread({
          id: customId,
          title: "Second instance collision",
          workingDirectory: "/workspace/second",
        }),
      ).rejects.toThrow(`Thread already exists: "${customId}"`);
    });

    it("places per-thread locks outside the thread directory", async () => {
      const store = new FileThreadStore({ homeDirectory: testHome });
      const thread = await store.createThread({
        workingDirectory: "/workspace/locktest",
      });

      const lockPath = path.join(
        testHome,
        "locks",
        "threads",
        `${thread.id}.lock`,
      );
      const threadInternalLock = path.join(
        testHome,
        "threads",
        thread.id,
        ".thread.lock",
      );

      // Appending to transcript or updating thread uses the external lock
      await store.updateThread(thread.id, { title: "Updated Title" });

      // 1. The external locks directory must have been created
      expect(existsSync(path.join(testHome, "locks", "threads"))).toBe(true);

      // 2. Thread directory must NOT contain an internal lock file
      expect(existsSync(threadInternalLock)).toBe(false);

      // 3. Coordinate under the external lock path to verify lock target alignment
      let observedLockInExternalDir = false;
      await withFileLock(lockPath, async () => {
        observedLockInExternalDir = existsSync(lockPath);
      });
      expect(observedLockInExternalDir).toBe(true);
      expect(existsSync(threadInternalLock)).toBe(false);
    });

    it("handles concurrent transcript appends under lock while preserving sequence integrity", async () => {
      const store = new FileThreadStore({ homeDirectory: testHome });
      const thread = await store.createThread({
        workingDirectory: "/workspace/concurrent",
      });

      // Concurrently append 10 messages
      const appends = Array.from({ length: 10 }, (_, index) =>
        store.appendTranscript(thread.id, {
          type: "modelMessage",
          message: { role: "assistant", content: `Chunk ${index}` },
          timestamp: Date.now(),
        }),
      );

      await Promise.all(appends);

      const transcript = await store.getTranscript(thread.id);
      expect(transcript.length).toBe(10);

      // Sequences must be strictly 1 through 10
      const sequences = transcript.map((entry) => entry.sequence);
      expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("reconstructs AI SDK v7 role: tool messages from persisted toolResult entries", async () => {
      const store = new FileThreadStore({ homeDirectory: testHome });
      const thread = await store.createThread({
        workingDirectory: "/workspace/tool-reconstruction",
      });

      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "turnStarted",
        turnIndex: 1,
        userPrompt: "Read two files",
        timestamp: Date.now(),
      });

      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "modelMessage",
        turnIndex: 1,
        message: { role: "user", content: "Read two files" },
        timestamp: Date.now(),
      });

      // Assistant message requesting two tool executions
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "modelMessage",
        turnIndex: 1,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I will read the files.",
            },
            {
              type: "tool-call",
              toolCallId: "call_alpha_1",
              toolName: "ReadFile",
              input: { filePath: "alpha.txt" },
            },
            {
              type: "tool-call",
              toolCallId: "call_beta_2",
              toolName: "ReadFile",
              input: { filePath: "beta.txt" },
            },
          ],
        },
        timestamp: Date.now(),
      });

      // Persisted tool results corresponding to the tool calls
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "toolResult",
        turnIndex: 1,
        callId: "call_alpha_1",
        toolName: "ReadFile",
        result: "alpha file text content",
        isError: false,
        timestamp: Date.now(),
      });

      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "toolResult",
        turnIndex: 1,
        callId: "call_beta_2",
        toolName: "ReadFile",
        result: { size: 42, formatted: true },
        isError: false,
        timestamp: Date.now(),
      });

      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "turnFinished",
        turnIndex: 1,
        finishReason: "completed",
        timestamp: Date.now(),
      });

      const messages = await store.getMessages(thread.id);
      expect(messages.length).toBe(3);

      // 1. User message
      expect(messages[0]?.role).toBe("user");

      // 2. Assistant message with tool-calls
      expect(messages[1]?.role).toBe("assistant");

      // 3. Reconstructed tool message with matching tool-results
      const toolMsg = messages[2];
      expect(toolMsg?.role).toBe("tool");
      expect(Array.isArray(toolMsg?.content)).toBe(true);

      const content = toolMsg?.content as Array<{
        type: string;
        toolCallId: string;
        toolName: string;
        output: { type: string; value: unknown };
      }>;
      expect(content.length).toBe(2);

      expect(content[0]).toEqual({
        type: "tool-result",
        toolCallId: "call_alpha_1",
        toolName: "ReadFile",
        output: {
          type: "text",
          value: "alpha file text content",
        },
      });

      expect(content[1]).toEqual({
        type: "tool-result",
        toolCallId: "call_beta_2",
        toolName: "ReadFile",
        output: {
          type: "json",
          value: { size: 42, formatted: true },
        },
      });
    });

    it("excludes uncommitted and failed/vetoed turn residue on replay while preserving committed turns", async () => {
      const store = new FileThreadStore({ homeDirectory: testHome });
      const thread = await store.createThread({
        workingDirectory: "/workspace/residue-exclusion",
      });

      // 1. External message added outside turns (turnIndex: undefined)
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "modelMessage",
        message: { role: "system", content: "System setup prompt" },
        timestamp: Date.now(),
      });

      // 2. Turn 1: Successfully committed turn
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "turnStarted",
        turnIndex: 1,
        userPrompt: "Turn 1 prompt",
        timestamp: Date.now(),
      });
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "modelMessage",
        turnIndex: 1,
        message: { role: "user", content: "Turn 1 prompt" },
        timestamp: Date.now(),
      });
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "modelMessage",
        turnIndex: 1,
        message: { role: "assistant", content: "Turn 1 response" },
        timestamp: Date.now(),
      });
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "turnFinished",
        turnIndex: 1,
        finishReason: "completed",
        timestamp: Date.now(),
      });

      // 3. Turn 2: Failed turn (finishReason: error)
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "turnStarted",
        turnIndex: 2,
        userPrompt: "Turn 2 failing prompt",
        timestamp: Date.now(),
      });
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "modelMessage",
        turnIndex: 2,
        message: { role: "user", content: "Turn 2 failing prompt" },
        timestamp: Date.now(),
      });
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "turnFinished",
        turnIndex: 2,
        finishReason: "error",
        timestamp: Date.now(),
      });

      // 4. Turn 3: Uncommitted turn (process crashed mid-turn before turnFinished)
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "turnStarted",
        turnIndex: 3,
        userPrompt: "Turn 3 crashed prompt",
        timestamp: Date.now(),
      });
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "modelMessage",
        turnIndex: 3,
        message: { role: "user", content: "Turn 3 crashed prompt" },
        timestamp: Date.now(),
      });

      // 5. External message added after
      await store.appendTranscript(thread.id, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "modelMessage",
        message: { role: "user", content: "Final external user message" },
        timestamp: Date.now(),
      });

      const messages = await store.getMessages(thread.id);

      // Expected:
      // - Initial system message
      // - Turn 1 user message
      // - Turn 1 assistant message
      // - Final external user message
      // (Turn 2 failed residue and Turn 3 uncommitted residue are strictly excluded)
      expect(messages.length).toBe(4);
      expect(messages[0]).toEqual({
        role: "system",
        content: "System setup prompt",
      });
      expect(messages[1]).toEqual({ role: "user", content: "Turn 1 prompt" });
      expect(messages[2]).toEqual({
        role: "assistant",
        content: "Turn 1 response",
      });
      expect(messages[3]).toEqual({
        role: "user",
        content: "Final external user message",
      });
    });

    it("lazily migrates unversioned or v1 transcript entries to CURRENT_TRANSCRIPT_VERSION upon thread read and rewrites to disk under lock", async () => {
      const store = new FileThreadStore({ homeDirectory: testHome });
      const thread = await store.createThread({
        workingDirectory: "/workspace/migration-test",
      });

      const transcriptPath = path.join(
        testHome,
        "threads",
        thread.id,
        "transcript.jsonl",
      );

      // Write raw legacy unversioned entries lacking version and lacking turnIndex on modelMessage
      const legacyEntries = [
        {
          sequence: 1,
          type: "turnStarted",
          turnIndex: 1,
          userPrompt: "Legacy v1 prompt",
          timestamp: 1000,
        },
        {
          sequence: 2,
          type: "modelMessage",
          message: { role: "user", content: "Legacy v1 prompt" },
          timestamp: 1001,
        },
        {
          sequence: 3,
          type: "turnFinished",
          turnIndex: 1,
          finishReason: "completed",
          timestamp: 1002,
        },
      ];

      await writeJsonl(transcriptPath, legacyEntries);

      // Reading transcript should run the lazy migration pipeline and upgrade entries
      const migrated = await store.getTranscript(thread.id);
      expect(migrated.length).toBe(3);
      expect(migrated[0]?.version).toBe(CURRENT_TRANSCRIPT_VERSION);
      expect(migrated[1]?.version).toBe(CURRENT_TRANSCRIPT_VERSION);
      expect(migrated[1]?.turnIndex).toBe(1); // turn attribution applied by migrateV1ToV2
      expect(migrated[2]?.version).toBe(CURRENT_TRANSCRIPT_VERSION);

      // Verify the on-disk file was rewritten with migrated versioned entries
      const onDiskRaw =
        await readJsonl<Record<string, unknown>>(transcriptPath);
      expect(onDiskRaw.length).toBe(3);
      expect(onDiskRaw[0]?.["version"]).toBe(CURRENT_TRANSCRIPT_VERSION);
      expect(onDiskRaw[1]?.["version"]).toBe(CURRENT_TRANSCRIPT_VERSION);
      expect(onDiskRaw[1]?.["turnIndex"]).toBe(1);
      expect(onDiskRaw[2]?.["version"]).toBe(CURRENT_TRANSCRIPT_VERSION);
    });
  });
});
