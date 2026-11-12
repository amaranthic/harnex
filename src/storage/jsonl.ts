/**
 * @fileoverview Robust append-only JSONL parser and appender with torn-tail recovery and tagged value codec.
 * @packageDocumentation
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import path from "node:path";
import { decodeValue, encodeValue, type EncodedValue } from "./valueCodec.js";

/**
 * Versioned envelope wrapper used to store encoded values in JSONL streams.
 */
export interface JsonlEnvelope {
  /** Format schema version. */
  readonly version: 1;
  /** Encoded value payload. */
  readonly value: EncodedValue;
}

/**
 * Type guard for checking if a parsed JSON object is a JsonlEnvelope.
 *
 * @param value - Value to inspect.
 * @returns True if value conforms to JsonlEnvelope shape.
 */
export function isJsonlEnvelope(value: unknown): value is JsonlEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).version === 1 &&
    "value" in value &&
    typeof (value as Record<string, unknown>).value === "object" &&
    (value as Record<string, unknown>).value !== null &&
    "type" in
      ((value as Record<string, unknown>).value as Record<string, unknown>)
  );
}

/**
 * Appends a record to a JSONL file with trailing newline using a versioned tagged envelope.
 *
 * Before appending, if the file contains a torn non-newline-terminated final line,
 * it is verified and repaired under the caller's lock before appending. Truncate
 * failures propagate fail-closed.
 *
 * @param filePath - The target JSONL file.
 * @param record - Record or value to serialize and append.
 * @throws {TypeError} If record contains non-serializable values (e.g. functions, cycles).
 * @throws {Error} If torn-tail repair or write fails.
 */
export async function appendJsonl<T>(
  filePath: string,
  record: T,
): Promise<void> {
  const absolutePath = path.resolve(filePath);
  const parentDir = path.dirname(absolutePath);
  if (!existsSync(parentDir)) {
    await mkdir(parentDir, { recursive: true });
  }

  if (existsSync(absolutePath)) {
    const existingContent = await readFile(absolutePath, "utf-8");
    if (existingContent.length > 0 && !existingContent.endsWith("\n")) {
      const lastNewlineIndex = existingContent.lastIndexOf("\n");
      const tornLine =
        lastNewlineIndex === -1
          ? existingContent
          : existingContent.slice(lastNewlineIndex + 1);

      let isMalformed = false;
      try {
        JSON.parse(tornLine);
      } catch {
        isMalformed = true;
      }

      if (isMalformed) {
        const validBytes =
          lastNewlineIndex === -1
            ? 0
            : Buffer.byteLength(
                existingContent.slice(0, lastNewlineIndex + 1),
                "utf-8",
              );
        await truncate(absolutePath, validBytes);
      } else {
        await appendFile(absolutePath, "\n", "utf-8");
      }
    }
  }

  const envelope: JsonlEnvelope = {
    version: 1,
    value: encodeValue(record),
  };

  const line = JSON.stringify(envelope) + "\n";
  await appendFile(absolutePath, line, "utf-8");
}

/**
 * Reads all records from a JSONL file, recovering only from torn non-newline-terminated final lines.
 *
 * Malformed middle lines or newline-terminated malformed lines remain fatal and throw.
 * Truncate failures propagate immediately. Legacy untagged raw JSON lines are parsed as fallback.
 *
 * @param filePath - The JSONL file to read.
 * @returns Array of parsed records.
 * @throws {Error} When encountering corrupted middle or newline-terminated records.
 */
export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const absolutePath = path.resolve(filePath);
  if (!existsSync(absolutePath)) {
    return [];
  }

  const content = await readFile(absolutePath, "utf-8");
  if (!content.trim()) {
    return [];
  }

  const lines = content.split("\n");
  const records: T[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    if (rawLine.trim().length === 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawLine) as unknown;
      if (isJsonlEnvelope(parsed)) {
        records.push(decodeValue(parsed.value) as T);
      } else {
        records.push(parsed as T);
      }
    } catch (parseError) {
      const isFinalNonTerminatedLine =
        i === lines.length - 1 && !content.endsWith("\n");

      if (isFinalNonTerminatedLine) {
        const validBytes = Buffer.byteLength(
          lines.slice(0, i).join("\n") + (i > 0 ? "\n" : ""),
          "utf-8",
        );
        await truncate(absolutePath, validBytes);
        break;
      }

      throw new Error(
        `Corrupt JSONL entry at line ${i + 1} in "${filePath}": ${(parseError as Error).message}`,
      );
    }
  }

  return records;
}
