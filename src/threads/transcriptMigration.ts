/**
 * @fileoverview Extensible versioned migration pipeline for thread transcript entries.
 * @packageDocumentation
 */

import type { TranscriptEntry } from "./types.js";

/** Current canonical schema version for transcript entries. */
export const CURRENT_TRANSCRIPT_VERSION = 2;

/**
 * Contract for a discrete step migration function in the transcript migration pipeline.
 */
export interface TranscriptMigration {
  /** Source schema version this migration upgrades from. */
  readonly fromVersion: number;
  /** Destination schema version this migration produces. */
  readonly toVersion: number;
  /**
   * Transforms an array of transcript records to the next schema version.
   *
   * @param entries - Raw records conforming to fromVersion.
   * @returns Upgraded records conforming to toVersion.
   */
  migrate(
    entries: readonly Record<string, unknown>[],
  ): readonly Record<string, unknown>[];
}

/**
 * Migration 1 -> 2:
 * - Assigns version: 2 to all entries.
 * - Enforces turn attribution: links modelMessage, toolCall, toolResult, and checkpointRef
 *   entries to the owning turnIndex between turnStarted and turnFinished boundaries.
 * - External conversational messages outside turns retain turnIndex: undefined.
 */
export const migrateV1ToV2: TranscriptMigration = {
  fromVersion: 1,
  toVersion: CURRENT_TRANSCRIPT_VERSION,
  migrate(
    entries: readonly Record<string, unknown>[],
  ): readonly Record<string, unknown>[] {
    let currentTurnIndex: number | undefined;

    return entries.map((rawEntry) => {
      const entry: Record<string, unknown> = {
        ...rawEntry,
        version: CURRENT_TRANSCRIPT_VERSION,
      };

      if (entry["type"] === "turnStarted") {
        currentTurnIndex =
          typeof entry["turnIndex"] === "number"
            ? entry["turnIndex"]
            : undefined;
        return entry;
      }

      if (entry["type"] === "turnFinished") {
        const turnFinishedIndex =
          typeof entry["turnIndex"] === "number"
            ? entry["turnIndex"]
            : currentTurnIndex;
        currentTurnIndex = undefined;
        return {
          ...entry,
          turnIndex: turnFinishedIndex,
        };
      }

      // Associate in-turn events with active turn
      if (currentTurnIndex !== undefined) {
        return {
          ...entry,
          turnIndex: currentTurnIndex,
        };
      }

      return entry;
    });
  },
};

/** Registered ordered migrations. */
const registeredMigrations: readonly TranscriptMigration[] = [migrateV1ToV2];

/**
 * Result returned by the transcript migration pipeline.
 */
export interface MigrationPipelineResult {
  /** Final migrated entries at CURRENT_TRANSCRIPT_VERSION. */
  readonly entries: readonly TranscriptEntry[];
  /** Whether any migration was executed. */
  readonly wasMigrated: boolean;
}

/**
 * Runs the registered versioned migration pipeline over raw transcript entries.
 *
 * If all entries already conform to CURRENT_TRANSCRIPT_VERSION, returns immediately
 * without mutation. Otherwise, applies each necessary migration sequentially
 * to lazily upgrade older records to the current canonical version.
 *
 * @param rawEntries - Raw parsed JSONL objects from the transcript file.
 * @returns Migrated entries and a boolean flag indicating if upgrades were applied.
 */
export function runTranscriptMigrationPipeline(
  rawEntries: readonly Record<string, unknown>[],
): MigrationPipelineResult {
  if (rawEntries.length === 0) {
    return {
      entries: [],
      wasMigrated: false,
    };
  }

  // Detect minimum version across entries (unversioned entries default to 1)
  let lowestVersion = CURRENT_TRANSCRIPT_VERSION;
  for (const entry of rawEntries) {
    const v = typeof entry.version === "number" ? entry.version : 1;
    if (v < lowestVersion) {
      lowestVersion = v;
    }
  }

  if (lowestVersion >= CURRENT_TRANSCRIPT_VERSION) {
    return {
      entries: rawEntries as unknown as readonly TranscriptEntry[],
      wasMigrated: false,
    };
  }

  let currentEntries: readonly Record<string, unknown>[] = rawEntries;
  let currentVersion = lowestVersion;
  let wasMigrated = false;

  for (const migration of registeredMigrations) {
    if (migration.fromVersion >= currentVersion) {
      currentEntries = migration.migrate(currentEntries);
      currentVersion = migration.toVersion;
      wasMigrated = true;
    }
  }

  return {
    entries: currentEntries as unknown as readonly TranscriptEntry[],
    wasMigrated,
  };
}
