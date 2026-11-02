/**
 * @fileoverview Autonomous multi-step turn runner for the agent engine microkernel.
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { streamText, type HernexStreamTextOptions as GregStreamTextOptions } from '../runtime.js';
import type { ModelMessage } from '../model/types.js';
import type { AgentEvent } from '../events/index.js';
import type { StepTokenUsage, TurnFinishReason } from '../events/stepEvents.js';
import type { CheckpointCreatedEvent } from '../events/checkpointEvents.js';
import type { AgentEngineConfig, RunTurnOptions } from './engineConfig.js';
import type { ToolExecutionContext } from '../tools/ToolExecutionContext.js';
import { AsyncEventQueue } from './eventQueue.js';

/**
 * Extracts normalized provider identifier from a model string if formatted as "provider/model_id".
 */
function getModelProvider(model: string | unknown): string | undefined {
  if (typeof model === 'string') {
    const slashIndex = model.indexOf('/');
    if (slashIndex > 0) {
      return model.slice(0, slashIndex).trim().toLowerCase();
    }
  }
  return undefined;
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
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(activeSignals);
  }
  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), {
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
  const isCheckpointEnabled = isPersist && Boolean(
    typeof config.checkpoint === 'boolean'
      ? config.checkpoint
      : config.checkpoint?.enabled ?? Boolean(config.checkpointStore),
  );

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

  let finishReason: TurnFinishReason = 'completed';
  const initialHistoryLength = conversationMessages.length;

  try {
    // Credential invariant check: ensure per-turn model cannot silently reuse another provider's credentials
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

    // 1. Emit 'turnStarted'
    yield {
      type: 'turnStarted',
      turnIndex,
      userMessage: userPrompt,
    };

    if (config.threadStore) {
      await config.threadStore.appendTranscript(config.threadId, {
        type: 'turnStarted',
        turnIndex,
        userPrompt,
        timestamp: Date.now(),
      });
    }

    // 2. Call hooks.onPreTurn() -> await product decision
    let effectiveUserPrompt = userPrompt;
    let injectedInstructions = '';
    if (config.hooks?.onPreTurn) {
      const preTurnResult = await config.hooks.onPreTurn({
        turnIndex,
        userPrompt,
      });

      if (preTurnResult) {
        if (preTurnResult.veto) {
          finishReason = 'vetoed';
          yield {
            type: 'turnFinished',
            turnIndex,
            finishReason,
            totalUsage: buildTotalUsage(),
          };
          if (config.threadStore) {
            await config.threadStore.appendTranscript(config.threadId, {
              type: 'turnFinished',
              turnIndex,
              finishReason,
              timestamp: Date.now(),
            });
          }
          return;
        }
        if (preTurnResult.userPrompt) {
          effectiveUserPrompt = preTurnResult.userPrompt;
        }
        if (preTurnResult.injectedInstructions) {
          injectedInstructions = preTurnResult.injectedInstructions;
        }
      }
    }

    // 3. Append user message to conversation history
    const userMessage: ModelMessage = {
      role: 'user',
      content: effectiveUserPrompt,
    };
    conversationMessages.push(userMessage);

    if (config.threadStore) {
      await config.threadStore.appendTranscript(config.threadId, {
        type: 'modelMessage',
        message: userMessage,
        timestamp: Date.now(),
      });
    }

    // Combine instructions cleanly
    const instructionsList = [
      config.instructions,
      options.instructions,
      injectedInstructions,
    ].filter((inst): inst is string => Boolean(inst && inst.trim().length > 0));

    const combinedInstructions =
      instructionsList.length > 0 ? instructionsList.join('\n\n') : undefined;

    // 4. Autonomous step loop
    let stepIndex = 1;

    while (stepIndex <= maxSteps) {
      if (effectiveSignal?.aborted) {
        finishReason = 'interrupted';
        yield {
          type: 'turnFinished',
          turnIndex,
          finishReason,
          totalUsage: buildTotalUsage(),
        };
        if (config.threadStore) {
          await config.threadStore.appendTranscript(config.threadId, {
            type: 'turnFinished',
            turnIndex,
            finishReason,
            timestamp: Date.now(),
          });
        }
        return;
      }

      // Emit stepStarted
      yield {
        type: 'stepStarted',
        stepIndex,
        timestamp: Date.now(),
      };

      const sdkToolDefinitions = config.tools.toSdkToolDefinitions();
      const hasTools = Object.keys(sdkToolDefinitions).length > 0;

      const streamOptions: GregStreamTextOptions = {
        model: options.model ?? config.model,
        apiKey: options.apiKey ?? config.apiKey,
        baseUrl: options.baseUrl ?? config.baseUrl,
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

      let responseMessages: ModelMessage[] = [];
      let rawUsage: any = {};
      const maxRetries = 3;

      // Resilient execution with retryScheduled events for transient rate limits and network drops
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const proposedToolCallsInAttempt: typeof proposedToolCalls = [];
        try {
          const streamResult = streamText(streamOptions);

          for await (const chunk of streamResult.stream) {
            if (chunk.type === 'text-delta') {
              yield {
                type: 'tokenDelta',
                text: (chunk as any).text ?? (chunk as any).textDelta ?? '',
                messageId: (chunk as any).id,
              };
            } else if (chunk.type === 'reasoning-delta') {
              yield {
                type: 'thoughtDelta',
                text: (chunk as any).text ?? (chunk as any).textDelta ?? '',
                messageId: (chunk as any).id,
              };
            } else if (chunk.type === 'tool-call') {
              const rawCall = chunk as any;
              const toolCall = {
                callId: rawCall.toolCallId ?? rawCall.id ?? randomUUID(),
                toolName: rawCall.toolName,
                parameters: rawCall.input ?? rawCall.args ?? {},
              };
              proposedToolCallsInAttempt.push(toolCall);
              yield {
                type: 'toolCallProposed',
                callId: toolCall.callId,
                toolName: toolCall.toolName,
                parameters: toolCall.parameters,
              };
            }
          }

          responseMessages = await streamResult.responseMessages;
          rawUsage = await streamResult.usage;
          proposedToolCalls.push(...proposedToolCallsInAttempt);
          break;
        } catch (streamError) {
          const errorInstance =
            streamError instanceof Error ? streamError : new Error(String(streamError));
          const isTransient =
            /429|500|502|503|504|fetch|network|ECONNRESET|ETIMEDOUT|rate limit/i.test(
              errorInstance.message,
            );

          if (attempt < maxRetries && isTransient && !effectiveSignal?.aborted) {
            const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
            yield {
              type: 'retryScheduled',
              attempt: attempt + 1,
              maxRetries,
              delayMs,
              error: errorInstance,
            };
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
          throw errorInstance;
        }
      }

      // Collect assistant response messages and step token metrics
      conversationMessages.push(...responseMessages);
      if (config.threadStore) {
        for (const msg of responseMessages) {
          await config.threadStore.appendTranscript(config.threadId, {
            type: 'modelMessage',
            message: msg,
            timestamp: Date.now(),
          });
        }
      }

      const stepUsage: StepTokenUsage = {
        promptTokens: rawUsage.inputTokens ?? 0,
        completionTokens: rawUsage.outputTokens ?? 0,
        totalTokens: rawUsage.totalTokens ?? 0,
        ...(typeof rawUsage.outputTokenDetails?.reasoningTokens === 'number'
          ? { reasoningTokens: rawUsage.outputTokenDetails.reasoningTokens }
          : {}),
      };

      totalPromptTokens += stepUsage.promptTokens;
      totalCompletionTokens += stepUsage.completionTokens;
      totalTokens += stepUsage.totalTokens;
      if (typeof stepUsage.reasoningTokens === 'number') {
        totalReasoningTokens += stepUsage.reasoningTokens;
      }

      // If no tool calls were proposed, evaluate completion
      if (proposedToolCalls.length === 0) {
        if (config.hooks?.onShouldStop) {
          const stopDecision = await config.hooks.onShouldStop({
            turnIndex,
            finishReason: 'completed',
            transcript: conversationMessages,
          });

          if (!stopDecision.shouldStop) {
            const reminderMessage: ModelMessage = {
              role: 'user',
              content: stopDecision.reminderPrompt,
            };
            conversationMessages.push(reminderMessage);

            if (config.threadStore) {
              await config.threadStore.appendTranscript(config.threadId, {
                type: 'modelMessage',
                message: reminderMessage,
                timestamp: Date.now(),
              });
            }

            yield {
              type: 'stepFinished',
              stepIndex,
              usage: stepUsage,
            };

            stepIndex++;
            continue;
          }
        }

        finishReason = 'completed';
        yield {
          type: 'stepFinished',
          stepIndex,
          usage: stepUsage,
        };

        yield {
          type: 'turnFinished',
          turnIndex,
          finishReason,
          totalUsage: buildTotalUsage(),
        };

        if (config.threadStore) {
          await config.threadStore.appendTranscript(config.threadId, {
            type: 'turnFinished',
            turnIndex,
            finishReason,
            timestamp: Date.now(),
          });
        }

        return;
      }

      // Execute proposed tool calls
      const toolResults: Array<{
        toolCallId: string;
        toolName: string;
        result: unknown;
        isError: boolean;
      }> = [];

      for (const toolCall of proposedToolCalls) {
        if (config.threadStore) {
          await config.threadStore.appendTranscript(config.threadId, {
            type: 'toolCall',
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            parameters: toolCall.parameters,
            timestamp: Date.now(),
          });
        }

        const agentTool = config.tools.resolve(toolCall.toolName);
        if (!agentTool) {
          const missingErrorResult = {
            isError: true,
            error: `Tool "${toolCall.toolName}" is not registered in ToolRegistry.`,
          };

          yield {
            type: 'toolExecutionFinished',
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            result: missingErrorResult,
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
              type: 'toolResult',
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
            type: 'toolExecutionFinished',
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            result: schemaErrorResult,
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
              type: 'toolResult',
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
          'Tool execution denied: no authorization policy configured. All tools fail closed by default.';

        if (config.hooks?.onAuthorizeTool) {
          try {
            const decision = await config.hooks.onAuthorizeTool({
              toolName: toolCall.toolName,
              parameters: parsedParameters,
              workingDirectory: config.workingDirectory,
            });

            if (decision.decision === 'allow') {
              isAllowed = true;
            } else if (decision.decision === 'deny') {
              isAllowed = false;
              denialReason = decision.reason;
            }
          } catch (authError) {
            isAllowed = false;
            denialReason = `Authorization check failed: ${authError instanceof Error ? authError.message : String(authError)}`;
          }
        }

        if (!isAllowed) {
          const denialResult = {
            isError: true,
            error: denialReason,
          };

          yield {
            type: 'toolExecutionFinished',
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            result: denialResult,
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
              type: 'toolResult',
              callId: toolCall.callId,
              toolName: toolCall.toolName,
              result: denialResult,
              isError: true,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        // Emit toolExecutionStarted
        const startTime = Date.now();
        yield {
          type: 'toolExecutionStarted',
          callId: toolCall.callId,
          toolName: toolCall.toolName,
          timestamp: startTime,
        };

        let executionResult: unknown;
        let isToolError = false;

        const progressQueue = new AsyncEventQueue<string>();
        const capturedCheckpoints: CheckpointCreatedEvent[] = [];

        const executePromise = (async () => {
          try {
            const executionContext: ToolExecutionContext = {
              threadId: config.threadId,
              toolCallId: toolCall.callId,
              workingDirectory: config.workingDirectory,
              abortSignal: effectiveSignal,
              checkpointStore: config.checkpointStore,
              isCheckpointEnabled,
              taskManager: config.taskManager,
              onCheckpointCreated: (cp) => {
                capturedCheckpoints.push({
                  type: 'checkpointCreated',
                  checkpointId: cp.checkpointId,
                  sequence: cp.sequence,
                  label: cp.label,
                  filesTouched: cp.filesTouched,
                });
              },
              emitProgress: (chunk: string) => {
                progressQueue.push(chunk);
              },
            };

            return await agentTool.execute(parsedParameters, executionContext);
          } catch (error) {
            isToolError = true;
            return {
              isError: true,
              error: error instanceof Error ? error.message : String(error),
            };
          } finally {
            progressQueue.close();
          }
        })();

        for await (const chunk of progressQueue) {
          yield {
            type: 'toolExecutionDelta',
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            chunk,
          };
        }

        executionResult = await executePromise;

        // Yield any checkpoints created by self-contained tools during execution
        for (const cp of capturedCheckpoints) {
          yield cp;
        }

        const durationMs = Date.now() - startTime;
        yield {
          type: 'toolExecutionFinished',
          callId: toolCall.callId,
          toolName: toolCall.toolName,
          result: executionResult,
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
            type: 'toolResult',
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
        role: 'tool',
        content: toolResults.map((tr) => ({
          type: 'tool-result',
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          output:
            typeof tr.result === 'string'
              ? tr.result
              : {
                  type: 'text',
                  value: JSON.stringify(tr.result),
                },
        })) as any,
      });

      // Emit stepFinished
      yield {
        type: 'stepFinished',
        stepIndex,
        usage: stepUsage,
      };

      stepIndex++;
    }

    // Step budget exhausted
    finishReason = 'maxSteps';
    yield {
      type: 'turnFinished',
      turnIndex,
      finishReason,
      totalUsage: buildTotalUsage(),
    };

    if (config.threadStore) {
      await config.threadStore.appendTranscript(config.threadId, {
        type: 'turnFinished',
        turnIndex,
        finishReason,
        timestamp: Date.now(),
      });
    }
  } catch (error) {
    // Roll back in-progress conversation additions if unhandled exception occurs
    conversationMessages.length = initialHistoryLength;

    const errorInstance = error instanceof Error ? error : new Error(String(error));
    finishReason = 'error';

    yield {
      type: 'error',
      origin: 'engine',
      error: errorInstance,
      isFatal: true,
    };

    if (config.hooks?.onError) {
      await config.hooks.onError({
        error: errorInstance,
        origin: 'engine',
        turnIndex,
        isFatal: true,
      });
    }

    yield {
      type: 'turnFinished',
      turnIndex,
      finishReason,
      totalUsage: buildTotalUsage(),
    };

    if (config.threadStore) {
      await config.threadStore.appendTranscript(config.threadId, {
        type: 'turnFinished',
        turnIndex,
        finishReason,
        timestamp: Date.now(),
      });
    }
  } finally {
    if (config.hooks?.onPostTurn) {
      try {
        await config.hooks.onPostTurn({
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
