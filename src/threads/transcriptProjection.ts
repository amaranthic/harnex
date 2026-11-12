/**
 * @fileoverview Conversational model message projection from append-only transcript logs.
 * @packageDocumentation
 */

import { toJsonValue } from "../events/types.js";
import type { ModelMessage } from "../model/types.js";
import type { TranscriptEntry } from "./types.js";

/**
 * Shape of a tool-call part within an assistant message.
 */
interface ProjectedToolCall {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName?: string;
}

/**
 * Type guard identifying tool-call content parts in assistant messages.
 */
function isToolCallPart(part: unknown): part is ProjectedToolCall {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "tool-call" &&
    typeof (part as { toolCallId?: unknown }).toolCallId === "string"
  );
}

/**
 * Projects conversational model messages from an authoritative transcript log.
 *
 * Implements deterministic replay invariants:
 * - Excludes entries belonging to failed, vetoed, or uncommitted turns so the resumed
 *   engine history matches the live post-failure engine state.
 * - Preserves user, assistant, and externally added messages in correct chronological order.
 * - Reconstructs standard AI SDK v7 `role: "tool"` messages containing `tool-result` blocks
 *   from persisted `toolResult` entries in exact correspondence to assistant `tool-call`s.
 *
 * @param transcript - Ordered array of sequenced transcript entries.
 * @returns Reconstructed array of ModelMessage items for seeding or resuming the model.
 */
export function projectModelMessages(
  transcript: readonly TranscriptEntry[],
): readonly ModelMessage[] {
  if (transcript.length === 0) {
    return [];
  }

  // 1. Identify committed vs failed/uncommitted turns
  const startedTurns = new Set<number>();
  const finishedTurns = new Set<number>();
  const committedTurns = new Set<number>();
  const failedOrVetoedTurns = new Set<number>();

  for (const entry of transcript) {
    if (entry.type === "turnStarted" && typeof entry.turnIndex === "number") {
      startedTurns.add(entry.turnIndex);
    }
    if (entry.type === "turnFinished" && typeof entry.turnIndex === "number") {
      finishedTurns.add(entry.turnIndex);
      if (entry.finishReason === "error" || entry.finishReason === "vetoed") {
        failedOrVetoedTurns.add(entry.turnIndex);
      } else {
        committedTurns.add(entry.turnIndex);
      }
    }
  }

  // 2. Index tool results by callId for fast lookup
  const toolResultsByCallId = new Map<
    string,
    {
      readonly toolName: string;
      readonly result: unknown;
      readonly isError?: boolean | undefined;
    }
  >();

  for (const entry of transcript) {
    if (entry.type === "toolResult") {
      toolResultsByCallId.set(entry.callId, {
        toolName: entry.toolName,
        result: entry.result,
        isError: entry.isError,
      });
    }
  }

  // 3. Project messages
  const messages: ModelMessage[] = [];

  for (const entry of transcript) {
    // Check turn commitment policy:
    // If turnIndex is present, skip if turn is failed/vetoed, uncommitted, or not committed
    if (entry.turnIndex !== undefined) {
      if (failedOrVetoedTurns.has(entry.turnIndex)) {
        continue;
      }
      if (
        startedTurns.has(entry.turnIndex) &&
        !finishedTurns.has(entry.turnIndex)
      ) {
        continue;
      }
      if (!committedTurns.has(entry.turnIndex)) {
        continue;
      }
    }

    if (entry.type === "modelMessage") {
      const msg = entry.message;

      // Handle assistant messages containing tool-call parts
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        messages.push(msg);

        // Find tool calls
        const toolCallParts: ProjectedToolCall[] = [];
        for (const part of msg.content) {
          if (isToolCallPart(part)) {
            toolCallParts.push(part);
          }
        }

        if (toolCallParts.length > 0) {
          const matchingResults = toolCallParts
            .map((tc) => {
              const res = toolResultsByCallId.get(tc.toolCallId);
              if (!res) {
                return null;
              }
              return {
                type: "tool-result" as const,
                toolCallId: tc.toolCallId,
                toolName: res.toolName,
                output:
                  typeof res.result === "string"
                    ? { type: "text" as const, value: res.result }
                    : { type: "json" as const, value: toJsonValue(res.result) },
              };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);

          if (matchingResults.length > 0) {
            messages.push({
              role: "tool",
              content: matchingResults,
            });
          }
        }
      } else {
        messages.push(msg);
      }
    }
  }

  return messages;
}
