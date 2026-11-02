/**
 * @fileoverview Centralized registry managing built-in and external tools in Hernex.
 * Handles registration, lookups, concurrency serialization, and native AI SDK v7 tool bridging.
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import { type Tool, tool } from "ai";
import type { AgentTool } from "./AgentTool.js";
import { BashTool } from "./BashTool.js";
import { EditFileTool } from "./EditFileTool.js";
import { GlobTool } from "./GlobTool.js";
import { GrepTool } from "./GrepTool.js";
import { ReadFileTool } from "./ReadFileTool.js";
import { TaskManagerTool } from "./TaskManagerTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { ToolExecutionQueue } from "./ToolExecutionQueue.js";
import { WriteFileTool } from "./WriteFileTool.js";

/**
 * Configuration options when instantiating a `ToolRegistry`.
 */
export interface ToolRegistryOptions {
  /**
   * Whether to automatically register the 6 standard built-in tools
   * (readFile, writeFile, editFile, bash, glob, grep). Defaults to true.
   */
  readonly includeDefaults?: boolean;
}

/**
 * Context configuration options provided when adapting registry tools
 * for AI SDK v7 execution.
 */
export interface SdkToolAdapterOptions {
  /**
   * The thread session identifier.
   */
  readonly threadId: string;

  /**
   * The active workspace working directory.
   */
  readonly workingDirectory: string;

  /**
   * Shared abort signal for thread cancellation.
   */
  readonly abortSignal?: AbortSignal;

  /**
   * Optional callback to receive streaming execution progress chunks.
   *
   * @param chunk - Output delta chunk emitted by a tool.
   * @param toolName - Name of the tool emitting the chunk.
   */
  readonly onProgress?: (chunk: string, toolName: string) => void;
}

/**
 * Central tool registry managing discovery, validation, and AI SDK adaptation.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  private readonly queue = new ToolExecutionQueue();

  /**
   * Returns the underlying execution queue used to serialize non-concurrency-safe tools.
   */
  public get executionQueue(): ToolExecutionQueue {
    return this.queue;
  }

  /**
   * Constructs a new ToolRegistry instance, optionally pre-loading built-in tools.
   *
   * @param options - Optional registry configuration options.
   */
  public constructor(options?: ToolRegistryOptions) {
    const includeDefaults = options?.includeDefaults ?? true;
    if (includeDefaults) {
      this.registerDefaultTools();
    }
  }

  /**
   * Registers a tool instance into the registry.
   *
   * @param agentTool - The AgentTool instance to register.
   * @param options - Optional registration parameters, such as allowing explicit overrides.
   * @throws Error if the tool name is empty, invalid, or already registered without allowOverride.
   */
  public register(
    agentTool: AgentTool,
    options?: { readonly allowOverride?: boolean },
  ): void {
    if (
      !agentTool.name ||
      typeof agentTool.name !== "string" ||
      agentTool.name.trim().length === 0
    ) {
      throw new Error("Tool name must be a non-empty string.");
    }
    if (this.tools.has(agentTool.name) && !options?.allowOverride) {
      if (agentTool.name === TaskManagerTool.toolName) {
        // Allow explicit instance override for auto-associated TaskManagerTool
        this.tools.set(agentTool.name, agentTool);
        return;
      }
      throw new Error(
        `Tool "${agentTool.name}" is already registered. Duplicate tool registration is not allowed. Pass { allowOverride: true } or unregister the tool first.`,
      );
    }
    if (
      agentTool.name === TaskManagerTool.toolName &&
      !this.tools.has(BashTool.toolName)
    ) {
      throw new Error(
        "TaskManagerTool cannot be registered without BashTool. Tasks are associated with bash.",
      );
    }

    this.tools.set(agentTool.name, agentTool);

    // Auto-associate TaskManagerTool when BashTool is registered
    if (
      agentTool.name === BashTool.toolName &&
      !this.tools.has(TaskManagerTool.toolName)
    ) {
      this.tools.set(TaskManagerTool.toolName, new TaskManagerTool());
    }
  }

  /**
   * Unregisters a tool by name.
   * If BashTool is unregistered, TaskManagerTool is automatically unregistered as well.
   *
   * @param name - The unique name of the tool to remove.
   * @returns True if a tool was found and removed, false otherwise.
   */
  public unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (name === BashTool.toolName && this.tools.has(TaskManagerTool.toolName)) {
      this.tools.delete(TaskManagerTool.toolName);
    }
    return removed;
  }

  /**
   * Resolves a registered tool by its name.
   *
   * @param name - The unique name of the tool to look up.
   * @returns The AgentTool instance, or undefined if not registered.
   */
  public resolve(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Checks whether a tool with the given name is currently registered.
   *
   * @param name - The tool name to check.
   * @returns True if registered, false otherwise.
   */
  public has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Returns a snapshot array of all currently registered tools.
   *
   * @returns Readonly array of AgentTool instances.
   */
  public list(): readonly AgentTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Converts all registered tools into native Vercel AI SDK v7 `Tool` definitions
   * without execute handlers.
   *
   * This allows the autonomous engine turn loop to pass tool schemas to the model
   * while retaining complete control over tool execution, permission checks,
   * mutating file checkpoints, and progress streaming.
   *
   * @returns A map of tool names to AI SDK v7 `Tool` objects without execute handlers.
   */
  public toSdkToolDefinitions(): Record<string, Tool> {
    const sdkTools: Record<string, Tool> = {};

    for (const agentTool of this.tools.values()) {
      sdkTools[agentTool.name] = tool({
        description: agentTool.description,
        inputSchema: agentTool.inputSchema as any,
      });
    }

    return sdkTools;
  }

  /**
   * Converts all registered tools into native Vercel AI SDK v7 `Tool` definitions
   * compatible with `streamText({ tools })` and `generateText({ tools })`.
   *
   * @warning This method attaches raw execute handlers that bypass the AgentEngine's
   * authorization hooks, mutating checkpoints, and lifecycle progress events. It should
   * primarily be used in isolated tests or custom unmanaged harnesses.
   *
   * @param options - Context options including threadId and workingDirectory.
   * @returns A map of tool names to AI SDK v7 `Tool` objects.
   */
  public toSdkTools(
    options: SdkToolAdapterOptions,
  ): Record<string, Tool> {
    const sdkTools: Record<string, Tool> = {};

    for (const agentTool of this.tools.values()) {
      sdkTools[agentTool.name] = tool({
        description: agentTool.description,
        inputSchema: agentTool.inputSchema as any,
        execute: async (
          rawArgs: unknown,
          execOptions?: { abortSignal?: AbortSignal; toolCallId?: string },
        ) => {
          const effectiveSignal = execOptions?.abortSignal ?? options.abortSignal;
          const toolCallId = execOptions?.toolCallId ?? randomUUID();

          const executionContext: ToolExecutionContext = {
            threadId: options.threadId,
            toolCallId,
            workingDirectory: options.workingDirectory,
            abortSignal: effectiveSignal,
            emitProgress: options.onProgress
              ? (chunk: string) => {
                  options.onProgress?.(chunk, agentTool.name);
                }
              : undefined,
          };

          const runTool = async (): Promise<unknown> => {
            try {
              // Parse through the tool's input schema
              const parsedParameters = agentTool.inputSchema.parse(rawArgs);
              return await agentTool.execute(parsedParameters, executionContext);
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              return {
                isError: true,
                error: errorMessage,
              };
            }
          };

          return await runTool();
        },
      });
    }

    return sdkTools;
  }

  /**
   * Populates the registry with the default suite of 6 core agent tools.
   */
  private registerDefaultTools(): void {
    this.register(new ReadFileTool());
    this.register(new WriteFileTool());
    this.register(new EditFileTool());
    this.register(new BashTool());
    this.register(new GlobTool());
    this.register(new GrepTool());
  }
}
