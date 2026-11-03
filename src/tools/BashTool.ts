/**
 * @fileoverview Built-in tool for executing shell commands in the workspace.
 * Handles subprocess execution, streaming chunk progress, timeouts, auto-handoff
 * to background tasks via waitMsBeforeAsync, and killTimeoutMs.
 * @packageDocumentation
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { getSafeBashEnvironment } from "./internal/bashEnvironment.js";
import { bashDescription } from "./prompts.js";

/**
 * Maximum character length captured from stdout/stderr before truncating foreground output.
 */
const maxBashOutputCharacters = 50000;

/**
 * Default command timeout in milliseconds (60 seconds) when backgrounding is not active.
 */
const defaultBashTimeoutMs = 60000;

/**
 * Default duration to wait in foreground before detaching to background task (10 seconds).
 */
const defaultWaitMsBeforeAsync = 10000;

/**
 * Input parameter schema for BashTool.
 */
export const bashInputSchema = z.object({
  command: z
    .string()
    .describe("The shell command string to execute in the workspace directory."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum execution time in milliseconds before terminating the command (defaults to 60000).",
    ),
  waitMsBeforeAsync: z
    .number()
    .int()
    .min(0)
    .max(60000)
    .optional()
    .describe(
      "Milliseconds to wait in the foreground before detaching as a background task. " +
        "0 moves immediately to background; default is 10000 ms (10s); max is 60000 ms (1m).",
    ),
  killTimeoutMs: z
    .number()
    .int()
    .min(60000)
    .max(900000)
    .optional()
    .describe(
      "Optional hard timeout in milliseconds (between 1 minute and 15 minutes) after which the task will be automatically terminated. Disabled by default.",
    ),
});

/**
 * Result structure produced by BashTool.
 */
export interface BashOutput {
  readonly status: "exited" | "running";
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly isTruncated: boolean;
  readonly taskId?: string | undefined;
  readonly message?: string | undefined;
}

/**
 * Built-in tool for executing shell commands.
 */
export class BashTool implements AgentTool<typeof bashInputSchema, BashOutput> {
  public static readonly toolName = "bash";

  public readonly name = BashTool.toolName;
  public readonly description = bashDescription;
  public readonly inputSchema = bashInputSchema;

  /**
   * Executes a shell command within the workspace directory.
   *
   * @param parameters - Validated parameters containing command, waitMsBeforeAsync, and killTimeoutMs.
   * @param context - The execution context with workingDirectory, abortSignal, taskManager, and emitProgress.
   * @returns A promise resolving to the command execution output.
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

    const startTime = Date.now();
    const waitMsBeforeAsync =
      parameters.waitMsBeforeAsync ?? defaultWaitMsBeforeAsync;
    const timeoutMs = parameters.timeoutMs ?? defaultBashTimeoutMs;
    const taskManager = context.taskManager;

    const child = spawn(parameters.command, {
      shell: true,
      cwd: context.workingDirectory,
      env: getSafeBashEnvironment(),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // If immediate backgrounding requested and taskManager is active:
    if (waitMsBeforeAsync === 0 && taskManager) {
      const taskMeta = taskManager.registerProcess({
        command: parameters.command,
        cwd: context.workingDirectory,
        child,
        killTimeoutMs: parameters.killTimeoutMs,
      });

      return {
        status: "running",
        command: parameters.command,
        taskId: taskMeta.id,
        stdout: "",
        stderr: "",
        exitCode: null,
        durationMs: 0,
        isTruncated: false,
        message: `Task started in background as ${taskMeta.id}. Use taskManager to inspect logs, send input, or stop it.`,
      };
    }

    return new Promise<BashOutput>((resolve, reject) => {
      let isSettled = false;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let isTruncated = false;
      let handoffTimer: NodeJS.Timeout | null = null;
      let hardTimeoutTimer: NodeJS.Timeout | null = null;

      const stdoutDecoder = new StringDecoder("utf-8");
      const stderrDecoder = new StringDecoder("utf-8");

      const killProcessGroup = (sig: "SIGTERM" | "SIGKILL" = "SIGTERM"): void => {
        const pid = child.pid;
        if (pid) {
          try {
            process.kill(-pid, sig);
          } catch {
            try {
              child.kill(sig);
            } catch {
              // Ignore
            }
          }
        }
      };

      const handleAbort = (): void => {
        if (!isSettled) {
          isSettled = true;
          if (handoffTimer) clearTimeout(handoffTimer);
          if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
          killProcessGroup("SIGTERM");
          setTimeout(() => {
            killProcessGroup("SIGKILL");
          }, 2000).unref();
          reject(
            new Error(
              `Command aborted: ${context.abortSignal?.reason ?? "Aborted by signal"}`,
            ),
          );
        }
      };

      if (context.abortSignal) {
        context.abortSignal.addEventListener("abort", handleAbort, {
          once: true,
        });
      }

      const onStdoutData = (chunk: Buffer): void => {
        const text = stdoutDecoder.write(chunk);
        context.emitProgress?.(text);

        if (stdoutBuffer.length + text.length > maxBashOutputCharacters) {
          const remaining = maxBashOutputCharacters - stdoutBuffer.length;
          if (remaining > 0) {
            stdoutBuffer += text.slice(0, remaining);
          }
          isTruncated = true;
        } else {
          stdoutBuffer += text;
        }
      };

      const onStderrData = (chunk: Buffer): void => {
        const text = stderrDecoder.write(chunk);
        context.emitProgress?.(text);

        if (stderrBuffer.length + text.length > maxBashOutputCharacters) {
          const remaining = maxBashOutputCharacters - stderrBuffer.length;
          if (remaining > 0) {
            stderrBuffer += text.slice(0, remaining);
          }
          isTruncated = true;
        } else {
          stderrBuffer += text;
        }
      };

      child.stdout.on("data", onStdoutData);
      child.stderr.on("data", onStderrData);

      const cleanupForegroundListeners = (): void => {
        child.stdout.removeListener("data", onStdoutData);
        child.stderr.removeListener("data", onStderrData);
        if (context.abortSignal) {
          context.abortSignal.removeEventListener("abort", handleAbort);
        }
        if (handoffTimer) clearTimeout(handoffTimer);
        if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
      };

      // Set up handoff timer if taskManager is available
      if (taskManager) {
        handoffTimer = setTimeout(() => {
          if (!isSettled) {
            isSettled = true;
            cleanupForegroundListeners();

            const taskMeta = taskManager.registerProcess({
              command: parameters.command,
              cwd: context.workingDirectory,
              child,
              initialStdout: stdoutBuffer,
              initialStderr: stderrBuffer,
              killTimeoutMs: parameters.killTimeoutMs,
            });

            resolve({
              status: "running",
              command: parameters.command,
              taskId: taskMeta.id,
              stdout: stdoutBuffer,
              stderr: stderrBuffer,
              exitCode: null,
              durationMs: Date.now() - startTime,
              isTruncated,
              message: `Command exceeded foreground wait of ${waitMsBeforeAsync}ms and was detached to background task ${taskMeta.id}. Use taskManager to inspect logs or send input.`,
            });
          }
        }, waitMsBeforeAsync);
      } else {
        // Fallback hard timeout when taskManager is not present
        hardTimeoutTimer = setTimeout(() => {
          if (!isSettled) {
            isSettled = true;
            cleanupForegroundListeners();
            killProcessGroup("SIGTERM");
            reject(
              new Error(
                `Command timed out after ${timeoutMs}ms: '${parameters.command}'`,
              ),
            );
          }
        }, timeoutMs);
      }

      child.on("error", (error: Error) => {
        if (!isSettled) {
          isSettled = true;
          cleanupForegroundListeners();
          reject(error);
        }
      });

      child.on("close", (code: number | null) => {
        if (!isSettled) {
          isSettled = true;
          cleanupForegroundListeners();

          const durationMs = Date.now() - startTime;
          const exitCode = code ?? (child.killed ? 130 : 0);

          stdoutBuffer += stdoutDecoder.end();
          stderrBuffer += stderrDecoder.end();

          if (isTruncated) {
            stdoutBuffer += "\n... [output truncated at 50,000 characters]";
          }

          resolve({
            status: "exited",
            command: parameters.command,
            stdout: stdoutBuffer,
            stderr: stderrBuffer,
            exitCode,
            durationMs,
            isTruncated,
          });
        }
      });
    });
  }
}
