/**
 * @fileoverview Built-in tool for executing shell commands in the workspace.
 * Delegates process creation, streaming output, timeouts, and lifecycle management
 * directly to the TaskManager instance injected in ToolExecutionContext.
 * @packageDocumentation
 */

import { z } from "zod";
import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { bashDescription } from "./prompts.js";

/**
 * Maximum character length captured in foreground memory before truncating output preview.
 */
const maxBashOutputCharacters = 50000;

/**
 * Default command timeout in milliseconds (60 seconds) when not specified.
 */
const defaultBashTimeoutMs = 60000;

/**
 * Default duration to wait in the foreground before detaching to background task (10 seconds).
 */
const defaultWaitMsBeforeAsync = 10000;

/**
 * Input parameter schema for BashTool.
 */
export const bashInputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      "The shell command string to execute in the workspace directory.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Hard task lifetime in milliseconds before terminating the command (defaults to 60000).",
    ),
  waitMsBeforeAsync: z
    .number()
    .int()
    .min(0)
    .max(60000)
    .optional()
    .describe(
      "Milliseconds to wait in foreground before detaching as a background task. " +
        "0 moves immediately to background; default is 10000ms (10s); max is 60000ms (1m).",
    ),
});

/**
 * Result structure produced by BashTool.
 */
export interface BashOutput {
  /** Execution status of the command or task. */
  readonly status: "running" | "exited" | "killed" | "failed";
  /** The command string executed. */
  readonly command: string;
  /** Unique task identifier managed by TaskManager. */
  readonly taskId: string;
  /** Captured stdout and stderr output text. */
  readonly output: string;
  /** Process exit code, or null if running or terminated by signal without code. */
  readonly exitCode: number | null;
  /** Total elapsed time in milliseconds. */
  readonly durationMs: number;
  /** Whether the output was truncated due to buffer limits. */
  readonly outputTruncated: boolean;
}

/**
 * Built-in tool for executing shell commands.
 * Commands run with the current operating system user's privileges in the workspace directory.
 * The environment is filtered to avoid credential leakage, but execution is not an isolated sandbox.
 */
export class BashTool implements AgentTool<typeof bashInputSchema, BashOutput> {
  public static readonly toolName = "bash";

  public readonly name = BashTool.toolName;
  public readonly description = bashDescription;
  public readonly inputSchema = bashInputSchema;

  /**
   * Executes a shell command by delegating to the context TaskManager.
   *
   * @param parameters - Validated parameters containing command, timeoutMs, and waitMsBeforeAsync.
   * @param context - The execution context with workingDirectory, taskManager, and emitProgress.
   * @returns A promise resolving to the command execution output.
   * @throws Error if context.taskManager is not configured.
   */
  public async execute(
    parameters: z.infer<typeof bashInputSchema>,
    context: ToolExecutionContext,
  ): Promise<BashOutput> {
    if (context.abortSignal?.aborted) {
      throw new Error(
        `Command aborted before execution: ${context.abortSignal.reason ?? "Aborted by signal"}`,
      );
    }

    const taskManager = context.taskManager;
    if (!taskManager) {
      throw new Error(
        "TaskManager is required in ToolExecutionContext to execute Bash commands.",
      );
    }

    const startTime = Date.now();
    const waitMsBeforeAsync =
      parameters.waitMsBeforeAsync ?? defaultWaitMsBeforeAsync;
    const timeoutMs = parameters.timeoutMs ?? defaultBashTimeoutMs;

    let observedOutput = "";
    let isOutputTruncated = false;
    let isObserving = true;

    const onOutput = (chunk: string): void => {
      if (!isObserving) return;
      context.emitProgress?.(chunk);

      if (observedOutput.length < maxBashOutputCharacters) {
        const remaining = maxBashOutputCharacters - observedOutput.length;
        if (chunk.length <= remaining) {
          observedOutput += chunk;
        } else {
          observedOutput += chunk.slice(0, remaining);
          isOutputTruncated = true;
        }
      } else {
        isOutputTruncated = true;
      }
    };

    const task = await taskManager.createTask(
      {
        command: parameters.command,
        cwd: context.workingDirectory,
        timeoutMs,
      },
      { onOutput },
    );

    if (waitMsBeforeAsync === 0) {
      isObserving = false;
      return {
        status: "running",
        command: parameters.command,
        taskId: task.id,
        output: observedOutput,
        exitCode: null,
        durationMs: Date.now() - startTime,
        outputTruncated: isOutputTruncated,
      };
    }

    const waitResult = await taskManager.waitForTask(task.id, {
      timeoutMs: waitMsBeforeAsync,
      signal: context.abortSignal,
    });

    isObserving = false;
    const durationMs = Date.now() - startTime;

    if (waitResult.timedOut) {
      return {
        status: "running",
        command: parameters.command,
        taskId: task.id,
        output: observedOutput,
        exitCode: null,
        durationMs,
        outputTruncated: isOutputTruncated || waitResult.task.outputTruncated,
      };
    }

    const finalStatus: "running" | "exited" | "killed" | "failed" =
      waitResult.task.status === "orphaned"
        ? "exited"
        : (waitResult.task.status as
            "running" | "exited" | "killed" | "failed");

    return {
      status: finalStatus,
      command: parameters.command,
      taskId: task.id,
      output: observedOutput,
      exitCode: waitResult.task.exitCode,
      durationMs,
      outputTruncated: isOutputTruncated || waitResult.task.outputTruncated,
    };
  }
}
