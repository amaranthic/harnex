/**
 * @fileoverview Built-in tool for managing background shell tasks spawned by BashTool.
 * Supports listing tasks, line-paged log reading, sending stdin input, and terminating processes.
 * @packageDocumentation
 */

import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { taskManagerDescription } from "./prompts.js";
import {
  taskManagerInputSchema,
  type TaskManagerInput,
  type TaskReadResult,
  type TaskSendInputResult,
  type TaskStopResult,
  type TaskSummary,
} from "./tasks/types.js";

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
    } & TaskStopResult);

/**
 * Built-in tool for managing background shell tasks.
 */
export class TaskManagerTool
  implements AgentTool<typeof taskManagerInputSchema, TaskManagerOutput>
{
  public static readonly toolName = "taskManager";

  public readonly name = TaskManagerTool.toolName;
  public readonly description = taskManagerDescription;
  public readonly inputSchema = taskManagerInputSchema;

  /**
   * Executes task management actions against background processes.
   *
   * @param parameters - Discriminated union of task management parameters (list, read, sendInput, stop).
   * @param context - The execution context containing taskManager.
   * @returns The action-specific execution output.
   * @throws Error if taskManager is not configured in the session.
   */
  public async execute(
    parameters: TaskManagerInput,
    context: ToolExecutionContext,
  ): Promise<TaskManagerOutput> {
    const taskManager = context.taskManager;
    if (!taskManager) {
      throw new Error(
        "TaskManager is not active in this session. Background task management requires BashTool to be active.",
      );
    }

    switch (parameters.action) {
      case "list": {
        const tasks = taskManager.list();
        return {
          action: "list",
          tasks,
          count: tasks.length,
        };
      }

      case "read": {
        const result = await taskManager.read(
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
        const result = await taskManager.sendInput(
          parameters.taskId,
          parameters.input,
          parameters.newline,
        );
        return {
          action: "sendInput",
          ...result,
        };
      }

      case "stop": {
        const result = await taskManager.stop(
          parameters.taskId,
          parameters.signal,
        );
        return {
          action: "stop",
          ...result,
        };
      }
    }
  }
}
