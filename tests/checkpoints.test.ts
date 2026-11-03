/**
 * @fileoverview Test suite for FileCheckpointStore, snapshot verification, and rollback integrity.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileCheckpointStore,
  HernexCheckpointConflictError,
  HernexStoreError,
} from "../src/index.js";

describe("FileCheckpointStore", () => {
  let testHome: string;
  let workspaceDir: string;
  let store: FileCheckpointStore;

  beforeEach(() => {
    const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    testHome = path.join(tmpdir(), `hernex_cp_test_home_${runId}`);
    workspaceDir = path.join(tmpdir(), `hernex_cp_test_ws_${runId}`);
    mkdirSync(testHome, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    store = new FileCheckpointStore({ homeDirectory: testHome });
  });

  afterEach(() => {
    try {
      rmSync(testHome, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("creates, retrieves, updates, lists, and deletes checkpoint records", async () => {
    const threadId = "thread-checkpoint-test";
    const filePath = "src/main.ts";
    const absolutePath = path.join(workspaceDir, filePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, "console.log('version 1');");

    // 1. Create pre-mutation checkpoint
    const cp1 = await store.createCheckpoint(threadId, {
      workingDirectory: workspaceDir,
      turnIndex: 1,
      label: "Initial snapshot",
      files: [filePath],
      source: { toolName: "writeFile" },
    });

    expect(cp1.sequence).toBe(1);
    expect(cp1.id).toBeDefined();
    expect(cp1.files.length).toBe(1);
    expect(cp1.files[0]?.beforeHash).not.toBeNull();
    expect(cp1.files[0]?.beforeHash).toBe(cp1.files[0]?.afterHash);

    // 2. Mutate file and update checkpoint
    writeFileSync(absolutePath, "console.log('version 2');");
    const updated = await store.updateCheckpoint(threadId, cp1.id, workspaceDir);
    expect(updated.id).toBe(cp1.id);
    expect(updated.files[0]?.afterHash).not.toBe(cp1.files[0]?.beforeHash);

    // 3. Fetch checkpoint
    const fetched = await store.getCheckpoint(threadId, cp1.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(cp1.id);
    expect(fetched?.files[0]?.afterHash).toBe(updated.files[0]?.afterHash);

    // 4. List checkpoints
    const list = await store.listCheckpoints(threadId);
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(cp1.id);

    // 5. Delete checkpoint
    const deleted = await store.deleteCheckpoint(threadId, cp1.id);
    expect(deleted).toBe(true);
    const afterDelete = await store.getCheckpoint(threadId, cp1.id);
    expect(afterDelete).toBeUndefined();
  });

  it("handles absent-before semantics for newly created files", async () => {
    const threadId = "thread-new-file";
    const newFile = "generated.txt";
    const absolutePath = path.join(workspaceDir, newFile);

    // File does not exist yet
    const cp = await store.createCheckpoint(threadId, {
      workingDirectory: workspaceDir,
      turnIndex: 1,
      label: "Before create",
      files: [newFile],
    });

    expect(cp.files[0]?.beforeHash).toBeNull();
    expect(cp.files[0]?.afterHash).toBeNull();

    // Now write the new file
    writeFileSync(absolutePath, "hello newly generated content");
    await store.updateCheckpoint(threadId, cp.id, workspaceDir);

    // Plan restore: since beforeHash is null, restoring must plan to delete
    const plan = await store.planRestore(threadId, cp.id, workspaceDir);
    expect(plan.actions[0]?.action).toBe("delete");
    expect(plan.hasConflicts).toBe(false);

    // Execute restore: file should be deleted
    const result = await store.restoreCheckpoint(threadId, cp.id, workspaceDir);
    expect(result.filesDeleted).toBe(1);
    expect(existsSync(absolutePath)).toBe(false);
  });

  it("plans and executes file restore with conflict detection", async () => {
    const threadId = "thread-restore-test";
    const filePath = "config.json";
    const absolutePath = path.join(workspaceDir, filePath);

    // Initial file state
    writeFileSync(absolutePath, '{"version": 1}');

    const checkpoint = await store.createCheckpoint(threadId, {
      workingDirectory: workspaceDir,
      turnIndex: 1,
      label: "Config snapshot",
      files: [filePath],
    });

    // Mutate file
    writeFileSync(absolutePath, '{"version": 2}');
    await store.updateCheckpoint(threadId, checkpoint.id, workspaceDir);

    // Plan restore without external conflicts
    const plan = await store.planRestore(threadId, checkpoint.id, workspaceDir);
    expect(plan.hasConflicts).toBe(false);
    expect(plan.actions.length).toBe(1);
    expect(plan.actions[0]?.action).toBe("modify");

    // Perform restore
    const result = await store.restoreCheckpoint(threadId, checkpoint.id, workspaceDir);
    expect(result.filesRestored).toBe(1);
    expect(result.conflictsOverwritten).toBe(0);
    expect(readFileSync(absolutePath, "utf-8")).toBe('{"version": 1}');
  });

  it("detects external conflict and requires force: true to overwrite", async () => {
    const threadId = "thread-conflict-test";
    const filePath = "server.ts";
    const absolutePath = path.join(workspaceDir, filePath);

    writeFileSync(absolutePath, "export const port = 3000;");
    const checkpoint = await store.createCheckpoint(threadId, {
      workingDirectory: workspaceDir,
      turnIndex: 1,
      label: "Port snapshot",
      files: [filePath],
    });

    writeFileSync(absolutePath, "export const port = 8080;");
    await store.updateCheckpoint(threadId, checkpoint.id, workspaceDir);

    // Simulate third-party external edit
    writeFileSync(absolutePath, "export const port = 9090;");

    const plan = await store.planRestore(threadId, checkpoint.id, workspaceDir);
    expect(plan.hasConflicts).toBe(true);
    expect(plan.actions[0]?.isConflict).toBe(true);

    // Restore without force must throw HernexCheckpointConflictError
    await expect(
      store.restoreCheckpoint(threadId, checkpoint.id, workspaceDir),
    ).rejects.toThrow(HernexCheckpointConflictError);

    // Restore with force overwrites
    const forcedResult = await store.restoreCheckpoint(
      threadId,
      checkpoint.id,
      workspaceDir,
      { force: true },
    );
    expect(forcedResult.conflictsOverwritten).toBe(1);
    expect(forcedResult.filesRestored).toBe(1);
    expect(readFileSync(absolutePath, "utf-8")).toBe("export const port = 3000;");
  });

  it("rejects path traversal in manifest and input file paths", async () => {
    const threadId = "thread-traversal-test";
    await expect(
      store.createCheckpoint(threadId, {
        workingDirectory: workspaceDir,
        turnIndex: 1,
        label: "Traversal attempt",
        files: ["../outside.txt"],
      }),
    ).rejects.toThrow();
  });

  it("rejects invalid thread and checkpoint identifiers", async () => {
    await expect(
      store.createCheckpoint("../unsafe-thread", {
        workingDirectory: workspaceDir,
        turnIndex: 1,
        label: "Unsafe",
        files: ["test.txt"],
      }),
    ).rejects.toThrow("Invalid thread identifier");

    await expect(
      store.getCheckpoint("validThread", "-invalid-id"),
    ).rejects.toThrow("Invalid checkpoint identifier");
  });

  it("fails closed when encountering a legacy unversioned manifest envelope", async () => {
    const threadId = "thread-legacy";
    const manifestPath = path.join(
      testHome,
      "threads",
      threadId,
      "checkpoints",
      "manifest.json",
    );
    mkdirSync(path.dirname(manifestPath), { recursive: true });

    // Write legacy array format lacking version 2 envelope
    writeFileSync(
      manifestPath,
      JSON.stringify([{ id: "cp_old", sequence: 1 }]),
    );

    await expect(store.listCheckpoints(threadId)).rejects.toThrow(HernexStoreError);
  });

  it("preserves shared blobs when deleting one of multiple checkpoints", async () => {
    const threadId = "thread-shared-blobs";
    const file1 = "doc1.txt";
    const file2 = "doc2.txt";
    const content = "shared identical content";

    writeFileSync(path.join(workspaceDir, file1), content);
    writeFileSync(path.join(workspaceDir, file2), content);

    const cp1 = await store.createCheckpoint(threadId, {
      workingDirectory: workspaceDir,
      turnIndex: 1,
      label: "Doc 1",
      files: [file1],
    });

    const cp2 = await store.createCheckpoint(threadId, {
      workingDirectory: workspaceDir,
      turnIndex: 1,
      label: "Doc 2",
      files: [file2],
    });

    // Mutate file2 and update checkpoint 2
    writeFileSync(path.join(workspaceDir, file2), "mutated content");
    await store.updateCheckpoint(threadId, cp2.id, workspaceDir);

    // Delete cp1
    await store.deleteCheckpoint(threadId, cp1.id);

    // cp2 should still restore successfully using the shared blob
    const restoreRes = await store.restoreCheckpoint(threadId, cp2.id, workspaceDir);
    expect(restoreRes.filesRestored).toBe(1);
    expect(readFileSync(path.join(workspaceDir, file2), "utf-8")).toBe(content);
  });
});
