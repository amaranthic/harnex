/**
 * @fileoverview Autonomous multi-step turn runner for the agent engine microkernel.
 * @packageDocumentation
 */

import { streamText, type HernexStreamTextOptions } from "../runtime.js";
import type { ModelMessage } from "../model/types.js";
import type { AgentEvent, JsonValue, ErrorInfo } from "../events/index.js";
import type { StepTokenUsage, TurnFinishReason } from "../events/stepEvents.js";
import type { CheckpointCreatedEvent } from "../events/checkpointEvents.js";
import type { AgentEngineConfig, RunTurnOptions } from "./engineConfig.js";
import type { ToolExecutionContext } from "../tools/ToolExecutionContext.js";
import { AsyncEventQueue } from "./eventQueue.js";
import { CURRENT_TRANSCRIPT_VERSION } from "../threads/transcriptMigration.js";

/**
 * Extracts normalized provider identifier from a model string if formatted as "provider/model_id".
 */
function getModelProvider(model: string | unknown): string | undefined {
  if (typeof model === "string") {
    const slashIndex = model.indexOf("/");
    if (slashIndex > 0) {
      return model.slice(0, slashIndex).trim().toLowerCase();
    }
  }
  return undefined;
}

/**
 * Converts any unknown error into a normalized serializable ErrorInfo object.
 */
function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(typeof (error as unknown as { code?: unknown }).code === "string"
        ? { code: (error as unknown as { code: string }).code }
        : {}),
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

/**
 * Converts any arbitrary value into pure serializable JSON-compatible data.
 */
function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

/**
 * Combines multiple AbortSignal instances into a single signal.
 */
function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined | null>
): AbortSignal | undefined {
  const activeSignals = signals.filter((s): s is AbortSignal => Boolean(s));
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }
  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

/**
 * Runs a single autonomous turn within the agent engine microkernel.
 *
 * @param config - The active engine configuration.
 * @param options - Per-turn options including user prompt and overrides.
 * @param conversationMessages - Mutable array of thread conversation messages.
 * @returns An async generator yielding pure serializable `AgentEvent` objects.
 */
export async function* runTurn(
  config: AgentEngineConfig,
  options: RunTurnOptions,
  conversationMessages: ModelMessage[],
): AsyncGenerator<AgentEvent, void, void> {
  const turnIndex = options.turnIndex ?? 1;
  const userPrompt = options.userPrompt;
  const turnAbortController = new AbortController();
  const effectiveSignal = combineAbortSignals(
    options.abortSignal,
    config.abortSignal,
    turnAbortController.signal,
  );
  const maxSteps = options.maxSteps ?? config.maxSteps ?? 25;
  const reasoning = options.reasoning ?? config.reasoning;

  // Persistence and Checkpoint invariants: if persist is false, checkpoint is strictly false
  const isPersist = Boolean(config.persist ?? Boolean(config.threadStore));
  const isCheckpointEnabled =
    isPersist && Boolean(config.checkpoint ?? Boolean(config.checkpointStore));

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalReasoningTokens = 0;

  const buildTotalUsage = (): StepTokenUsage => {
    const usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
    } = {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens,
    };
    if (totalReasoningTokens > 0) {
      usage.reasoningTokens = totalReasoningTokens;
    }
    return usage;
  };

  let finishReason: TurnFinishReason = "completed";
  const initialHistoryLength = conversationMessages.length;
  let hasEmittedTurnFinished = false;

  const finalizeTurn = async function* (
    finalReason: TurnFinishReason,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    if (hasEmittedTurnFinished) {
      return;
    }
    hasEmittedTurnFinished = true;

    // 1. Persist turnFinished to thread store FIRST
    if (config.threadStore) {
      try {
        await config.threadStore.appendTranscript(config.threadId, {
          version: CURRENT_TRANSCRIPT_VERSION,
          type: "turnFinished",
          turnIndex,
          finishReason: finalReason,
          usage: buildTotalUsage(),
          timestamp: Date.now(),
        });
      } catch (persistenceError) {
        // Emit error as non-fatal secondary diagnostic; do not crash terminal event emission
        yield {
          type: "error",
          origin: "engine",
          error: toErrorInfo(
            persistenceError instanceof Error
              ? persistenceError
              : new Error(String(persistenceError)),
          ),
          isFatal: false,
        };
      }
    }

    // 2. Emit turnFinished event exactly once
    yield {
      type: "turnFinished",
      turnIndex,
      finishReason: finalReason,
      totalUsage: buildTotalUsage(),
    };
  };

  try {
    // Partial credential override check
    const hasPartialApiKey = options.apiKey !== undefined;
    const hasPartialBaseUrl = options.baseUrl !== undefined;
    if (
      (hasPartialApiKey && !hasPartialBaseUrl) ||
      (!hasPartialApiKey && hasPartialBaseUrl)
    ) {
      throw new Error(
        "Per-turn credential override is incomplete: both apiKey and baseUrl must be provided together.",
      );
    }

    // Credential invariant check: ensure per-turn model cannot silently reuse another provider's credentials
    if (options.model !== undefined) {
      const isConfigString = typeof config.model === "string";
      const isOverrideString = typeof options.model === "string";

      if (!isConfigString || !isOverrideString) {
        if (!options.apiKey || !options.baseUrl) {
          throw new Error(
            "Per-turn model override with LanguageModel instance requires explicit per-turn credentials (both apiKey and baseUrl).",
          );
        }
      } else {
        const configProvider = getModelProvider(config.model);
        const overrideProvider = getModelProvider(options.model);
        if (
          overrideProvider &&
          configProvider &&
          overrideProvider !== configProvider &&
          (!options.apiKey || !options.baseUrl)
        ) {
          throw new Error(
            `Per-turn model override changed provider from "${configProvider}" to "${overrideProvider}", but explicit per-turn credentials (apiKey and baseUrl) were not supplied. Falling back across different providers is forbidden.`,
          );
        }
      }
    }

    // 1. Emit 'turnStarted'
    yield {
      type: "turnStarted",
      turnIndex,
      userMessage: userPrompt,
    };

    if (config.threadStore) {
      await config.threadStore.appendTranscript(config.threadId, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "turnStarted",
        turnIndex,
        userPrompt,
        timestamp: Date.now(),
      });
    }

    // 2. Call hooks.onBeforeTurn() -> await product decision
    let effectiveUserPrompt = userPrompt;
    let injectedInstructions = "";
    if (config.hooks?.onBeforeTurn) {
      const beforeTurnResult = await config.hooks.onBeforeTurn({
        turnIndex,
        userPrompt,
      });

      if (beforeTurnResult) {
        if (beforeTurnResult.veto) {
          finishReason = "vetoed";
          yield* finalizeTurn("vetoed");
          return;
        }
        if (beforeTurnResult.userPrompt) {
          effectiveUserPrompt = beforeTurnResult.userPrompt;
        }
        if (beforeTurnResult.injectedInstructions) {
          injectedInstructions = beforeTurnResult.injectedInstructions;
        }
      }
    }

    // Append user message to conversation history
    const userMessage: ModelMessage = {
      role: "user",
      content: effectiveUserPrompt,
    };
    conversationMessages.push(userMessage);

    if (config.threadStore) {
      await config.threadStore.appendTranscript(config.threadId, {
        version: CURRENT_TRANSCRIPT_VERSION,
        type: "modelMessage",
        turnIndex,
        message: userMessage,
        timestamp: Date.now(),
      });
    }

    // Combined instructions for this turn
    const combinedInstructions = [config.instructions, injectedInstructions]
      .filter((s): s is string => Boolean(s && s.trim().length > 0))
      .join("\n\n");

    // 3. Step Loop (1 to maxSteps)
    for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex++) {
      if (effectiveSignal?.aborted) {
        finishReason = "interrupted";
        break;
      }

      yield {
        type: "stepStarted",
        stepIndex,
        timestamp: Date.now(),
      };

      const sdkToolDefinitions = config.tools.toSdkToolDefinitions();
      const hasTools = Object.keys(sdkToolDefinitions).length > 0;

      const streamOptions: HernexStreamTextOptions = {
        model: options.model ?? config.model,
        apiKey: options.apiKey ?? config.apiKey,
        baseUrl: options.baseUrl ?? config.baseUrl,
        ...(config.providerRegistry
          ? { providerRegistry: config.providerRegistry }
          : {}),
        messages: conversationMessages,
        ...(combinedInstructions ? { instructions: combinedInstructions } : {}),
        ...(hasTools ? { tools: sdkToolDefinitions } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(effectiveSignal ? { abortSignal: effectiveSignal } : {}),
      };

      const proposedToolCalls: Array<{
        callId: string;
        toolName: string;
        parameters: unknown;
      }> = [];

      const streamResult = streamText(streamOptions);

      for await (const chunk of streamResult.stream) {
        if (chunk.type === "text-delta") {
          yield {
            type: "tokenDelta",
            text: chunk.text,
            messageId: chunk.id,
          };
        } else if (chunk.type === "reasoning-delta") {
          yield {
            type: "thoughtDelta",
            text: chunk.text,
            messageId: chunk.id,
          };
        } else if (chunk.type === "tool-call") {
          const toolCall = {
            callId: chunk.toolCallId,
            toolName: chunk.toolName,
            parameters: chunk.input,
          };
          proposedToolCalls.push(toolCall);
          yield {
            type: "toolCallProposed",
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            parameters: toJsonValue(toolCall.parameters),
          };
        } else if (chunk.type === "error") {
          const streamError =
            chunk.error instanceof Error
              ? chunk.error
              : new Error(String(chunk.error));
          yield {
            type: "error",
            origin: "model",
            error: toErrorInfo(streamError),
            isFatal: false,
          };
        }
      }

      const responseMessages: ModelMessage[] = [
        ...(await streamResult.responseMessages),
      ];
      const rawUsage = await streamResult.usage;

      // Collect assistant response messages and step token metrics
      conversationMessages.push(...responseMessages);
      if (config.threadStore) {
        for (const msg of responseMessages) {
          await config.threadStore.appendTranscript(config.threadId, {
            version: CURRENT_TRANSCRIPT_VERSION,
            type: "modelMessage",
            turnIndex,
            message: msg,
            timestamp: Date.now(),
          });
        }
      }

      const stepUsage: StepTokenUsage = {
        promptTokens: rawUsage.inputTokens ?? 0,
        completionTokens: rawUsage.outputTokens ?? 0,
        totalTokens: rawUsage.totalTokens ?? 0,
        ...(typeof rawUsage.outputTokenDetails?.reasoningTokens === "number"
          ? { reasoningTokens: rawUsage.outputTokenDetails.reasoningTokens }
          : {}),
      };

      totalPromptTokens += stepUsage.promptTokens;
      totalCompletionTokens += stepUsage.completionTokens;
      totalTokens += stepUsage.totalTokens;
      if (stepUsage.reasoningTokens) {
        totalReasoningTokens += stepUsage.reasoningTokens;
      }

      // If the model called no tools, evaluate whether stopping is allowed
      if (proposedToolCalls.length === 0) {
        if (config.hooks?.onShouldStop) {
          const stopDecision = await config.hooks.onShouldStop({
            turnIndex,
            finishReason: "completed",
            transcript: conversationMessages,
          });

          if (!stopDecision.shouldStop) {
            const reminderMessage: ModelMessage = {
              role: "user",
              content: stopDecision.reminderPrompt,
            };
            conversationMessages.push(reminderMessage);

            if (config.threadStore) {
              await config.threadStore.appendTranscript(config.threadId, {
                version: CURRENT_TRANSCRIPT_VERSION,
                type: "modelMessage",
                turnIndex,
                message: reminderMessage,
                timestamp: Date.now(),
              });
            }

            yield {
              type: "stepFinished",
              stepIndex,
              usage: stepUsage,
            };

            continue;
          }
        }

        yield {
          type: "stepFinished",
          stepIndex,
          usage: stepUsage,
        };

        finishReason = "completed";
        break;
      }

      // Execute proposed tools
      const toolResults: Array<{
        toolCallId: string;
        toolName: string;
        result: unknown;
        isError: boolean;
      }> = [];

      for (const toolCall of proposedToolCalls) {
        if (effectiveSignal?.aborted) {
          finishReason = "interrupted";
          break;
        }

        const agentTool = config.tools.resolve(toolCall.toolName);

        if (!agentTool) {
          const missingErrorResult = {
            isError: true,
            error: `Tool "${toolCall.toolName}" is not registered in the tool registry.`,
          };

          yield {
            type: "toolExecutionFinished",
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            result: toJsonValue(missingErrorResult),
            isError: true,
            durationMs: 0,
          };

          toolResults.push({
            toolCallId: toolCall.callId,
            toolName: toolCall.toolName,
            result: missingErrorResult,
            isError: true,
          });

          if (config.threadStore) {
            await config.threadStore.appendTranscript(config.threadId, {
              version: CURRENT_TRANSCRIPT_VERSION,
              type: "toolResult",
              turnIndex,
              callId: toolCall.callId,
              toolName: toolCall.toolName,
              result: missingErrorResult,
              isError: true,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        // Validate tool input parameters before authorization
        let parsedParameters: unknown;
        try {
          parsedParameters = agentTool.inputSchema.parse(toolCall.parameters);
        } catch (validationError) {
          const schemaErrorResult = {
            isError: true,
            error: `Schema validation error for tool "${toolCall.toolName}": ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          };

          yield {
            type: "toolExecutionFinished",
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            result: toJsonValue(schemaErrorResult),
            isError: true,
            durationMs: 0,
          };

          toolResults.push({
            toolCallId: toolCall.callId,
            toolName: toolCall.toolName,
            result: schemaErrorResult,
            isError: true,
          });

          if (config.threadStore) {
            await config.threadStore.appendTranscript(config.threadId, {
              version: CURRENT_TRANSCRIPT_VERSION,
              type: "toolResult",
              turnIndex,
              callId: toolCall.callId,
              toolName: toolCall.toolName,
              result: schemaErrorResult,
              isError: true,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        // Tool authorization check - FAIL CLOSED BY DEFAULT FOR ALL TOOLS
        let isAllowed = false;
        let denialReason =
          "Tool execution denied: no authorization policy configured. All tools fail closed by default.";

        if (config.hooks?.onAuthorizeTool) {
          try {
            const decision = await config.hooks.onAuthorizeTool({
              toolName: toolCall.toolName,
              parameters: parsedParameters,
              workingDirectory: config.workingDirectory,
            });

            if (decision.decision === "allow") {
              isAllowed = true;
            } else if (decision.decision === "deny") {
              isAllowed = false;
              denialReason = decision.reason;
            }
          } catch (authError) {
            isAllowed = false;
            const authErrorInstance =
              authError instanceof Error
                ? authError
                : new Error(String(authError));
            denialReason = `Authorization check failed: ${authErrorInstance.message}`;

            yield {
              type: "error",
              origin: "hook",
              error: toErrorInfo(authErrorInstance),
              toolName: toolCall.toolName,
              hookName: "onAuthorizeTool",
              isFatal: false,
            };

            if (config.hooks?.onError) {
              try {
                await config.hooks.onError({
                  error: authErrorInstance,
                  origin: "hook",
                  toolName: toolCall.toolName,
                  hookName: "onAuthorizeTool",
                  turnIndex,
                  isFatal: false,
                });
              } catch {
                // Do not recursively handle hook errors
              }
            }
          }
        }

        if (!isAllowed) {
          const denialResult = {
            isError: true,
            error: denialReason,
          };

          yield {
            type: "toolExecutionFinished",
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            result: toJsonValue(denialResult),
            isError: true,
            durationMs: 0,
          };

          toolResults.push({
            toolCallId: toolCall.callId,
            toolName: toolCall.toolName,
            result: denialResult,
            isError: true,
          });

          if (config.threadStore) {
            await config.threadStore.appendTranscript(config.threadId, {
              version: CURRENT_TRANSCRIPT_VERSION,
              type: "toolResult",
              turnIndex,
              callId: toolCall.callId,
              toolName: toolCall.toolName,
              result: denialResult,
              isError: true,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        // Execute authorized tool
        const startTime = Date.now();
        yield {
          type: "toolExecutionStarted",
          callId: toolCall.callId,
          toolName: toolCall.toolName,
          timestamp: startTime,
        };

        const progressQueue = new AsyncEventQueue<AgentEvent>();

        const executionContext: ToolExecutionContext = {
          threadId: config.threadId,
          toolCallId: toolCall.callId,
          workingDirectory: config.workingDirectory,
          turnIndex,
          abortSignal: effectiveSignal,
          checkpointStore: config.checkpointStore,
          isCheckpointEnabled,
          taskManager: config.taskManager,
          onCheckpointCreated: (evt) => {
            const checkpointEvent: CheckpointCreatedEvent = {
              type: "checkpointCreated",
              checkpointId: evt.checkpointId,
              sequence: evt.sequence,
              label: evt.label,
              filesTouched: evt.filesTouched,
            };
            progressQueue.push(checkpointEvent);
          },
          emitProgress: (chunk: string) => {
            progressQueue.push({
              type: "toolExecutionDelta",
              callId: toolCall.callId,
              toolName: toolCall.toolName,
              chunk,
            });
          },
        };

        let executionResult: unknown;
        let isToolError = false;

        const executionPromise = (async () => {
          try {
            return await agentTool.execute(parsedParameters, executionContext);
          } catch (execError) {
            isToolError = true;
            return {
              isError: true,
              error:
                execError instanceof Error
                  ? execError.message
                  : String(execError),
            };
          } finally {
            progressQueue.close();
          }
        })();

        // Yield queued delta and checkpoint events as they arrive
        for await (const progressEvent of progressQueue) {
          yield progressEvent;
        }

        executionResult = await executionPromise;

        if (
          executionResult !== null &&
          typeof executionResult === "object" &&
          "isError" in executionResult &&
          (executionResult as { readonly isError?: unknown }).isError === true
        ) {
          isToolError = true;
        }

        const durationMs = Date.now() - startTime;
        yield {
          type: "toolExecutionFinished",
          callId: toolCall.callId,
          toolName: toolCall.toolName,
          result: toJsonValue(executionResult),
          isError: isToolError,
          durationMs,
        };

        toolResults.push({
          toolCallId: toolCall.callId,
          toolName: toolCall.toolName,
          result: executionResult,
          isError: isToolError,
        });

        if (config.threadStore) {
          await config.threadStore.appendTranscript(config.threadId, {
            version: CURRENT_TRANSCRIPT_VERSION,
            type: "toolResult",
            turnIndex,
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            result: executionResult,
            isError: isToolError,
            timestamp: Date.now(),
          });
        }
      }

      // Append tool results message
      conversationMessages.push({
        role: "tool",
        content: toolResults.map((tr) => ({
          type: "tool-result",
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          output:
            typeof tr.result === "string"
              ? {
                  type: "text",
                  value: tr.result,
                }
              : {
                  type: "json",
                  value: toJsonValue(tr.result),
                },
        })),
      });

      // Emit stepFinished
      yield {
        type: "stepFinished",
        stepIndex,
        usage: stepUsage,
      };
    }

    if (
      finishReason === "completed" &&
      conversationMessages.length > initialHistoryLength
    ) {
      // Check if maxSteps was hit
      const lastMessage = conversationMessages[conversationMessages.length - 1];
      if (lastMessage?.role === "tool") {
        finishReason = "maxSteps";
      }
    }

    // 4. Conclude turn
    yield* finalizeTurn(finishReason);
  } catch (turnError) {
    const errorInstance =
      turnError instanceof Error ? turnError : new Error(String(turnError));

    // Rollback conversational messages added during failed turn
    conversationMessages.length = initialHistoryLength;

    finishReason = "error";

    yield {
      type: "error",
      origin: "engine",
      error: toErrorInfo(errorInstance),
      isFatal: true,
    };

    if (config.hooks?.onError) {
      try {
        await config.hooks.onError({
          error: errorInstance,
          origin: "engine",
          turnIndex,
          isFatal: true,
        });
      } catch (hookError) {
        // Yield hook error as non-fatal diagnostic so terminal turnFinished is guaranteed
        yield {
          type: "error",
          origin: "hook",
          error: toErrorInfo(
            hookError instanceof Error
              ? hookError
              : new Error(String(hookError)),
          ),
          hookName: "onError",
          isFatal: false,
        };
      }
    }

    yield* finalizeTurn("error");
  } finally {
    if (config.hooks?.onAfterTurn) {
      try {
        await config.hooks.onAfterTurn({
          turnIndex,
          finishReason,
          totalUsage: buildTotalUsage(),
        });
      } catch {
        // Collect cleanup error without masking primary turn outcome
      }
    }
  }
}
