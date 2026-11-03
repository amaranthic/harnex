# Agent Engine & Turn Loop Specification

This document specifies the architecture, lifecycle options, turn loop execution sequence, state management, and convenience APIs of the [`AgentEngine`](file:///home/nolan/works/harnex/src/engine/AgentEngine.ts#L33-L483) microkernel in `@amaranthic/hernex`.

---

## 1. Engine Microkernel Architecture

The `AgentEngine` orchestrates multi-step model interactions, tool invocations, state updates, and streaming output events.

```typescript
export class AgentEngine {
  public constructor(
    config: AgentEngineConfig,
    initialMessages?: readonly ModelMessage[],
  );

  public static async create(options: { ... }): Promise<AgentEngine>;
  public static async fromThread(threadId: string, options: { ... }): Promise<AgentEngine>;

  public runTurn(promptOrOptions: string | RunTurnOptions): AsyncGenerator<AgentEvent, void, void>;
  public abort(reason?: string): void;
}
```

---

## 2. Persistence & Checkpointing Invariants

The engine provides two lifecycle switches:

```typescript
export interface AgentEngineConfig {
  readonly persist?: boolean | undefined;
  readonly checkpoint?: boolean | CheckpointConfig | undefined;
  readonly threadStore?: ThreadStore | undefined;
  readonly checkpointStore?: CheckpointStore | undefined;
  // ...
}
```

### 2.1 Persistence Invariant

- **Ephemeral Mode (Default)**: If `persist` is omitted or `false`, the engine runs in-memory. No transcripts, thread metadata, or directory trees are written to disk.
- **Persistent Mode**: If `persist: true` (or if a `threadStore` is provided), the engine backs the session using [`FileThreadStore`](file:///home/nolan/works/harnex/src/threads/FileThreadStore.ts#L36), saving JSONL transcripts and metadata in the storage directory.

### 2.2 Checkpoint Dependency Invariant

> [!IMPORTANT]
> **Checkpoints Require Persistent Threads**
> Content-addressed file delta checkpointing requires persistent thread storage to catalog snapshots and sequences.
> - If `persist === false`, `checkpoint` is strictly forced to `false`.
> - Checkpoints can only be enabled when `persist === true`.

```typescript
this.isPersistActive = Boolean(config.persist ?? Boolean(config.threadStore));

this.isCheckpointActive =
  this.isPersistActive &&
  Boolean(
    typeof config.checkpoint === "boolean"
      ? config.checkpoint
      : config.checkpoint?.enabled ?? Boolean(config.checkpointStore),
  );
```

---

## 3. Concurrency Model & Abort Controls

- **Single Active Turn**: An `AgentEngine` instance permits only one active turn at a time. Invoking `runTurn()` while a turn is running throws an error immediately.
- **Instance-Level Abort**: Invoking `engine.abort(reason)` signals the active turn's `AbortController`, halting streaming, interrupting running tools, and finalizing the turn with `finishReason: 'interrupted'`.
- **Signal Aggregation**: The turn runner automatically combines signals from `config.abortSignal`, `options.abortSignal`, and the internal turn controller via `AbortSignal.any`.

---

## 4. The 10-Step Turn Lifecycle

When [`runTurn`](file:///home/nolan/works/harnex/src/engine/runTurn.ts#L62-L755) is invoked, it progresses through 10 deterministic stages:

### Step 1: Signal Binding & Initial Setup
The engine binds the effective abort signal, calculates the target step budget (`maxSteps`, default 25), and records the baseline conversation history length for rollback isolation.

### Step 2: Credential & Provider Verification
If the caller overrides the target model for this specific turn, the engine validates that the provider has not changed without explicit per-turn credentials (`apiKey` and `baseUrl`). Falling back across distinct providers with mismatched credentials is strictly rejected.

### Step 3: Turn Initiation
The engine yields a [`turnStarted`](file:///home/nolan/works/harnex/src/events/stepEvents.ts#L36-L43) event and records the event in the persistent transcript if persistence is active.

### Step 4: Pre-Turn Hook Evaluation
The engine invokes `hooks.onBeforeTurn`:
- If `veto: true`, execution terminates immediately with `finishReason: 'vetoed'`, yielding `turnFinished`.
- If `userPrompt` is returned, it replaces the user input.
- If `injectedInstructions` is returned, it is appended to instructions for this turn.

### Step 5: User Message Ingestion
The user message is added to conversational history and appended to the persistent thread transcript.

### Step 6: Step Loop & Model Streaming
For each step (`1` to `maxSteps`):
1. Yields [`stepStarted`](file:///home/nolan/works/harnex/src/events/stepEvents.ts#L48-L55).
2. Converts registered tools to schema definitions.
3. Streams the model response using `streamText`:
   - Emits [`tokenDelta`](file:///home/nolan/works/harnex/src/events/streamEvents.ts#L17-L23) for textual tokens.
   - Emits [`thoughtDelta`](file:///home/nolan/works/harnex/src/events/streamEvents.ts#L35-L42) for extended reasoning tokens.
   - Emits [`toolCallProposed`](file:///home/nolan/works/harnex/src/events/toolEvents.ts#L9-L18) when tool invocations are generated.
   - Emits [`retryScheduled`](file:///home/nolan/works/harnex/src/events/errorEvents.ts#L14-L25) on transient upstream rate limits or network drops, executing exponential backoff.
4. Records assistant response messages and aggregates step token metrics into cumulative counters.

### Step 7: Completion Evaluation
If the model produces no tool calls:
- The engine dispatches [`hooks.onShouldStop`](file:///home/nolan/works/harnex/src/hooks/turnHooks.ts#L81-L83).
- If `{ shouldStop: false, reminderPrompt }` is returned, the reminder prompt is appended as a user message, and the step loop continues.
- If `{ shouldStop: true }` (or hook is absent), the turn concludes with `finishReason: 'completed'`.

### Step 8: Tool Execution Cycle
If tool calls were proposed:
1. Resolves tool in [`ToolRegistry`](file:///home/nolan/works/harnex/src/tools/ToolRegistry.ts).
2. Validates parameters against the tool's declarative Zod `inputSchema`.
3. Evaluates [`hooks.onAuthorizeTool`](file:///home/nolan/works/harnex/src/hooks/toolHooks.ts#L30-L32). If omitted or denied, tool execution fails closed.
4. Yields [`toolExecutionStarted`](file:///home/nolan/works/harnex/src/events/toolEvents.ts#L23-L32).
5. Executes the tool, streaming progress chunks as [`toolExecutionDelta`](file:///home/nolan/works/harnex/src/events/toolEvents.ts#L37-L46).
6. Yields any [`checkpointCreated`](file:///home/nolan/works/harnex/src/events/checkpointEvents.ts#L9-L20) events produced during execution.
7. Yields [`toolExecutionFinished`](file:///home/nolan/works/harnex/src/events/toolEvents.ts#L51-L64) and records tool results into conversational history.
8. Yields [`stepFinished`](file:///home/nolan/works/harnex/src/events/stepEvents.ts#L60-L67).

### Step 9: Turn Finalization
If `maxSteps` is reached without task completion, the engine concludes with `finishReason: 'maxSteps'`.
The engine emits [`turnFinished`](file:///home/nolan/works/harnex/src/events/stepEvents.ts#L72-L81) containing final token usage and the finish reason.

### Step 10: Post-Turn Cleanups
Inside the `finally` block of the turn runner, the engine dispatches `hooks.onAfterTurn` with cumulative token usage and the final termination reason.

---

## 5. Direct Convenience APIs

The `AgentEngine` exposes high-level convenience methods to inspect and manage the thread session:

### 5.1 Inspection Properties
- **`engine.threadId`**: Active thread identifier string.
- **`engine.workingDirectory`**: Active workspace directory path.
- **`engine.tools`**: Bound `ToolRegistry` instance.
- **`engine.messages`**: Readonly snapshot of conversational messages.
- **`engine.currentTurn`**: Total number of executed turns.
- **`engine.isPersisted`**: Boolean indicating if session state is saved to disk.
- **`engine.isCheckpointEnabled`**: Boolean indicating if file delta snapshots are recorded.

### 5.2 Thread State Management
- **`engine.getMetadata()`**: Returns persisted [`ThreadMetadata`](file:///home/nolan/works/harnex/src/threads/types.ts#L50-L65) or `undefined` if ephemeral.
- **`engine.updateMetadata(patch)`**: Updates thread title, tags, or custom metadata fields.
- **`engine.getTranscript()`**: Returns the full chronological array of [`TranscriptEntry`](file:///home/nolan/works/harnex/src/threads/types.ts#L10-L40) records.
- **`engine.addMessage(message)`**: Manually inserts a message into conversational history.
- **`engine.clearMessages()`**: Clears conversational messages for the thread.

### 5.3 Checkpoint & Restore Operations
- **`engine.listCheckpoints()`**: Lists all checkpoint records captured for this thread.
- **`engine.planRestore(checkpointId)`**: Generates a dry-run [`RestorePlan`](file:///home/nolan/works/harnex/src/checkpoints/types.ts#L78-L94) showing file modifications, additions, deletions, and external edit conflicts.
- **`engine.restoreCheckpoint(checkpointId, { force?: boolean })`**: Reverts workspace files to the checkpoint state, safely aborting on uncommitted external edits unless `force: true` is passed.
- **`engine.createCheckpoint({ label?, files? })`**: Manually creates a named checkpoint snapshot.
