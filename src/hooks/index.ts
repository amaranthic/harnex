/**
 * @fileoverview Complete hook definitions and composite AgentHooks interface.
 * @packageDocumentation
 */

export type {
  BeforeTurnContext,
  BeforeTurnResult,
  BeforeTurnHook,
  AfterTurnContext,
  AfterTurnHook,
  ShouldStopContext,
  StopDecision,
  ShouldStopHook,
  AuthorizeToolContext,
  PermissionDecision,
  AuthorizeToolHook,
  ErrorContext,
  ErrorHook,
  AgentHooks,
} from "./types.js";

export { composeAgentHooks } from "./composeAgentHooks.js";
