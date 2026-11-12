/**
 * @fileoverview Built-in tool for managing background shell tasks spawned by BashTool.
 * Restricts model actions to inspecting and managing active/recent tasks:
 * listing tasks, line-paged log inspection, interactive stdin delivery,
 * process termination, and deleting completed task logs.
 * @packageDocumentation
 */

import { z } from "zod";
import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { taskManagerDescription } from "./prompts.js";
import type {
  TaskReadResult,
  TaskSendInputResult,
  TaskStopResult,
  TaskSummary,
} from "../tasks/index.js";

/**
 * Zod schema for TaskManagerTool inputs using a discriminated union on the "action" field.
 * Restricts model actions to inspecting and managing existing tasks (list, read, sendInput, stop, delete).
 * Task creation is performed exclusively by the model via BashTool.
 */
export const taskManagerInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z
      .literal("list")
      .describe("List all active and recently completed background tasks."),
  }),
  z.object({
    action: z
      .literal("read")
      .describe("Read a line-paged slice of output logs from a task."),
    taskId: z.string().describe("The unique task identifier to inspect."),
    offset: z
      .number()
      .int()
      .min(1)
      .describe("1-based line number to begin reading from (required)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .describe("Maximum number of lines to return, up to 500 (required)."),
  }),
  z.object({
    action: z
      .literal("sendInput")
      .describe(
        "Deliver text into standard input of a running background task.",
      ),
    taskId: z
      .string()
      .describe("The unique task identifier of the target process."),
    input: z.string().describe("Text payload to write into stdin."),
    newline: z
      .boolean()
      .optional()
      .describe("Whether to append a trailing newline (defaults to true)."),
  }),
  z.object({
    action: z
      .literal("stop")
      .describe("Terminate a background task process and its process tree."),
    taskId: z.string().describe("The unique task identifier to terminate."),
    signal: z
      .enum(["SIGTERM", "SIGKILL"])
      .optional()
      .describe("Termination signal to dispatch (defaults to SIGTERM)."),
  }),
  z.object({
    action: z
      .literal("delete")
      .describe("Delete a completed or terminated task record and its logs."),
    taskId: z.string().describe("The unique task identifier to delete."),
  }),
]);

/**
 * TypeScript type inferred from taskManagerInputSchema.
 */
export type TaskManagerInput = z.infer<typeof taskManagerInputSchema>;

/**
 * Result structure produced by TaskManagerTool operations.
 */
export type TaskManagerOutput =
  | {
      readonly action: "list";
      readonly tasks: readonly TaskSummary[];
      readonly count: number;
    }
  | ({
      readonly action: "read";
    } & TaskReadResult)
  | ({
      readonly action: "sendInput";
    } & TaskSendInputResult)
  | ({
      readonly action: "stop";
    } & TaskStopResult)
  | {
      readonly action: "delete";
      readonly taskId: string;
      readonly deleted: boolean;
    };

/**
 * Built-in tool for managing background shell tasks.
 */
export class TaskManagerTool implements AgentTool<
  typeof taskManagerInputSchema,
  TaskManagerOutput
> {
  public static readonly toolName = "taskManager";

  public readonly name = TaskManagerTool.toolName;
  public readonly description = taskManagerDescription;
  public readonly inputSchema = taskManagerInputSchema;

  /**
   * Executes task management actions against background processes.
   *
   * @param parameters - Discriminated union of task management parameters (list, read, sendInput, stop, delete).
   * @param context - The execution context containing taskManager.
   * @returns The action-specific execution output.
   * @throws Error if taskManager is not configured in the execution context.
   */
  public async execute(
    parameters: TaskManagerInput,
    context: ToolExecutionContext,
  ): Promise<TaskManagerOutput> {
    const taskManager = context.taskManager;
    if (!taskManager) {
      throw new Error(
        "TaskManager is not active in this execution context. Background task management requires TaskManager to be configured.",
      );
    }

    switch (parameters.action) {
      case "list": {
        const tasks = taskManager.listTasks();
        return {
          action: "list",
          tasks,
          count: tasks.length,
        };
      }

      case "read": {
        const result = await taskManager.readTask(
          parameters.taskId,
          parameters.offset,
          parameters.limit,
        );
        return {
          action: "read",
          ...result,
        };
      }

      case "sendInput": {
        const result = await taskManager.sendTaskInput(
          parameters.taskId,
          parameters.input,
          { newline: parameters.newline },
        );
        return {
          action: "sendInput",
          ...result,
        };
      }

      case "stop": {
        const result = await taskManager.stopTask(parameters.taskId, {
          signal: parameters.signal,
        });
        return {
          action: "stop",
          ...result,
        };
      }

      case "delete": {
        const deleted = await taskManager.deleteTask(parameters.taskId);
        return {
          action: "delete",
          taskId: parameters.taskId,
          deleted,
        };
      }
    }
  }
}
