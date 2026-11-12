# Streaming Events & Observability

`AgentEngine.runTurn` returns an `AsyncGenerator<AgentEvent, void, void>` yielding pure, serializable JSON events. This stream gives products real-time visibility into token generation, tool calls, and lifecycle stages.

---

## 1. JSON Serialization Guarantee

> [!IMPORTANT]
> Every `AgentEvent` is strictly JSON-serializable (`JsonValue`). Events never contain circular references, class instances, native `Error` objects, or function callbacks. Errors are normalized into [`ErrorInfo`](../src/events/types.ts).

---

## 2. Consuming the Event Stream

Events are discriminated by the `type` property in `camelCase`:

```typescript
import { AgentEngine, type AgentEvent } from "@amaranthic/hernex";

for await (const event of engine.runTurn("Refactor src/storage.ts")) {
  switch (event.type) {
    case "turnStarted":
      console.log(`[Turn ${event.turnIndex}] Prompt: ${event.userMessage}`);
      break;

    case "stepStarted":
      console.log(`Step ${event.stepIndex} starting...`);
      break;

    case "tokenDelta":
      process.stdout.write(event.text);
      break;

    case "thoughtDelta":
      process.stdout.write(`\x1b[90m${event.text}\x1b[0m`);
      break;

    case "toolCallProposed":
      console.log(
        `\nProposed tool: ${event.toolName} (Call ID: ${event.callId})`,
      );
      break;

    case "toolExecutionStarted":
      console.log(`Executing ${event.toolName}...`);
      break;

    case "toolExecutionDelta":
      // Real-time stdout from long-running tools like Bash
      process.stdout.write(event.chunk);
      break;

    case "checkpointCreated":
      console.log(`Snapshot saved: ${event.label} (ID: ${event.checkpointId})`);
      break;

    case "toolExecutionFinished":
      console.log(
        `Tool ${event.toolName} finished in ${event.durationMs}ms (error: ${event.isError})`,
      );
      break;

    case "stepFinished":
      console.log(`Step ${event.stepIndex} finished. Usage:`, event.usage);
      break;

    case "error":
      console.error(`Error [${event.origin}]:`, event.error.message);
      break;

    case "turnFinished":
      console.log(`\nTurn completed. Finish reason: ${event.finishReason}`);
      console.log("Total usage:", event.totalUsage);
      break;
  }
}
```

---

## 3. Event Types & Schemas

### 3.1 Turn Lifecycle Events

- **`turnStarted`**: Emitted when turn begins. Fields: `turnIndex`, `userMessage`.
- **`turnFinished`**: Exactly **one** `turnFinished` event is guaranteed for every started turn (across veto, model completion, tool error, abort, or failure).
  - `finishReason`: `"completed" | "maxSteps" | "interrupted" | "error" | "vetoed" | "lengthExceeded" | "contentFilter"`.
  - `totalUsage`: Cumulative [`StepTokenUsage`](../src/events/stepEvents.ts) across all steps in the turn.

### 3.2 Model Stream Events

- **`tokenDelta`**: Standard generated text delta chunks. Fields: `text`, optional `messageId`.
- **`thoughtDelta`**: Reasoning tokens emitted by extended-thinking models. Fields: `text`, optional `messageId`.

### 3.3 Tool Events

- **`toolCallProposed`**: Emitted when the model proposes a tool invocation. Parameters contain raw, unvalidated model JSON input. Schema validation and authorization (`onAuthorizeTool`) occur subsequently before execution. Fields: `callId`, `toolName`, `parameters` (`JsonValue`).
- **`toolExecutionStarted`**: Emitted immediately before tool execution begins. Fields: `callId`, `toolName`, `timestamp`.
- **`toolExecutionDelta`**: Streaming live output chunks from long-running operations. Fields: `callId`, `toolName`, `chunk`.
- **`toolExecutionFinished`**: Emitted when tool completes. Fields: `callId`, `toolName`, `result` (`JsonValue`), `isError`, `durationMs`.
- **`checkpointCreated`**: Emitted after file changes are committed to a snapshot. Fields: `checkpointId`, `sequence`, `label`, `filesTouched`.

### 3.4 Errors & Retries

- **`error`**: Normalizes exceptions into serializable [`ErrorInfo`](../src/events/types.ts) (`name`, `message`, `code`, optional `stack`).
  - `origin`: `"model" | "tool" | "checkpoint" | "permission" | "hook" | "engine"`.
  - `isFatal`: Indicates whether the error aborts the turn.
- **No Outer Retry Events**: Hernex does not emit `retryScheduled` events or duplicate partial streams. HTTP retries are handled natively and transparently by the Vercel AI SDK before streaming commences.
