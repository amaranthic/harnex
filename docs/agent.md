# Agent Engine & Turn Lifecycle

`AgentEngine` is the central execution harness in `@amaranthic/hernex`. It acts as a lightweight bridge between your product and the Vercel AI SDK, managing single-turn execution, tool authorization, signal cancellation, and persistent thread storage.

Hernex does not dictate product goals, agent personas, or UX workflows. Your application owns the policy; `AgentEngine` owns turn execution.

---

## 1. Installation & Imports

```typescript
import {
  AgentEngine,
  ToolRegistry,
  FileThreadStore,
  FileCheckpointStore,
  type AgentEngineConfig,
  type AgentEvent,
} from "@amaranthic/hernex";
```

---

## 2. Ephemeral Engine (In-Memory)

For stateless or short-lived agent executions, instantiate `AgentEngine` directly without persistence:

```typescript
const tools = new ToolRegistry();

const engine = new AgentEngine({
  threadId: "thread-123",
  workingDirectory: process.cwd(),
  model: "anthropic/claude-3-7-sonnet",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  baseUrl: "https://api.anthropic.com/v1",
  tools,
  instructions: "You are a concise assistant.",
});
```

> [!NOTE]
> Checkpointing requires persistent thread storage. Specifying `checkpoint: true` without `persist: true` (or a `threadStore`) throws a configuration error.

---

## 3. Persistent Engine Threads

Hernex supports durable threads backed by [`FileThreadStore`](../src/threads/FileThreadStore.ts) and content-addressed file delta snapshots backed by [`FileCheckpointStore`](../src/checkpoints/FileCheckpointStore.ts).

### 3.1 Creating a New Persistent Thread

```typescript
const threadStore = new FileThreadStore();
const checkpointStore = new FileCheckpointStore();

const engine = await AgentEngine.create({
  threadStore,
  checkpointStore,
  workingDirectory: process.cwd(),
  model: "openai/gpt-4o",
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: "https://api.openai.com/v1",
  tools,
  checkpoint: true,
  title: "Refactoring Thread",
});

console.log("Created thread:", engine.threadId);
```

### 3.2 Resuming an Existing Thread

When resuming an existing thread from storage, `fromThread` loads previous transcripts and metadata. If the thread was created with an opaque `LanguageModel` instance without a string model ID, an explicit `model` must be supplied in options.

```typescript
const resumedEngine = await AgentEngine.fromThread(threadId, {
  threadStore,
  checkpointStore,
  tools,
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: "https://api.openai.com/v1",
  checkpoint: true,
});

console.log("Resumed at turn:", resumedEngine.currentTurn);
```

---

## 4. Consuming Turns (Lazy Async Generator)

Calling `engine.runTurn(...)` returns an `AsyncGenerator<AgentEvent, void, void>`.

**Lazy Reservation**: Turn reservation and validation occur on the first `.next()` call (e.g. when entering `for await...of`). A generator created but never consumed does not increment `currentTurn` or lock the engine.

**1-Based Turn Numbering**: Turn indexing strictly follows a 1-based convention (`1, 2, 3, ...`). Both `engine.currentTurn` and event `turnIndex` are always $\ge 1$. Turn index `0` is invalid.

```typescript
const turnStream = engine.runTurn(
  "Inspect package.json and summarize dependencies.",
);

for await (const event of turnStream) {
  switch (event.type) {
    case "tokenDelta":
      process.stdout.write(event.text);
      break;
    case "toolExecutionStarted":
      console.log(`\nExecuting tool: ${event.toolName}`);
      break;
    case "turnFinished":
      console.log(`\nTurn completed. Finish reason: ${event.finishReason}`);
      console.log("Tokens used:", event.totalUsage);
      break;
  }
}
```

Simultaneous turns on a single engine instance are strictly forbidden; starting a concurrent turn while an active turn is running rejects immediately.

---

## 5. Cancellation & Abort Aggregation

`AgentEngine` aggregates abort signals using `AbortSignal.any`:

- The engine's top-level configured signal (`config.abortSignal`).
- The per-turn signal (`options.abortSignal`).
- The engine's internal controller triggered by `engine.abort()`.

Calling `engine.abort(reason)` cancels the active turn immediately, even if the caller supplied their own per-turn abort signal.

```typescript
// Abort after 10 seconds or on user cancellation
setTimeout(() => {
  engine.abort("Turn timeout exceeded");
}, 10000);
```

---

## 6. Direct Subsystem Access

Hernex does not duplicate store CRUD methods on the engine. Products interact directly with stores and managers exposed via engine getters:

- **`engine.threadStore`**: Access [`ThreadStore`](../src/threads/types.ts) directly (`getThread`, `updateThread`, `getTranscript`, `deleteThread`).
- **`engine.checkpointStore`**: Access [`CheckpointStore`](../src/checkpoints/types.ts) directly (`listCheckpoints`, `planRestore`, `restoreCheckpoint`, `deleteCheckpoint`).
- **`engine.taskManager`**: Access the shared [`TaskManager`](../src/tasks/TaskManager.ts) directly (`listTasks`, `readTask`, `stopTask`, `deleteTask`).
- **`engine.addMessage(message)`**: Asynchronously appends an external message to the persistent transcript and in-memory history.
- **`engine.messages`**: Readonly snapshot of conversational messages.
