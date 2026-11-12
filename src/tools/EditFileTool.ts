/**
 * @fileoverview Built-in tool for making targeted replacements within existing files.
 * Validates match uniqueness and performs atomic file replacement with snapshot support.
 * @packageDocumentation
 */

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
    .describe("The relative or absolute file path of the file to modify."),
  oldString: z
    .string()
    .describe(
      "The exact string to find and replace. Must match the file content identically including whitespace.",
    ),
  newString: z
    .string()
    .describe("The replacement string to insert in place of oldString."),
  replaceAll: z
    .boolean()
    .optional()
    .describe(
      "If true, replace every occurrence of oldString. If false (default), oldString must appear exactly once.",
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
 * Built-in tool for targeted file editing.
 */
export class EditFileTool implements AgentTool<
  typeof editFileInputSchema,
  EditFileOutput
> {
  public static readonly toolName = "editFile";

  public readonly name = EditFileTool.toolName;
  public readonly description = editFileDescription;
  public readonly inputSchema = editFileInputSchema;

  /**
   * Executes the edit operation atomically, capturing a content-addressed checkpoint
   * snapshot before and after the replacement if checkpointing is enabled.
   *
   * @param parameters - Validated parameters containing filePath, oldString, newString, and replaceAll.
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

    const relativeFilePath = path.relative(context.workingDirectory, fullPath);
    let checkpointId: string | undefined;

    // 1. Pre-mutation checkpoint capture
    if (context.isCheckpointEnabled && context.checkpointStore) {
      try {
        const cpRecord = await context.checkpointStore.createCheckpoint(
          context.threadId,
          {
            workingDirectory: context.workingDirectory,
            turnIndex: context.turnIndex,
            label: `editFile: ${parameters.filePath}`,
            files: [relativeFilePath],
            source: { toolName: EditFileTool.toolName },
          },
        );
        checkpointId = cpRecord.id;
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

    // 2. Perform file write atomically
    await atomicWriteFile(fullPath, buffer);

    // 3. Post-mutation checkpoint finalization
    if (
      context.isCheckpointEnabled &&
      context.checkpointStore &&
      checkpointId
    ) {
      try {
        const updatedRecord = await context.checkpointStore.updateCheckpoint(
          context.threadId,
          checkpointId,
          context.workingDirectory,
        );
        context.onCheckpointCreated?.({
          checkpointId: updatedRecord.id,
          sequence: updatedRecord.sequence,
          label: updatedRecord.label,
          filesTouched: [relativeFilePath],
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
