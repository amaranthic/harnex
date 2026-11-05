# Tool Registry & Built-In Tools

Harnex provides a structured tool registry and 7 built-in tools for workspace file manipulation, shell command execution, and background process management.

---

## 1. Implementing Custom Tools

Every tool implements the [`AgentTool`](../src/tools/AgentTool.ts) interface:

```typescript
import { z } from "zod";
import type { AgentTool, ToolExecutionContext } from "@amaranthic/hernex";

export const weatherSchema = z.object({
  city: z.string().describe("City name to fetch weather for"),
});

export class WeatherTool implements AgentTool<typeof weatherSchema, { temp: number }> {
  public readonly name = "getWeather";
  public readonly description = "Fetches current temperature for a city.";
  public readonly inputSchema = weatherSchema;

  public async execute(
    params: z.infer<typeof weatherSchema>,
    context: ToolExecutionContext,
  ): Promise<{ temp: number }> {
    context.emitProgress?.(`Querying weather service for ${params.city}...`);
    return { temp: 22 };
  }
}
```

---

## 2. Managing the `ToolRegistry`

Register, override, list, or unregister tools on [`ToolRegistry`](../src/tools/ToolRegistry.ts):

```typescript
import { ToolRegistry } from "@amaranthic/hernex";

const registry = new ToolRegistry({ includeDefaults: true });

registry.register(new WeatherTool());
registry.unregister("glob");

console.log("Registered tools:", registry.list());
```

---

## 3. Filesystem Security & Path Containment

All built-in file tools ([`ReadFileTool`](../src/tools/ReadFileTool.ts), [`WriteFileTool`](../src/tools/WriteFileTool.ts), [`EditFileTool`](../src/tools/EditFileTool.ts), [`GlobTool`](../src/tools/GlobTool.ts), [`GrepTool`](../src/tools/GrepTool.ts)) enforce strict boundary checks:

- Paths are verified to reside strictly within `workingDirectory`.
- Symlink traversal outside the workspace boundary is detected via `lstat` and strictly denied.
- Writes and edits use atomic sibling temporary file replacement (`atomicWriteFile`) to guarantee zero torn writes.

---

## 4. Shell Execution: `BashTool` & `TaskManager`

Harnex includes two complementary process tools:
1. **`BashTool` (`bash`)**: Model-facing command executor with automatic background handoff.
2. **`TaskManagerTool` (`taskManager`)**: Model-facing tool to list, read, send stdin, and stop background tasks.

Both tools share a single process owner: [`TaskManager`](../src/tasks/TaskManager.ts).

> [!WARNING]
> **Bash is NOT a Filesystem Sandbox.**
> Commands executed by `BashTool` run as the current operating system user with full host permissions. While Harnex sanitizes sensitive environment variables (stripping keys matching `KEY`, `SECRET`, `TOKEN`, `PASSWORD`), it does **not** sandbox host filesystem access. Always enforce policy via `onAuthorizeTool`.

### 4.1 Shell Command Execution (`BashTool`)
- `command` (required): Shell string to execute.
- `waitMsBeforeAsync` (optional, default: `10000` ms): How long to wait before handing off to a background task (`0` = immediate background).
- `timeoutMs` (optional): Hard process lifetime; exceeding this stops the process.

### 4.2 Background Task Management (`TaskManagerTool`)
Supports discriminated actions:
- `action: "list"`: Lists active and completed tasks with runtime, status, exit code, and line count.
- `action: "read"`: Line-paged file read of task output logs (`offset`, `limit`).
- `action: "sendInput"`: Sends text to standard input (`input`, optional `newline`).
- `action: "stop"`: Sends `SIGTERM` (escalating to `SIGKILL` after grace period).
- `action: "delete"`: Deletes metadata and logs of terminal tasks.

---

## 5. File Delta Checkpoints

When checkpointing is enabled (`checkpoint: true`), `WriteFileTool` and `EditFileTool` snapshot file changes automatically:
- Pre-mutation state is recorded before writing.
- Post-mutation state is updated after successful writes.
- If an uncommitted external modification creates a conflict, `restoreCheckpoint` rejects the rollback cleanly unless `force: true` is passed.
