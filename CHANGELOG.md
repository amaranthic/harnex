# Changelog

All notable changes to `@amaranthic/hernex` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.0] - 2026-11-12

### Summary

Version `0.3.0` represents a comprehensive architectural overhaul, hardening the microkernel agent engine, standardizing conversational persistence terminology, enforcing strict tool schema validation, introducing workspace-wide transactional file locking, upgrading transcript replay to full AI SDK v7 compatibility, and eliminating prototype pollution and serialization bugs.

---

### Migration Guide: Upgrading from `0.1.x`

This section details every breaking change between `0.1.x` and `0.3.0` and provides clear code examples on how to update older code.

#### 1. Package Rebrand: `@amaranthic/harnex` → `@amaranthic/hernex`

The package and repository have been renamed to `@amaranthic/hernex`.

**Before (`0.1.x`):**

```ts
import { AgentEngine, FileThreadStore } from "@amaranthic/harnex";
```

**After (`0.3.0`):**

```ts
import { AgentEngine, FileThreadStore } from "@amaranthic/hernex";
```

Update your `package.json`:

```json
{
  "dependencies": {
    "@amaranthic/hernex": "^0.3.0"
  }
}
```

---

#### 2. Terminology Standardization: `Session` → `Thread`

All persisted conversation state, identifiers, and storage methods now consistently use `thread` and `threadId` instead of `session` or `sessionId`.

**Before (`0.1.x`):**

```ts
const engine = new AgentEngine({
  sessionId: "session-123",
  sessionStore: new FileSessionStore({ storageDirectory: "./data" }),
  // ...
});

const session = await engine.sessionStore.getSession("session-123");
```

**After (`0.3.0`):**

```ts
const engine = new AgentEngine({
  threadId: "thread-123",
  threadStore: new FileThreadStore({ storageDirectory: "./data" }),
  // ...
});

const thread = await engine.threadStore.getThread("thread-123");
```

**Key API Renames:**

| Older API (`0.1.x`)                         | New API (`0.3.0`)                         |
| :------------------------------------------ | :---------------------------------------- |
| `config.sessionId`                          | `config.threadId`                         |
| `config.sessionStore`                       | `config.threadStore`                      |
| `engine.sessionId`                          | `engine.threadId`                         |
| `engine.sessionStore`                       | `engine.threadStore`                      |
| `FileSessionStore`                          | `FileThreadStore`                         |
| `SessionStore` (interface)                  | `ThreadStore` (interface)                 |
| `SessionRecord` / `SessionMetadata`         | `ThreadRecord` / `ThreadMetadata`         |
| `CreateSessionInput` / `UpdateSessionInput` | `CreateThreadInput` / `UpdateThreadInput` |

---

#### 3. Tool Input Schemas: `GlobTool` and `GrepTool`

Tool parameter schemas have been aligned with standard filesystem semantics and made strictly unambiguous.

##### A. `GlobTool`

- Renamed the ambiguous `path` parameter to `directoryPath`.

**Before (`0.1.x`):**

```ts
await globTool.execute({
  pattern: "**/*.ts",
  path: "./src", // Ambiguous
});
```

**After (`0.3.0`):**

```ts
await globTool.execute({
  pattern: "**/*.ts",
  directoryPath: "./src", // Required, unambiguous directory target
});
```

##### B. `GrepTool`

- Replaced ambiguous `path` with mutually exclusive `filePath` and `directoryPath`.

**Before (`0.1.x`):**

```ts
await grepTool.execute({
  pattern: "export function",
  path: "./src/index.ts", // or path: "./src"
});
```

**After (`0.3.0`):**

```ts
// For targeted single-file search:
await grepTool.execute({
  pattern: "export function",
  filePath: "./src/index.ts",
});

// For recursive directory search:
await grepTool.execute({
  pattern: "export function",
  directoryPath: "./src",
});
```

> [!NOTE]
> Passing both `filePath` and `directoryPath` or neither will fail validation with a descriptive Zod error.

---

#### 4. Turn Indexing: 1-Based Numbering Contract

Turn indexing across `ToolExecutionContext`, checkpoints, and engine hooks now strictly enforces a 1-based convention (`1, 2, 3, ...`). Turn index `0` is invalid.

**Before (`0.1.x`):**

```ts
// Turn counter started at 0 or serialized undefined as 0
context.turnIndex; // Could be 0
```

**After (`0.3.0`):**

```ts
// Turn counter starts at 1
context.turnIndex; // Always >= 1
// Optional turnIndex on checkpoints serializes as undefined when omitted, never 0
```

---

#### 5. Checkpoint Restore Error Handling: `HernexCheckpointRestoreError`

When restoring checkpoints containing multiple files, if a failure occurs halfway through, Hernex now automatically applies reverse-order rollback compensation to restore already-committed files to their prior state, and throws a typed `HernexCheckpointRestoreError`.

**Before (`0.1.x`):**

```ts
try {
  await checkpointStore.restoreCheckpoint("cp-1");
} catch (error) {
  // Generic error; unknown which files were mutated on disk
}
```

**After (`0.3.0`):**

```ts
import { HernexCheckpointRestoreError } from "@amaranthic/hernex";

try {
  await checkpointStore.restoreCheckpoint("cp-1");
} catch (error) {
  if (error instanceof HernexCheckpointRestoreError) {
    console.error("Checkpoint restore failed:", error.checkpointId);
    console.error("Compensated files:", error.compensatedPaths);
    console.error(
      "Unrecovered files requiring manual check:",
      error.unrecoveredPaths,
    );
    console.error("Rollback succeeded cleanly:", error.isCompensated);
  }
}
```

---

#### 6. AI SDK v7 Tool Replay & Transcript Projection

`FileThreadStore.getMessages(threadId)` now fully projects persisted transcripts into valid AI SDK v7 model messages.

- **Assistant Tool Calls & Tool Results**: In AI SDK v7, model tool calls in `role: "assistant"` messages require corresponding `role: "tool"` messages containing tool results. Hernex reconstructs these messages losslessly from persisted `toolResult` entries.
- **Residue Filtering**: Incompleted turns from crashes, hook vetoes, or failed model calls are automatically filtered out during replay, ensuring clean message histories without prompt corruption.
- **Transcript Versioning**: Transcripts written with version `1` (or unversioned) are automatically and lazily upgraded to `CURRENT_TRANSCRIPT_VERSION` (version `2`) upon read.

---

### New Features

- **Workspace Transactional File Locking (`withWorkspaceFileLock`)**:
  - Exclusive multi-file mutation locking for concurrent tools and threads (`src/storage/workspaceLock.ts`).
  - Locks are keyed outside the workspace in `<homeDirectory>/locks/workspaces/<workspaceHash>/<targetHash>.lock`.
  - Multi-file operations acquire locks in deterministic lexicographical order to prevent deadlocks and lock inversion.
  - Automatically integrated into `WriteFileTool`, `EditFileTool`, and `FileCheckpointStore.restoreCheckpoint`.

- **POSIX Permission Preservation (`atomicWriteFile`)**:
  - `atomicWriteFile` inspects regular file permissions (`stats.mode & 0o7777`) via `lstat` prior to replacement and restores them on the newly written file.
  - Supports explicit `{ mode: 0o755 }` overrides.

- **Stale Lock Recovery & CAS Arbitration (`withFileLock`)**:
  - Detects abandoned locks from terminated or crashed processes using local OS process liveness probes (`process.kill(pid, 0)` checking for `ESRCH`).
  - Supports configurable `staleMs` expiration for long-hanging processes or network-mounted filesystems.
  - Employs atomic staging and rename arbitration to guarantee live lock holders are never displaced during concurrent recovery.

- **Lossless Acyclic Graph Serialization (`valueCodec`)**:
  - Replaced global traversal sets with an active recursion ancestry stack.
  - Supports valid directed acyclic graphs (DAGs), diamond structures, and shared sibling object references without false circular reference errors.
  - Maintains strict cycle detection rejecting true circular references fail-closed.

- **Process Tree Abort Management (`BashTool`)**:
  - When a foreground bash execution is interrupted via `abortSignal`, `BashTool` issues `taskManager.stopTask(taskId)` and awaits terminal state escalation (`SIGTERM` followed by `SIGKILL`), ensuring background process trees are never orphaned.

---

### Bug Fixes & Resilience Hardening

- **Task Log Persistence Containment**: Protected child stream `data` handlers against disk write failures (e.g. disk full, read-only filesystem). Prevents host process crashes, drains stdout/stderr pipes to prevent buffer stalls, and surfaces `persistenceError` on task metadata.
- **Prototype Pollution Prevention (`valueCodec`)**: Properties are decoded using `Object.defineProperty` instead of direct assignment, safely preserving own `__proto__` properties without altering prototype chains.
- **Null-Prototype Dictionaries**: Added `isNullPrototype: true` support in `EncodedValue`, ensuring `Object.create(null)` objects round-trip without acquiring standard `Object.prototype`.
- **EditFileTool Regex Special Replacements**: Replaced regex string substitution with literal replacer functions, preventing `$1`, `$&`, and `$\`` from corrupting edited source code.
- **Strict Symlink Traversal Protection**: Hardened `pathGuard` to disallow symbolic links pointing outside the workspace across all filesystem and shell tools.
- **Idempotent Turn Finalization**: Protected `runTurn` to guarantee exactly one `turnFinished` event is persisted and emitted even if errors occur in `onError` hooks or transcript serialization.

---

### Publication Details

- Package: `@amaranthic/hernex`
- License: MIT
- Node.js Requirement: `>= 22.0.0`
