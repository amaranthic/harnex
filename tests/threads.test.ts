/**
 * @fileoverview Test suite for FileThreadStore persistence and invariants.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileThreadStore,
  type StepTokenUsage,
} from "../src/index.js";
import { withFileLock } from "../src/storage/lock.js";

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
        title: "Session Alpha",
        tags: ["test", "ai"],
        workingDirectory: "/workspace/alpha",
        model: "openai/gpt-4o",
      });

      expect(thread.id).toBeDefined();
      expect(thread.title).toBe("Session Alpha");
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
      expect(fetched?.title).toBe("Session Alpha");

      // updateThread
      const updated = await store.updateThread(thread.id, {
        title: "Session Alpha Updated",
        model: "anthropic/claude-3-5-sonnet",
      });
      expect(updated.title).toBe("Session Alpha Updated");
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
        message: { role: "assistant", content: "Hello human! How can I help?" },
        timestamp: Date.now(),
      });

      const transcript = await store.getTranscript(thread.id);
      expect(transcript.length).toBe(3);
      expect(transcript[0]?.sequence).toBe(1);
      expect(transcript[1]?.sequence).toBe(2);
      expect(transcript[2]?.sequence).toBe(3);

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
      expect(snapshot?.lastUserPromptPreview).toBe("What is the status of project X?");

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
        await expect(store.getThread(id)).rejects.toThrow("Invalid thread identifier");
        await expect(store.createThread({ id, workingDirectory: "/workspace" })).rejects.toThrow("Invalid thread identifier");
        await expect(store.updateThread(id, { title: "Test" })).rejects.toThrow("Invalid thread identifier");
        await expect(store.deleteThread(id)).rejects.toThrow("Invalid thread identifier");
        await expect(store.getTranscript(id)).rejects.toThrow("Invalid thread identifier");
        await expect(store.getMessages(id)).rejects.toThrow("Invalid thread identifier");
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

      const lockPath = path.join(testHome, "locks", "threads", `${thread.id}.lock`);
      const threadInternalLock = path.join(testHome, "threads", thread.id, ".thread.lock");

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
  });
});
