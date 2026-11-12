/**
 * @fileoverview Curated primary entry point for `@amaranthic/hernex`.
 *
 * Provides the unified AI agent runtime, microkernel engine, tool registry,
 * state persistence, and content-addressed delta checkpointing.
 *
 * @packageDocumentation
 */

// Core Model and Provider Runtime
export {
  resolveModel,
  parseModelString,
  validateCredentials,
} from "./model/resolveModel.js";

export { ProviderRegistry, builtInAdapters } from "./model/ProviderRegistry.js";

export type {
  ParsedModelString,
  HernexCredentials,
  ProviderAdapter,
  HernexModelInput,
  HernexRequest,
  HernexGenerateTextParameters,
  HernexStreamTextParameters,
  LanguageModel,
  ModelMessage,
} from "./model/types.js";

// AI SDK Runtime Wrappers
export { generateText, streamText } from "./runtime.js";

export type {
  HernexGenerateTextOptions,
  HernexStreamTextOptions,
} from "./runtime.js";

// Microkernel Agent Engine
export { AgentEngine } from "./engine/AgentEngine.js";

export type {
  AgentEngineConfig,
  RunTurnOptions,
} from "./engine/engineConfig.js";

// Tool System & Standard Tools
export {
  ToolRegistry,
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
} from "./tools/index.js";

export type {
  AgentTool,
  ToolExecutionContext,
  ToolRegistryOptions,
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

// Threads & Stores
export {
  FileThreadStore,
  CURRENT_TRANSCRIPT_VERSION,
  migrateV1ToV2,
  runTranscriptMigrationPipeline,
  projectModelMessages,
} from "./threads/index.js";

export type {
  ThreadStatus,
  ThreadMetadata,
  TranscriptEntry,
  NewTranscriptEntry,
  CreateThreadInput,
  UpdateThreadInput,
  ThreadStore,
  AgentReasoningLevel,
  TranscriptMigration,
  MigrationPipelineResult,
} from "./threads/index.js";

// Checkpoints & Content-Addressed Delta Storage
export { FileCheckpointStore } from "./checkpoints/index.js";

export type {
  CheckpointFileRecord,
  CheckpointRecord,
  CreateCheckpointInput,
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
  JsonValue,
  ErrorInfo,
  ErrorOrigin,
} from "./events/index.js";

export { composeAgentHooks } from "./hooks/index.js";

export type {
  AgentHooks,
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
} from "./hooks/index.js";

// Structured Errors
export {
  HernexInvalidModelStringError,
  HernexMissingCredentialsError,
  HernexUnsupportedProviderError,
  HernexStoreError,
  HernexLockError,
  HernexCheckpointConflictError,
} from "./errors.js";
