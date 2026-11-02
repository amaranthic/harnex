# Standard Tool Harness Specification

This document specifies the tool interface contracts, execution context, concurrency serialization, security containment, and built-in tool implementations in `@amaranthic/hernex`.

---

## 1. Universal Tool Interface Contract

All tools executed within `@amaranthic/hernex` implement the universal [`AgentTool`](file:///home/nolan/works/harnex/src/tools/AgentTool.ts#L15-L48) contract:

```typescript
export interface AgentTool<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput = unknown,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInput;
  execute(
    parameters: z.infer<TInput>,
    context: ToolExecutionContext,
  ): Promise<TOutput>;
}
```

- **`name`**: Unique string identifier exposed to the model (e.g. `readFile`, `bash`). Must conform to strict camelCase or PascalCase.
- **`description`**: Detailed instructions provided to the model describing purpose, edge cases, and argument formatting.
- **`inputSchema`**: Declarative Zod schema used for runtime parameter validation and automatic JSON Schema derivation for model function calling.
- **`execute`**: Pure asynchronous execution function receiving validated parameters and runtime context.

---

## 2. Tool Execution Context

Every tool receives an instance of [`ToolExecutionContext`](file:///home/nolan/works/harnex/src/tools/ToolExecutionContext.ts#L13-L62):

```typescript
export interface ToolExecutionContext {
  readonly threadId: string;
  readonly toolCallId: string;
  readonly workingDirectory: string;
  readonly abortSignal?: AbortSignal | undefined;
  readonly checkpointStore?: CheckpointStore | undefined;
  readonly isCheckpointEnabled?: boolean | undefined;
  readonly onCheckpointCreated?: ((event: {
    readonly checkpointId: string;
    readonly sequence: number;
    readonly label: string;
    readonly filesTouched: readonly string[];
  }) => void) | undefined;
  readonly emitProgress?: ((chunk: string) => void) | undefined;
}
```

### 2.1 Context Capabilities

- **`workingDirectory`**: The absolute path root for resolving relative paths and executing subprocesses.
- **`abortSignal`**: Propagates cancellation signals (from client aborts, turn cancellations, or timeouts) to terminate active operations promptly.
- **`emitProgress`**: Allows long-running tools (such as shell commands) to stream real-time output chunks (`toolExecutionDelta`) to the client without waiting for completion.
- **Self-Contained Checkpointing**: Tools modifying files leverage `checkpointStore`, `isCheckpointEnabled`, and `onCheckpointCreated` to snapshot pre- and post-mutation file blobs.

---

## 3. Tool Concurrency & Serialization

> [!NOTE]
> Tool concurrency and thread-safety are managed at the tool level, not inside the engine loop.

For tools that perform non-concurrency-safe operations (such as shared workspace mutations or sequential shell sessions), Hernex provides [`ToolExecutionQueue`](file:///home/nolan/works/harnex/src/tools/ToolExecutionQueue.ts#L58-L110):

```typescript
export class ToolExecutionQueue {
  public async run<T>(
    task: () => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T>;
}
```

### 3.1 Queue Guarantees

1. **FIFO Serialization**: Asynchronous tasks execute strictly in arrival order. A task does not begin until the prior task settles.
2. **Cancellation Isolation**: If an enqueued task is cancelled via `abortSignal`, the underlying promise still settles before the subsequent task runs, preventing resource contention and race conditions.
3. **Signal Racing**: The helper `raceWithSignal` immediately rejects on abort without unhandled promise leaks.

---

## 4. Workspace Security & Confinement

### 4.1 Path Confinement: `resolvePathWithinWorkspace`

All file-system operations are protected by [`resolvePathWithinWorkspace`](file:///home/nolan/works/harnex/src/tools/internal/pathGuard.ts#L19-L55):

- **Directory Traversal Defense**: Rejects path arguments attempting directory traversal (e.g. `../../etc/passwd`).
- **Absolute Escapes**: If an absolute path is provided, it must resolve to a location within the workspace root directory.
- **Symlink Escape Protection**: Validates the canonical target path using `realpathSync` against the canonical workspace directory to prevent symlink traversal outside the workspace boundary.

### 4.2 Shell Environment Sanitization: `getSafeBashEnvironment`

When launching shell commands via `BashTool`, Hernex scrubs sensitive environment variables matching sensitive patterns:

- Strips variables matching: `/KEY|SECRET|TOKEN|PASSWORD|AUTH|CREDENTIAL|PRIVATE/i`.
- Injects safe terminal defaults: `TERM=dumb`, `CI=true`, `GIT_TERMINAL_PROMPT=0`.
- Ensures API keys and credentials configured on the agent engine never leak into user command subprocesses.

---

## 5. Built-In Tool Catalog

Hernex includes 6 standard tools configured by default:

### 5.1 `ReadFileTool` (`readFile`)

Safely reads text content from files within the workspace root.

- **Parameters**:
  - `filePath` (`string`, required): Relative or absolute path to read.
  - `offset` (`number`, optional): One-based starting line number.
  - `limit` (`number`, optional): Maximum number of lines to read.
- **Protections**:
  - Rejects files exceeding 20 MB before loading into memory buffer.
  - Rejects common binary extensions (`.zip`, `.png`, `.pdf`, `.exe`, `.wasm`, etc.).
  - Rejects blocking device prefixes (`/dev/zero`, `/dev/urandom`, `/dev/random`).
  - Limits single reads to 2,000 lines or 30,000 characters with an `isTruncated: true` flag.

### 5.2 `WriteFileTool` (`writeFile`)

Creates or overwrites files within the workspace root with atomic guarantees.

- **Parameters**:
  - `filePath` (`string`, required): Relative or absolute target file path.
  - `content` (`string`, required): Complete text content to write.
- **Guarantees**:
  - Automatically creates parent directories recursively.
  - **Atomic Write Pattern**: Writes content to a unique sibling file (`<target>.tmp.<timestamp>.<nonce>`), then renames it over the target to prevent torn writes.
  - **Self-Contained Checkpointing**: If `isCheckpointEnabled: true`, captures a pre-mutation SHA-256 blob (if existing) and a post-mutation blob in `CheckpointStore`, emitting `checkpointCreated`.

### 5.3 `EditFileTool` (`editFile`)

Performs surgical, in-place string replacements in workspace files.

- **Parameters**:
  - `filePath` (`string`, required): Target file to edit.
  - `oldString` (`string`, required): Exact existing text substring to replace.
  - `newString` (`string`, required): Replacement text.
  - `replaceAll` (`boolean`, optional): When `false` (default), requires `oldString` to match exactly once in the file.
- **Guarantees**:
  - **Exact Substring Matching**: Uses literal string matching rather than regular expressions, avoiding issues with special substitution patterns like `$$`, `$&`, or `$1`.
  - **Uniqueness Check**: Throws if `oldString` matches multiple locations and `replaceAll` is not enabled.
  - **Atomic Write**: Saves modifications via atomic temporary sibling file renaming.
  - **Self-Contained Checkpointing**: Stores pre- and post-mutation snapshots when checkpointing is enabled.

### 5.4 `BashTool` (`bash`)

Executes shell commands inside the workspace root with auto-handoff to background tasks.

- **Parameters**:
  - `command` (`string`, required): Shell command string.
  - `waitMsBeforeAsync` (`number`, optional): Foreground wait duration in ms (default: 10,000 ms; 0 = immediate background).
  - `killTimeoutMs` (`number`, optional): Hard safety kill timeout between 1 minute (60,000 ms) and 15 minutes (900,000 ms).
  - `timeoutMs` (`number`, optional): Legacy hard timeout in ms (default: 60,000 ms).
- **Guarantees**:
  - Executes with sanitized environment variables.
  - Streams real-time stdout/stderr chunks through `context.emitProgress`.
  - Captures up to 50,000 characters before truncating with `isTruncated: true`.
  - Spawns subprocesses in detached process groups and sends `SIGTERM` / `SIGKILL` to the process group upon timeout or abort signal.
  - Automatically hands off long-running commands to `TaskManager` when `waitMsBeforeAsync` is exceeded or set to 0.

### 5.5 `TaskManagerTool` (`taskManager`)

Manages background shell tasks spawned by `BashTool`. Automatically enabled whenever `BashTool` is active; strictly disabled if `BashTool` is absent.

- **Parameters** (discriminated union on `action`):
  - `action: "list"`: Lists active and recent background tasks with runtime, status, exit code, and totalLines.
  - `action: "read"`: Line-paged file read of task output logs. Requires `taskId: string`, `offset: number` (1-based), and `limit: number` (up to 500 lines).
  - `action: "sendInput"`: Delivers text payload into stdin. Requires `taskId: string`, `input: string`, and optional `newline: boolean` (default: `true`).
  - `action: "stop"`: Terminates the detached process group. Requires `taskId: string` and optional `signal: "SIGTERM" | "SIGKILL"` (default: `"SIGTERM"`).
- **Guarantees**:
  - Direct live disk-backed streaming (`output.log`) prevents memory exhaustion.
  - Strict line-paged retrieval prevents context window flooding.
  - Process group escalation guarantees stubborn subprocesses are cleanly killed.

### 5.6 `GlobTool` (`glob`)

Fast, pattern-based file discovery within the workspace.

- **Parameters**:
  - `pattern` (`string`, required): Glob pattern (e.g. `**/*.ts`, `src/**/*.json`).
  - `path` (`string`, optional): Subdirectory to search within (defaults to workspace root).
- **Protections**:
  - Automatically ignores noise directories: `node_modules`, `.git`, `.turbo`, `.next`, `dist`, `build`, `.cache`.
  - Enforces a result cap of 250 paths with `isTruncated: true`.

### 5.7 `GrepTool` (`grep`)

Line-by-line regular expression content searching across workspace files.

- **Parameters**:
  - `pattern` (`string`, required): Regular expression pattern.
  - `path` (`string`, optional): Subdirectory to limit search to.
  - `filePattern` (`string`, optional): Glob pattern to filter target files (e.g. `*.ts`).
  - `caseSensitive` (`boolean`, optional): Case sensitivity flag (defaults to `true`).
  - `maxResults` (`number`, optional): Limit on matching lines (defaults to 250).
- **Protections**:
  - Automatically skips binary files and excluded directories (`node_modules`, `.git`, etc.).
  - Returns matching file paths and one-based line numbers.
