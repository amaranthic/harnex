/**
 * @fileoverview Built-in tool for writing files to the workspace.
 * Handles automatic parent directory creation and atomic writes to avoid partial writes.
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
import { writeFileDescription } from "./prompts.js";

/**
 * Input parameter schema for WriteFileTool.
 */
export const writeFileInputSchema = z.object({
  filePath: z
    .string()
    .describe("The relative or absolute file path to create or overwrite."),
  content: z
    .string()
    .describe("The complete text content to write into the file."),
});

/**
 * Result structure produced by WriteFileTool.
 */
export interface WriteFileOutput {
  readonly filePath: string;
  readonly bytesWritten: number;
  readonly linesWritten: number;
  readonly status: "created" | "overwritten";
}

/**
 * Built-in tool for creating or overwriting files.
 */
export class WriteFileTool
  implements AgentTool<typeof writeFileInputSchema, WriteFileOutput>
{
  public static readonly toolName = "writeFile";

  public readonly name = WriteFileTool.toolName;
  public readonly description = writeFileDescription;
  public readonly inputSchema = writeFileInputSchema;

  /**
   * Executes the file writing operation atomically, automatically capturing
   * a content-addressed checkpoint snapshot if checkpointing is enabled on the session.
   *
   * @param parameters - Validated parameters containing filePath and content.
   * @param context - The execution context with workingDirectory and checkpoint store.
   * @returns A promise resolving to the structured write result.
   */
  public async execute(
    parameters: z.infer<typeof writeFileInputSchema>,
    context: ToolExecutionContext,
  ): Promise<WriteFileOutput> {
    const fullPath = resolvePathWithinWorkspace(
      parameters.filePath,
      context.workingDirectory,
    );
    const fileExisted = existsSync(fullPath);
    let beforeHash: string | undefined;

    // [NOTED: Phase 3 will migrate to snapshot before/after hash lifecycle]
    if (context.isCheckpointEnabled && context.checkpointStore && fileExisted) {
      try {
        const existingContent = await readFile(fullPath);
        beforeHash = await context.checkpointStore.storeBlob(existingContent);
      } catch (error) {
        throw new Error(
          `Failed to record pre-mutation checkpoint for '${parameters.filePath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const buffer = Buffer.from(parameters.content, "utf-8");

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
          toolName: WriteFileTool.toolName,
          timestamp: Date.now(),
          coverage: "partial",
          files: [
            {
              relativePath: relativeFilePath,
              ...(beforeHash ? { beforeHash } : {}),
              afterHash,
              status: fileExisted ? "~" : "+",
            },
          ],
        });
        context.onCheckpointCreated?.({
          checkpointId,
          sequence: record.sequence,
          label: `WriteFile: ${parameters.filePath}`,
          filesTouched: [parameters.filePath],
        });
      } catch (error) {
        throw new Error(
          `Failed to record post-mutation checkpoint for '${parameters.filePath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const lineCount = parameters.content.split("\n").length;

    return {
      filePath: parameters.filePath,
      bytesWritten: buffer.length,
      linesWritten: lineCount,
      status: fileExisted ? "overwritten" : "created",
    };
  }
}
