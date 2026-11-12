/**
 * @fileoverview Centralized registry managing built-in and external tools in Hernex.
 * Handles registration, lookups, and native AI SDK v7 tool definition bridging.
 * @packageDocumentation
 */

import { type Tool, tool } from "ai";
import type { AgentTool } from "./AgentTool.js";
import { BashTool } from "./BashTool.js";
import { EditFileTool } from "./EditFileTool.js";
import { GlobTool } from "./GlobTool.js";
import { GrepTool } from "./GrepTool.js";
import { ReadFileTool } from "./ReadFileTool.js";
import { TaskManagerTool } from "./TaskManagerTool.js";
import { WebFetchTool } from "./WebFetchTool.js";
import { WebSearchTool } from "./WebSearchTool.js";
import { WriteFileTool } from "./WriteFileTool.js";

/**
 * Configuration options when instantiating a `ToolRegistry`.
 */
export interface ToolRegistryOptions {
  /**
   * Whether to automatically register the 9 standard built-in tools
   * (readFile, writeFile, editFile, bash, taskManager, glob, grep, webFetch, webSearch). Defaults to true.
   */
  readonly includeDefaults?: boolean;
}

/**
 * Central tool registry managing discovery, validation, and AI SDK adaptation.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

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
      throw new Error(
        `Tool "${agentTool.name}" is already registered. Duplicate tool registration is not allowed. Pass { allowOverride: true } or unregister the tool first.`,
      );
    }

    this.tools.set(agentTool.name, agentTool);
  }

  /**
   * Unregisters a tool by name.
   *
   * @param name - The unique name of the tool to remove.
   * @returns True if a tool was found and removed, false otherwise.
   */
  public unregister(name: string): boolean {
    return this.tools.delete(name);
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
        inputSchema: agentTool.inputSchema,
      });
    }

    return sdkTools;
  }

  /**
   * Populates the registry with the default suite of 9 core agent tools.
   */
  private registerDefaultTools(): void {
    this.register(new ReadFileTool());
    this.register(new WriteFileTool());
    this.register(new EditFileTool());
    this.register(new BashTool());
    this.register(new TaskManagerTool());
    this.register(new GlobTool());
    this.register(new GrepTool());
    this.register(new WebFetchTool());
    this.register(new WebSearchTool());
  }
}
