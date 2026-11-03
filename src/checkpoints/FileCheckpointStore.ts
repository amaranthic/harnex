/**
 * @fileoverview Filesystem-backed content-addressed CheckpointStore with delta snapshots and safe conflict detection.
 * @packageDocumentation
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  HernexCheckpointConflictError,
  HernexStoreError,
} from "../errors.js";
import { atomicWriteFile } from "../storage/atomicFile.js";
import {
  resolveHomeDirectory,
  type ResolveHomeDirectoryOptions,
} from "../storage/homeDirectory.js";
import { withFileLock } from "../storage/lock.js";
import { resolvePathWithinWorkspace } from "../tools/internal/pathGuard.js";
import type {
  CheckpointFileRecord,
  CheckpointRecord,
  CheckpointStore,
  CreateCheckpointInput,
  RestoreFileAction,
  RestorePlan,
  RestoreResult,
} from "./types.js";

/** Identifier grammar validation regex. */
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** SHA-256 hash validation regex. */
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Persisted manifest envelope format version 2.
 */
interface CheckpointManifestEnvelope {
  readonly version: 2;
  readonly checkpoints: readonly CheckpointRecord[];
}

/**
 * FileCheckpointStore provides persistent content-addressed checkpointing
 * and rollback verification across thread-scoped workspace files.
 */
export class FileCheckpointStore implements CheckpointStore {
  private readonly rootDir: string;

  /**
   * Initializes a new FileCheckpointStore instance.
   *
   * @param options - Storage options including custom home directory.
   */
  public constructor(options?: ResolveHomeDirectoryOptions) {
    this.rootDir = resolveHomeDirectory(options);
  }

  /**
   * Validates safe identifier grammar for threads and checkpoints.
   *
   * @param id - Identifier string.
   * @param label - Human-readable label for error reporting.
   */
  private validateId(id: string, label: string): void {
    if (!id || typeof id !== "string" || !SAFE_ID_PATTERN.test(id)) {
      throw new Error(`Invalid ${label} identifier: "${id}"`);
    }
  }

  /**
   * Validates SHA-256 hexadecimal hash strings.
   *
   * @param hash - Hash string to validate.
   */
  private validateSha256(hash: string): void {
    if (!hash || typeof hash !== "string" || !SHA256_PATTERN.test(hash)) {
      throw new Error(`Invalid SHA-256 hash: "${hash}"`);
    }
  }

  /**
   * Resolves the manifest file path for a thread.
   */
  private getManifestPath(threadId: string): string {
    this.validateId(threadId, "thread");
    return path.join(
      this.rootDir,
      "threads",
      threadId,
      "checkpoints",
      "manifest.json",
    );
  }

  /**
   * Resolves the content-addressed blob storage path for a given SHA-256 digest.
   */
  private getBlobPath(sha256: string): string {
    this.validateSha256(sha256);
    return path.join(this.rootDir, "blobs", "sha256", sha256);
  }

  /**
   * Resolves the external lock path for thread checkpoint operations.
   */
  private getLockPath(threadId: string): string {
    this.validateId(threadId, "thread");
    return path.join(this.rootDir, "locks", "checkpoints", `${threadId}.lock`);
  }

  /**
   * Stores raw data in the content-addressed blob store with SHA-256 digest validation.
   */
  private async storeBlob(data: Buffer | Uint8Array): Promise<string> {
    const hash = createHash("sha256").update(data).digest("hex");
    this.validateSha256(hash);

    const blobPath = this.getBlobPath(hash);
    if (!existsSync(blobPath)) {
      await atomicWriteFile(blobPath, data);
    }
    return hash;
  }

  /**
   * Reads a raw blob from the content-addressed store and verifies its integrity.
   */
  private async readBlob(sha256: string): Promise<Buffer> {
    this.validateSha256(sha256);
    const blobPath = this.getBlobPath(sha256);
    if (!existsSync(blobPath)) {
      throw new Error(`Blob not found: "${sha256}"`);
    }

    const content = await readFile(blobPath);
    const computedHash = createHash("sha256").update(content).digest("hex");
    if (computedHash !== sha256) {
      throw new Error(
        `Corrupt blob detected for "${sha256}": computed digest is "${computedHash}"`,
      );
    }

    return content;
  }

  /**
   * Internal unlocked helper to read and validate the thread checkpoint manifest.
   */
  private async readManifestUnlocked(
    threadId: string,
  ): Promise<readonly CheckpointRecord[]> {
    const manifestPath = this.getManifestPath(threadId);
    if (!existsSync(manifestPath)) {
      return [];
    }

    const raw = await readFile(manifestPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseError) {
      throw new HernexStoreError(
        `Failed to parse checkpoint manifest at "${manifestPath}": ${String(parseError)}`,
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      (parsed as { version: unknown }).version !== 2
    ) {
      throw new HernexStoreError(
        `Incompatible checkpoint manifest version at "${manifestPath}". Expected version 2 envelope. Legacy unverified records cannot be migrated.`,
      );
    }

    const envelope = parsed as CheckpointManifestEnvelope;
    if (!Array.isArray(envelope.checkpoints)) {
      throw new HernexStoreError(
        `Malformed checkpoint manifest envelope at "${manifestPath}": checkpoints is not an array.`,
      );
    }

    return envelope.checkpoints;
  }

  /**
   * Internal unlocked helper to save checkpoint manifest under the version 2 envelope.
   */
  private async writeManifestUnlocked(
    threadId: string,
    checkpoints: readonly CheckpointRecord[],
  ): Promise<void> {
    const manifestPath = this.getManifestPath(threadId);
    const envelope: CheckpointManifestEnvelope = {
      version: 2,
      checkpoints,
    };
    await atomicWriteFile(manifestPath, JSON.stringify(envelope, null, 2));
  }

  /**
   * Lists all recorded checkpoints for a thread ordered chronologically under lock.
   */
  public async listCheckpoints(
    threadId: string,
  ): Promise<readonly CheckpointRecord[]> {
    this.validateId(threadId, "thread");
    const lockPath = this.getLockPath(threadId);

    return await withFileLock(lockPath, async () => {
      return this.readManifestUnlocked(threadId);
    });
  }

  /**
   * Retrieves a checkpoint record by thread and checkpoint identifier under lock.
   */
  public async getCheckpoint(
    threadId: string,
    checkpointId: string,
  ): Promise<CheckpointRecord | undefined> {
    this.validateId(threadId, "thread");
    this.validateId(checkpointId, "checkpoint");
    const lockPath = this.getLockPath(threadId);

    return await withFileLock(lockPath, async () => {
      const list = await this.readManifestUnlocked(threadId);
      return list.find((cp) => cp.id === checkpointId);
    });
  }

  /**
   * Records a pre-mutation snapshot of the specified workspace files under lock.
   */
  public async createCheckpoint(
    threadId: string,
    input: CreateCheckpointInput,
  ): Promise<CheckpointRecord> {
    this.validateId(threadId, "thread");
    if (!input.files || input.files.length === 0) {
      throw new Error("Checkpoint creation requires at least one relative file path.");
    }

    const lockPath = this.getLockPath(threadId);

    return await withFileLock(lockPath, async () => {
      const list = await this.readManifestUnlocked(threadId);
      const sequence = list.length > 0 ? list[list.length - 1]!.sequence + 1 : 1;
      const checkpointId = randomUUID();

      const fileRecords: CheckpointFileRecord[] = [];

      for (const relPath of input.files) {
        if (!relPath || typeof relPath !== "string") {
          throw new Error("Invalid relative file path in checkpoint input.");
        }

        // Validate containment within workspace
        const targetPath = resolvePathWithinWorkspace(
          relPath,
          input.workingDirectory,
        );

        if (existsSync(targetPath)) {
          const content = await readFile(targetPath);
          const hash = await this.storeBlob(content);
          fileRecords.push({
            relativePath: relPath,
            beforeHash: hash,
            afterHash: hash,
          });
        } else {
          fileRecords.push({
            relativePath: relPath,
            beforeHash: null,
            afterHash: null,
          });
        }
      }

      const record: CheckpointRecord = {
        id: checkpointId,
        sequence,
        threadId,
        turnIndex: input.turnIndex,
        label: input.label,
        source: input.source ?? "manual",
        timestamp: Date.now(),
        files: fileRecords,
      };

      const updatedList = [...list, record];
      await this.writeManifestUnlocked(threadId, updatedList);

      return record;
    });
  }

  /**
   * Updates an existing checkpoint after mutation with the post-state file hashes.
   */
  public async updateCheckpoint(
    threadId: string,
    checkpointId: string,
    workingDirectory: string,
  ): Promise<CheckpointRecord> {
    this.validateId(threadId, "thread");
    this.validateId(checkpointId, "checkpoint");
    const lockPath = this.getLockPath(threadId);

    return await withFileLock(lockPath, async () => {
      const list = await this.readManifestUnlocked(threadId);
      const index = list.findIndex((cp) => cp.id === checkpointId);
      if (index === -1) {
        throw new Error(`Checkpoint not found: "${checkpointId}"`);
      }

      const existing = list[index]!;
      const updatedFiles: CheckpointFileRecord[] = [];

      for (const file of existing.files) {
        const targetPath = resolvePathWithinWorkspace(
          file.relativePath,
          workingDirectory,
        );

        if (existsSync(targetPath)) {
          const content = await readFile(targetPath);
          const hash = await this.storeBlob(content);
          updatedFiles.push({
            relativePath: file.relativePath,
            beforeHash: file.beforeHash,
            afterHash: hash,
          });
        } else {
          updatedFiles.push({
            relativePath: file.relativePath,
            beforeHash: file.beforeHash,
            afterHash: null,
          });
        }
      }

      const updatedRecord: CheckpointRecord = {
        ...existing,
        files: updatedFiles,
      };

      const updatedList = [...list];
      updatedList[index] = updatedRecord;
      await this.writeManifestUnlocked(threadId, updatedList);

      return updatedRecord;
    });
  }

  /**
   * Deletes a checkpoint record from the thread manifest under lock.
   */
  public async deleteCheckpoint(
    threadId: string,
    checkpointId: string,
  ): Promise<boolean> {
    this.validateId(threadId, "thread");
    this.validateId(checkpointId, "checkpoint");
    const lockPath = this.getLockPath(threadId);

    return await withFileLock(lockPath, async () => {
      const list = await this.readManifestUnlocked(threadId);
      const filtered = list.filter((cp) => cp.id !== checkpointId);
      if (filtered.length === list.length) {
        return false;
      }
      await this.writeManifestUnlocked(threadId, filtered);
      return true;
    });
  }

  /**
   * Internal unlocked helper to compute the restore plan for a checkpoint.
   */
  private async planRestoreUnlocked(
    checkpoint: CheckpointRecord,
    workingDirectory: string,
  ): Promise<RestorePlan> {
    const actions: RestoreFileAction[] = [];
    let hasConflicts = false;

    for (const file of checkpoint.files) {
      const targetPath = resolvePathWithinWorkspace(
        file.relativePath,
        workingDirectory,
      );

      let currentHash: string | null = null;
      if (existsSync(targetPath)) {
        const content = await readFile(targetPath);
        currentHash = createHash("sha256").update(content).digest("hex");
      }

      const alreadyRestored = currentHash === file.beforeHash;
      const isConflict = !alreadyRestored && currentHash !== file.afterHash;

      if (isConflict) {
        hasConflicts = true;
      }

      let action: "unchanged" | "create" | "modify" | "delete";
      if (file.beforeHash === null) {
        action = currentHash === null ? "unchanged" : "delete";
      } else if (currentHash === null) {
        action = "create";
      } else if (currentHash === file.beforeHash) {
        action = "unchanged";
      } else {
        action = "modify";
      }

      actions.push({
        relativePath: file.relativePath,
        action,
        isConflict,
      });
    }

    return {
      checkpointId: checkpoint.id,
      actions,
      hasConflicts,
    };
  }

  /**
   * Preflights and plans the restoration of a checkpoint under lock.
   */
  public async planRestore(
    threadId: string,
    checkpointId: string,
    workingDirectory: string,
  ): Promise<RestorePlan> {
    this.validateId(threadId, "thread");
    this.validateId(checkpointId, "checkpoint");
    const lockPath = this.getLockPath(threadId);

    return await withFileLock(lockPath, async () => {
      const list = await this.readManifestUnlocked(threadId);
      const cp = list.find((item) => item.id === checkpointId);
      if (!cp) {
        throw new Error(`Checkpoint not found: "${checkpointId}"`);
      }
      return this.planRestoreUnlocked(cp, workingDirectory);
    });
  }

  /**
   * Restores workspace files to their recorded pre-mutation state under lock.
   */
  public async restoreCheckpoint(
    threadId: string,
    checkpointId: string,
    workingDirectory: string,
    options?: { readonly force?: boolean } | undefined,
  ): Promise<RestoreResult> {
    this.validateId(threadId, "thread");
    this.validateId(checkpointId, "checkpoint");
    const lockPath = this.getLockPath(threadId);

    return await withFileLock(lockPath, async () => {
      const list = await this.readManifestUnlocked(threadId);
      const cp = list.find((item) => item.id === checkpointId);
      if (!cp) {
        throw new Error(`Checkpoint not found: "${checkpointId}"`);
      }

      const plan = await this.planRestoreUnlocked(cp, workingDirectory);
      if (plan.hasConflicts && !options?.force) {
        throw new HernexCheckpointConflictError(
          `Restore conflicts detected in checkpoint "${checkpointId}". Pass { force: true } to overwrite uncommitted external changes.`,
        );
      }

      // Preflight: Stage all required blobs and validate paths before mutating
      const stagedBlobs = new Map<string, Buffer>();
      for (const file of cp.files) {
        // Path validation
        resolvePathWithinWorkspace(file.relativePath, workingDirectory);

        const actionItem = plan.actions.find(
          (a) => a.relativePath === file.relativePath,
        );
        if (
          actionItem &&
          (actionItem.action === "create" || actionItem.action === "modify")
        ) {
          if (!file.beforeHash) {
            throw new Error(
              `Missing beforeHash for restore action "${actionItem.action}" on path "${file.relativePath}".`,
            );
          }
          if (!stagedBlobs.has(file.beforeHash)) {
            const blobBytes = await this.readBlob(file.beforeHash);
            stagedBlobs.set(file.beforeHash, blobBytes);
          }
        }
      }

      // Execution: perform mutations and track progress
      let filesRestored = 0;
      let filesDeleted = 0;
      let conflictsOverwritten = 0;
      const committedPaths: string[] = [];

      try {
        for (const file of cp.files) {
          const targetPath = resolvePathWithinWorkspace(
            file.relativePath,
            workingDirectory,
          );
          const actionItem = plan.actions.find(
            (a) => a.relativePath === file.relativePath,
          );
          if (!actionItem) {
            continue;
          }

          if (actionItem.isConflict) {
            conflictsOverwritten++;
          }

          if (actionItem.action === "delete") {
            if (existsSync(targetPath)) {
              await unlink(targetPath);
              filesDeleted++;
              committedPaths.push(file.relativePath);
            }
          } else if (
            actionItem.action === "create" ||
            actionItem.action === "modify"
          ) {
            const blobBytes = stagedBlobs.get(file.beforeHash!)!;
            await atomicWriteFile(targetPath, blobBytes);
            filesRestored++;
            committedPaths.push(file.relativePath);
          }
        }
      } catch (mutationError) {
        throw new AggregateError(
          [mutationError],
          `Restore failed during filesystem mutations. Committed paths: ${committedPaths.join(", ")}`,
        );
      }

      return {
        checkpointId,
        filesRestored,
        filesDeleted,
        conflictsOverwritten,
      };
    });
  }
}
