/**
 * @fileoverview Checkpoint creation event definitions.
 * @packageDocumentation
 */

/**
 * Event emitted when a workspace checkpoint is captured.
 */
export interface CheckpointCreatedEvent {
  /** Discriminant event type. */
  readonly type: "checkpointCreated";
  /** Unique checkpoint identifier. */
  readonly checkpointId: string;
  /** Monotonic sequence number within the thread. */
  readonly sequence: number;
  /** Descriptive label for the snapshot. */
  readonly label: string;
  /** Relative paths of all files captured in this checkpoint. */
  readonly filesTouched: readonly string[];
}
