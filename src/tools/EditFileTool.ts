/**
 * @fileoverview Built-in tool for surgical file edits.
 * Enforces exact string matching, uniqueness validation, and atomic replacement.
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { resolvePathWithinWorkspace } from "./internal/pathGuard.js";
import { atomicWriteFile } from "../storage/atomicFile.js";
import { editFileDescription } from "./prompts.js";

/**
 * Input parameter schema for EditFileTool.
 */
export const editFileInputSchema = z.object({
  filePath: z
    .string()
    .describe("The relative or absolute path of the file to edit."),
  oldString: z
    .string()
    .describe("The exact existing text within the file to replace."),
  newString: z
    .string()
    .describe("The replacement text to insert in place of oldString."),
  replaceAll: z
    .boolean()
    .optional()
    .describe(
      "Set to true to replace all occurrences. Defaults to false (replaces single unique match).",
    ),
});

/**
 * Result structure produced by EditFileTool.
 */
export interface EditFileOutput {
  readonly filePath: string;
  readonly replacementsApplied: number;
  readonly bytesWritten: number;
}

/**
 * Built-in tool for surgical in-place string replacements in files.
 */
export class EditFileTool
  implements AgentTool<typeof editFileInputSchema, EditFileOutput>
{
  public static readonly toolName = "editFile";

  public readonly name = EditFileTool.toolName;
  public readonly description = editFileDescription;
  public readonly inputSchema = editFileInputSchema;

  /**
   * Executes the in-place string replacement operation, capturing a content-addressed
   * delta checkpoint if checkpointing is enabled on the session.
   *
   * @param parameters - Validated parameters containing filePath, oldString, newString, replaceAll.
   * @param context - The execution context with workingDirectory and checkpoint store.
   * @returns A promise resolving to the structured edit result.
   */
  public async execute(
    parameters: z.infer<typeof editFileInputSchema>,
    context: ToolExecutionContext,
  ): Promise<EditFileOutput> {
    if (parameters.oldString === parameters.newString) {
      throw new Error(
        "No changes to make: oldString and newString are identical.",
      );
    }

    const fullPath = resolvePathWithinWorkspace(
      parameters.filePath,
      context.workingDirectory,
    );

    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${parameters.filePath}`);
    }

    const rawContent = await readFile(fullPath, "utf-8");

    if (!rawContent.includes(parameters.oldString)) {
      throw new Error(
        `String to replace not found in file '${parameters.filePath}'. ` +
          "Ensure whitespace, indentation, and newlines match the file exactly.",
      );
    }

    const occurrences = rawContent.split(parameters.oldString).length - 1;

    if (occurrences > 1 && !parameters.replaceAll) {
      throw new Error(
        `Found ${occurrences} matches of the string to replace, but replaceAll is false. ` +
          "To replace all occurrences, set replaceAll to true. " +
          "To replace only one occurrence, provide more surrounding context to uniquely identify the instance.",
      );
    }

    let beforeHash: string | undefined;
    // [NOTED: Phase 3 will migrate to snapshot before/after hash lifecycle]
    if (context.isCheckpointEnabled && context.checkpointStore) {
      try {
        beforeHash = await context.checkpointStore.storeBlob(
          Buffer.from(rawContent, "utf-8"),
        );
      } catch (error) {
        throw new Error(
          `Failed to record pre-mutation checkpoint for '${parameters.filePath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Function replacer avoids interpreting $&, $1, $$, etc. as special substitution patterns
    const replacer = (): string => parameters.newString;
    const updatedContent = parameters.replaceAll
      ? rawContent.replaceAll(parameters.oldString, replacer)
      : rawContent.replace(parameters.oldString, replacer);

    const buffer = Buffer.from(updatedContent, "utf-8");

    // Write file atomically using shared atomicWriteFile
    await atomicWriteFile(fullPath, buffer);

    // [NOTED: Phase 3 will migrate to snapshot before/after hash lifecycle]
    if (context.isCheckpointEnabled && context.checkpointStore) {
      try {
        const afterHash = await context.checkpointStore.storeBlob(buffer);
        const relativeFilePath = path.relative(context.workingDirectory, fullPath);
        const checkpointId = `cp_${Date.now()}_${randomUUID().slice(0, 8)}`;
        const record = await context.checkpointStore.createCheckpoint(context.threadId, {
          id: checkpointId,
          threadId: context.threadId,
          turnIndex: 0,
          toolName: EditFileTool.toolName,
          timestamp: Date.now(),
          coverage: "partial",
          files: [
            {
              relativePath: relativeFilePath,
              ...(beforeHash ? { beforeHash } : {}),
              afterHash,
              status: "~",
            },
          ],
        });
        context.onCheckpointCreated?.({
          checkpointId,
          sequence: record.sequence,
          label: `EditFile: ${parameters.filePath}`,
          filesTouched: [parameters.filePath],
        });
      } catch (error) {
        throw new Error(
          `Failed to record post-mutation checkpoint for '${parameters.filePath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      filePath: parameters.filePath,
      replacementsApplied: parameters.replaceAll ? occurrences : 1,
      bytesWritten: buffer.length,
    };
  }
}
