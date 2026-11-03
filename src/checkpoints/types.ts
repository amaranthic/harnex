/**
 * @fileoverview Checkpoint, delta snapshot, and rollback type definitions.
 * @packageDocumentation
 */

/**
 * File mutation state captured inside a checkpoint snapshot.
 */
export interface CheckpointFileRecord {
  /** Relative workspace path. */
  readonly relativePath: string;
  /** SHA-256 hash of the file content before mutation, or null if the file did not exist. */
  readonly beforeHash: string | null;
  /** SHA-256 hash of the file content after mutation, or null if the file was deleted. */
  readonly afterHash: string | null;
}

/**
 * Persisted snapshot record capturing a state transition for specific workspace files.
 */
export interface CheckpointRecord {
  /** Unique safe checkpoint identifier. */
  readonly id: string;
  /** Monotonically increasing sequence number within the thread's checkpoint log. */
  readonly sequence: number;
  /** Safe thread identifier that owns this checkpoint. */
  readonly threadId: string;
  /** Agent turn index during which this checkpoint was recorded. */
  readonly turnIndex: number;
  /** Descriptive human-readable label for the checkpoint. */
  readonly label: string;
  /** Source attributing creation to manual product code or a specific tool execution. */
  readonly source: "manual" | { readonly toolName: string };
  /** Unix timestamp in milliseconds when the checkpoint was created. */
  readonly timestamp: number;
  /** Explicitly captured file records with before and after state hashes. */
  readonly files: readonly CheckpointFileRecord[];
}

/**
 * Input parameters for creating a new checkpoint snapshot prior to mutation.
 */
export interface CreateCheckpointInput {
  /** Canonical workspace root directory. */
  readonly workingDirectory: string;
  /** Agent turn index. */
  readonly turnIndex: number;
  /** Descriptive label. */
  readonly label: string;
  /** Explicit relative file paths to capture. Must contain at least one path. */
  readonly files: readonly string[];
  /** Optional source attribution. Defaults to "manual". */
  readonly source?: "manual" | { readonly toolName: string } | undefined;
}

/**
 * Planned file restoration action evaluated against current workspace content.
 */
export interface RestoreFileAction {
  /** Relative workspace path. */
  readonly relativePath: string;
  /** Action required to restore the file to its beforeHash state. */
  readonly action: "unchanged" | "create" | "modify" | "delete";
  /** Whether the current file content conflicts with both before and after recorded states. */
  readonly isConflict: boolean;
}

/**
 * Detailed restoration plan containing file actions and conflict status.
 */
export interface RestorePlan {
  /** Checkpoint identifier being evaluated. */
  readonly checkpointId: string;
  /** Actions required for each file in the snapshot. */
  readonly actions: readonly RestoreFileAction[];
  /** Whether any uncommitted external modifications conflict with the rollback. */
  readonly hasConflicts: boolean;
}

/**
 * Summary outcome of executing a checkpoint restoration plan.
 */
export interface RestoreResult {
  /** Checkpoint identifier that was restored. */
  readonly checkpointId: string;
  /** Number of files created or modified back to their pre-state. */
  readonly filesRestored: number;
  /** Number of files deleted because they were newly created by the tool. */
  readonly filesDeleted: number;
  /** Number of conflicting files overwritten when force was true. */
  readonly conflictsOverwritten: number;
}

/**
 * Store interface managing checkpoint recording, delta blobs, and safe restoration.
 */
export interface CheckpointStore {
  /**
   * Records a pre-mutation snapshot of the specified workspace files.
   *
   * @param threadId - Safe thread identifier.
   * @param input - Checkpoint creation parameters.
   * @returns Newly recorded CheckpointRecord.
   */
  createCheckpoint(
    threadId: string,
    input: CreateCheckpointInput,
  ): Promise<CheckpointRecord>;

  /**
   * Retrieves a checkpoint record by thread and checkpoint identifier.
   *
   * @param threadId - Safe thread identifier.
   * @param checkpointId - Safe checkpoint identifier.
   * @returns Checkpoint record or undefined if not found.
   */
  getCheckpoint(
    threadId: string,
    checkpointId: string,
  ): Promise<CheckpointRecord | undefined>;

  /**
   * Lists all recorded checkpoints for a thread ordered chronologically.
   *
   * @param threadId - Safe thread identifier.
   * @returns Readonly array of checkpoint records.
   */
  listCheckpoints(threadId: string): Promise<readonly CheckpointRecord[]>;

  /**
   * Updates an existing checkpoint after mutation with the post-state file hashes.
   *
   * @param threadId - Safe thread identifier.
   * @param checkpointId - Safe checkpoint identifier.
   * @param workingDirectory - Canonical workspace root directory.
   * @returns Updated CheckpointRecord.
   */
  updateCheckpoint(
    threadId: string,
    checkpointId: string,
    workingDirectory: string,
  ): Promise<CheckpointRecord>;

  /**
   * Deletes a checkpoint record from the thread manifest.
   *
   * @param threadId - Safe thread identifier.
   * @param checkpointId - Safe checkpoint identifier.
   * @returns True if checkpoint existed and was removed, false otherwise.
   */
  deleteCheckpoint(threadId: string, checkpointId: string): Promise<boolean>;

  /**
   * Preflights and plans the restoration of a checkpoint without mutating files.
   *
   * @param threadId - Safe thread identifier.
   * @param checkpointId - Safe checkpoint identifier.
   * @param workingDirectory - Canonical workspace root directory.
   * @returns Restore plan detailing actions and conflicts.
   */
  planRestore(
    threadId: string,
    checkpointId: string,
    workingDirectory: string,
  ): Promise<RestorePlan>;

  /**
   * Restores workspace files to their recorded pre-mutation state.
   *
   * @param threadId - Safe thread identifier.
   * @param checkpointId - Safe checkpoint identifier.
   * @param workingDirectory - Canonical workspace root directory.
   * @param options - Optional restoration options including force flag.
   * @returns Restore result summary.
   */
  restoreCheckpoint(
    threadId: string,
    checkpointId: string,
    workingDirectory: string,
    options?: { readonly force?: boolean } | undefined,
  ): Promise<RestoreResult>;
}
