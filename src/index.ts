/**
 * @fileoverview Curated primary entry point for `@amaranthic/hernex`.
 *
 * Provides the unified AI agent runtime, microkernel engine, tool registry,
 * state persistence, and content-addressed delta checkpointing.
 *
 * @packageDocumentation
 */

import { z } from "zod";

export { z };

// Core Model and Provider Runtime
export {
  resolveModel,
  parseModelString,
  validateCredentials,
} from "./model/resolveModel.js";

export {
  ProviderRegistry,
  createProviderRegistry,
  registerProviderAdapter,
  getSupportedProviders,
  hasProvider,
  getProviderAdapter,
  builtInAdapters,
} from "./model/ProviderRegistry.js";

export type {
  ParsedModelString,
  GregCredentials,
  HernexCredentials,
  ProviderAdapter,
  GregModelInput,
  HernexModelInput,
  GregRequest,
  GregGenerateTextParameters,
  GregStreamTextParameters,
  GregGenerateObjectParameters,
  GregStreamObjectParameters,
  GregEmbedParameters,
  GregEmbedManyParameters,
  LanguageModel,
  ModelMessage,
} from "./model/types.js";

// AI SDK Runtime Wrappers
export {
  generateText,
  streamText,
  generateObject,
  streamObject,
  embed,
  embedMany,
} from "./runtime.js";

export type {
  HernexGenerateTextOptions,
  HernexStreamTextOptions,
  HernexGenerateObjectOptions,
  HernexStreamObjectOptions,
  HernexEmbedOptions,
  HernexEmbedManyOptions,
  GregGenerateTextOptions,
  GregStreamTextOptions,
  GregGenerateObjectOptions,
  GregStreamObjectOptions,
} from "./runtime.js";

// Microkernel Agent Engine
export { AgentEngine } from "./engine/AgentEngine.js";
export { runTurn } from "./engine/runTurn.js";
export { AsyncEventQueue } from "./engine/eventQueue.js";

export type {
  AgentEngineConfig,
  RunTurnOptions,
} from "./engine/engineConfig.js";

// Tool System & Standard Tools
export {
  ToolRegistry,
  ToolExecutionQueue,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  BashTool,
  TaskManagerTool,
  TaskManager,
  GlobTool,
  GrepTool,
  readFileInputSchema,
  writeFileInputSchema,
  editFileInputSchema,
  bashInputSchema,
  taskManagerInputSchema,
  globInputSchema,
  grepInputSchema,
  readFileDescription,
  writeFileDescription,
  editFileDescription,
  bashDescription,
  taskManagerDescription,
  defaultRetentionTtlMs,
  defaultMaxRetainedTasks,
  resolvePathWithinWorkspace,
  getSafeBashEnvironment,
} from "./tools/index.js";

export type {
  AgentTool,
  ToolExecutionContext,
  ToolRegistryOptions,
  SdkToolAdapterOptions,
  ReadFileOutput,
  WriteFileOutput,
  EditFileOutput,
  BashOutput,
  TaskManagerOutput,
  TaskManagerInput,
  TaskSummary,
  TaskReadResult,
  TaskSendInputResult,
  TaskStopResult,
  ShellTaskStatus,
  ShellTaskMetadata,
  TaskManagerOptions,
  GlobOutput,
  GrepOutput,
  GrepMatch,
} from "./tools/index.js";

// Storage & Persistence Primitives
export {
  resolveHomeDirectory,
  atomicWriteFile,
  withFileLock,
  appendJsonl,
  readJsonl,
  encodeValue,
  decodeValue,
} from "./storage/index.js";

export type {
  ResolveHomeDirectoryOptions,
  AtomicWriteOptions,
  LockPayload,
  EncodedValue,
} from "./storage/index.js";

// Thread Sessions & Stores
export {
  FileThreadStore,
} from "./threads/index.js";

export type {
  ThreadStatus,
  ThreadMetadata,
  TranscriptEntry,
  CreateThreadInput,
  ThreadStore,
  AgentReasoningLevel,
  ThreadCheckpointConfig,
  ThreadGitMeta,
  ThreadEnvironmentMeta,
  ThreadTokenUsage,
} from "./threads/index.js";

// Checkpoints & Content-Addressed Delta Storage
export {
  FileCheckpointStore,
} from "./checkpoints/index.js";

export type {
  CheckpointFileRecord,
  CheckpointRecord,
  RestoreFileAction,
  RestorePlan,
  RestoreResult,
  CheckpointStore,
} from "./checkpoints/index.js";

// Lifecycle Events & Hooks
export type {
  AgentEvent,
  TokenDeltaEvent,
  ThoughtDeltaEvent,
  ToolCallProposedEvent,
  ToolExecutionStartedEvent,
  ToolExecutionDeltaEvent,
  ToolExecutionFinishedEvent,
  StepStartedEvent,
  StepFinishedEvent,
  TurnStartedEvent,
  TurnFinishedEvent,
  StepTokenUsage,
  TurnFinishReason,
  CheckpointCreatedEvent,
  ErrorEvent,
  RetryScheduledEvent,
} from "./events/index.js";

export type {
  AgentHooks,
  PreTurnContext,
  PreTurnResult,
  OnPreTurnHook,
  PostTurnContext,
  OnPostTurnHook,
  ShouldStopContext,
  StopDecision,
  OnShouldStopHook,
  ToolAuthorizeContext,
  PermissionDecision,
  OnAuthorizeToolHook,
  ThreadErrorContext,
  OnErrorHook,
} from "./hooks/index.js";

// Structured Errors
export {
  InvalidModelStringError,
  MissingCredentialsError,
  UnsupportedProviderError,
  HernexInvalidModelStringError,
  HernexMissingCredentialsError,
  HernexUnsupportedProviderError,
  HernexStoreError,
  HernexLockError,
  HernexCheckpointConflictError,
} from "./errors.js";
