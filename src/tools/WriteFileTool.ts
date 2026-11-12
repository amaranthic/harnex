/**
 * @fileoverview Built-in tool for writing files to the workspace.
 * Handles automatic parent directory creation and atomic writes to avoid partial writes.
 * @packageDocumentation
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { resolvePathWithinWorkspace } from "./internal/pathGuard.js";
import { atomicWriteFile } from "../storage/atomicFile.js";
import { withWorkspaceFileLock } from "../storage/workspaceLock.js";
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
export class WriteFileTool implements AgentTool<
  typeof writeFileInputSchema,
  WriteFileOutput
> {
  public static readonly toolName = "writeFile";

  public readonly name = WriteFileTool.toolName;
  public readonly description = writeFileDescription;
  public readonly inputSchema = writeFileInputSchema;

  /**
   * Executes the file writing operation atomically, automatically capturing
   * a content-addressed checkpoint snapshot if checkpointing is enabled on the thread.
   *
   * @param parameters - Validated parameters containing filePath and content.
   * @param context - The execution context with workingDirectory and checkpoint store.
   * @returns A promise resolving to the structured write result.
   */
  public async execute(
    parameters: z.infer<typeof writeFileInputSchema>,
    context: ToolExecutionContext,
  ): Promise<WriteFileOutput> {
    return await withWorkspaceFileLock(
      context.workingDirectory,
      parameters.filePath,
      async () => {
        const fullPath = resolvePathWithinWorkspace(
          parameters.filePath,
          context.workingDirectory,
        );
        const fileExisted = existsSync(fullPath);
        const relativeFilePath = path.relative(
          context.workingDirectory,
          fullPath,
        );

        let checkpointId: string | undefined;

        // 1. Pre-mutation checkpoint capture
        if (context.isCheckpointEnabled && context.checkpointStore) {
          try {
            const cpRecord = await context.checkpointStore.createCheckpoint(
              context.threadId,
              {
                workingDirectory: context.workingDirectory,
                turnIndex: context.turnIndex,
                label: `writeFile: ${parameters.filePath}`,
                files: [relativeFilePath],
                source: { toolName: WriteFileTool.toolName },
              },
            );
            checkpointId = cpRecord.id;
          } catch (error) {
            throw new Error(
              `Failed to record pre-mutation checkpoint for '${parameters.filePath}': ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        const buffer = Buffer.from(parameters.content, "utf-8");

        // 2. Perform file write atomically
        await atomicWriteFile(fullPath, buffer);

        // 3. Post-mutation checkpoint finalization
        if (
          context.isCheckpointEnabled &&
          context.checkpointStore &&
          checkpointId
        ) {
          try {
            const updatedRecord =
              await context.checkpointStore.updateCheckpoint(
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

        const lineCount = parameters.content.split("\n").length;

        return {
          filePath: parameters.filePath,
          bytesWritten: buffer.length,
          linesWritten: lineCount,
          status: fileExisted ? "overwritten" : "created",
        };
      },
    );
  }
}
