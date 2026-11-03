# Inward Interception Hooks Specification

This document specifies the interface, lifecycle integration, authorization guarantees, and failure modes of inward interception hooks in `@amaranthic/hernex`.

The composite hook container is defined by [`AgentHooks`](file:///home/nolan/works/harnex/src/hooks/index.ts#L54-L65):

```typescript
export interface AgentHooks {
  readonly onAuthorizeTool?: AuthorizeToolHook | undefined;
  readonly onBeforeTurn?: BeforeTurnHook | undefined;
  readonly onAfterTurn?: AfterTurnHook | undefined;
  readonly onShouldStop?: ShouldStopHook | undefined;
  readonly onError?: ErrorHook | undefined;
}
```

---

## 1. Tool Authorization Hook: `onAuthorizeTool`

### 1.1 Specification & Signature

The [`OnAuthorizeToolHook`](file:///home/nolan/works/harnex/src/hooks/toolHooks.ts#L30-L32) intercepts every tool execution proposed by the model prior to execution on the host machine.

```typescript
export type OnAuthorizeToolHook = (
  context: ToolAuthorizeContext,
) => Promise<PermissionDecision> | PermissionDecision;

export interface ToolAuthorizeContext {
  readonly toolName: string;
  readonly parameters: unknown;
  readonly workingDirectory: string;
}

export type PermissionDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: string };
```

### 1.2 Execution Timing & Ordering

1. **Model Proposal**: The language model outputs a tool call with parsed arguments.
2. **Registry Lookup**: The engine resolves the tool in [`ToolRegistry`](file:///home/nolan/works/harnex/src/tools/ToolRegistry.ts). If the tool is unregistered, execution terminates early with an error result.
3. **Schema Validation**: The engine validates parameters against the tool's declarative [`AgentTool.inputSchema`](file:///home/nolan/works/harnex/src/tools/AgentTool.ts#L35). If schema parsing fails, validation error is emitted and returned as a tool failure.
4. **Hook Evaluation**: `onAuthorizeTool` is invoked with the validated parameters, tool name, and active working directory.
5. **Execution or Denial**:
   - If `{ decision: "allow" }`, execution proceeds to [`AgentTool.execute`](file:///home/nolan/works/harnex/src/tools/AgentTool.ts#L44-L47).
   - If `{ decision: "deny", reason }`, execution is aborted, and a synthetic tool error payload containing the denial reason is returned to the model context.

### 1.3 Security Invariant: Fail-Closed Default

> [!IMPORTANT]
> **All tools fail closed by default.**
> If `hooks.onAuthorizeTool` is omitted or `undefined`, the engine denies 100% of tool executions with the following error:
> `Tool execution denied: no authorization policy configured. All tools fail closed by default.`

No tool is automatically exempted from authorization. If the hook implementation throws an unhandled exception, the engine treats the failure as an immediate denial with reason `Authorization check failed: <errorMessage>`.

---

## 2. Before-Turn Hook: `onBeforeTurn`

### 2.1 Specification & Signature

The `BeforeTurnHook` executes before an autonomous turn starts. It permits mutating user inputs, injecting dynamic system instructions, or vetoing turn execution.

```typescript
export type BeforeTurnHook = (
  context: BeforeTurnContext,
) => Promise<BeforeTurnResult | void> | BeforeTurnResult | void;

export interface BeforeTurnContext {
  readonly turnIndex: number;
  readonly userPrompt: string;
}

export interface BeforeTurnResult {
  readonly userPrompt?: string;
  readonly injectedInstructions?: string;
  readonly veto?: boolean;
  readonly vetoReason?: string;
}
```

### 2.2 Execution Semantics

- **Prompt Rewriting**: If `userPrompt` is returned, the engine substitutes the modified string into the conversational message history and the initial model prompt.
- **Instruction Injection**: If `injectedInstructions` is returned, it is appended to the system instructions solely for the current turn.
- **Turn Veto**: If `veto: true` is returned:
  1. The user prompt is **not** appended to conversational history.
  2. The step loop is bypassed entirely.
  3. The turn terminates immediately with `finishReason: 'vetoed'`.
  4. A `turnFinished` event is yielded with empty token usage.

---

## 3. After-Turn Hook: `onAfterTurn`

### 3.1 Specification & Signature

The `AfterTurnHook` executes at the absolute conclusion of a turn, after all steps and events have completed.

```typescript
export type AfterTurnHook = (context: AfterTurnContext) => Promise<void> | void;

export interface AfterTurnContext {
  readonly turnIndex: number;
  readonly finishReason: TurnFinishReason;
  readonly totalUsage: StepTokenUsage;
}
```

### 3.2 Execution Timing & Error Isolation

- **Guaranteed Execution**: `onAfterTurn` is invoked inside the `finally` block of `runTurn`, guaranteeing invocation regardless of normal completion, cancellation, step budget exhaustion, or fatal runtime errors.
- **Exception Containment**: Any exception thrown within `onAfterTurn` is caught and swallowed by the engine to ensure clean finalization and prevent masking the actual turn result.

---

## 4. Stopping Evaluation Hook: `onShouldStop`

### 4.1 Specification & Signature

The [`OnShouldStopHook`](file:///home/nolan/works/harnex/src/hooks/turnHooks.ts#L81-L83) intercepts situations where the model produces an assistant message without proposing any tool calls (candidate completion).

```typescript
export type OnShouldStopHook = (
  context: ShouldStopContext,
) => Promise<StopDecision> | StopDecision;

export interface ShouldStopContext {
  readonly turnIndex: number;
  readonly finishReason: TurnFinishReason;
  readonly transcript?: unknown;
}

export type StopDecision =
  | { readonly shouldStop: true }
  | { readonly shouldStop: false; readonly reminderPrompt: string };
```

### 4.2 Autonomous Goal Steering

When the agent model believes it has completed the user task:
1. If `onShouldStop` is not registered, the engine defaults to stopping with `finishReason: 'completed'`.
2. If registered and returns `{ shouldStop: false, reminderPrompt }`:
   - The engine appends `reminderPrompt` as a new user message into conversational history.
   - The step counter increments and the autonomous turn loop continues.
   - The engine terminates only when `onShouldStop` returns `{ shouldStop: true }` or the turn reaches `maxSteps`.

---

## 5. Thread Error Hook: `onError`

### 5.1 Specification & Signature

The [`OnErrorHook`](file:///home/nolan/works/harnex/src/hooks/threadHooks.ts#L28) is invoked when an unhandled runtime error occurs during turn execution.

```typescript
export type OnErrorHook = (context: ThreadErrorContext) => Promise<void> | void;

export interface ThreadErrorContext {
  readonly error: Error;
  readonly origin: ErrorOrigin;
  readonly turnIndex: number;
  readonly toolName?: string;
  readonly isFatal: boolean;
}

export type ErrorOrigin = "model" | "tool" | "checkpoint" | "permission" | "engine";
```

### 5.2 Behavior & Rollback

- **History Rollback**: When an unhandled error terminates the turn, the engine rolls back any partial conversational messages added during the failed turn.
- **Event Dispatch**: The engine emits an [`error`](file:///home/nolan/works/harnex/src/events/errorEvents.ts#L30-L41) event followed by a [`turnFinished`](file:///home/nolan/works/harnex/src/events/stepEvents.ts#L72-L81) event with `finishReason: 'error'`.
- **Diagnostic Notification**: `onError` receives the exact error instance and origin subsystem for external reporting or structured telemetry.
