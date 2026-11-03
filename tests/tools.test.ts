/**
 * @file toolRegistry.test.ts
 * @description Comprehensive unit test suite for ToolRegistry
 * and built-in tools (readFile, writeFile, editFile, bash, glob, grep).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { AsyncEventQueue } from "../src/engine/eventQueue.js";
import {
  type AgentTool,
  BashTool,
  EditFileTool,
  GlobTool,
  GrepTool,
  ReadFileTool,
  TaskManager,
  TaskManagerTool,
  ToolRegistry,
  WriteFileTool,
} from "../src/tools/index.js";

describe("ToolRegistry", () => {
  it("registers all 7 default tools when includeDefaults is true", () => {
    const registry = new ToolRegistry();
    const list = registry.list();

    expect(list.length).toBe(7);
    expect(registry.has("readFile")).toBe(true);
    expect(registry.has("writeFile")).toBe(true);
    expect(registry.has("editFile")).toBe(true);
    expect(registry.has("bash")).toBe(true);
    expect(registry.has("taskManager")).toBe(true);
    expect(registry.has("glob")).toBe(true);
    expect(registry.has("grep")).toBe(true);
    expect(registry.list().length).toBe(7);
  });

  it("starts empty when includeDefaults is false", () => {
    const registry = new ToolRegistry({ includeDefaults: false });
    expect(registry.list().length).toBe(0);
    expect(registry.has("readFile")).toBe(false);
  });

  it("allows registering, overriding, and unregistering custom tools", () => {
    const registry = new ToolRegistry({ includeDefaults: false });

    const pingSchema = z.object({ msg: z.string() });
    const pingTool: AgentTool<typeof pingSchema, { pong: string }> = {
      name: "ping",
      description: "Ping pong test tool",
      inputSchema: pingSchema,
      execute: async (params) => ({ pong: params.msg }),
    };

    registry.register(pingTool);
    expect(registry.has("ping")).toBe(true);
    expect(registry.resolve("ping")).toBe(pingTool);

    const removed = registry.unregister("ping");
    expect(removed).toBe(true);
    expect(registry.has("ping")).toBe(false);
    expect(registry.unregister("ping")).toBe(false);
  });

  it("rejects duplicate tool registration unless allowOverride is explicitly true", () => {
    const registry = new ToolRegistry({ includeDefaults: false });
    const dummyTool: AgentTool = {
      name: "customTool",
      description: "Custom test tool",
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    };

    registry.register(dummyTool);
    expect(() => registry.register(dummyTool)).toThrow("already registered");

    // Allows overriding when explicitly configured
    expect(() =>
      registry.register(dummyTool, { allowOverride: true }),
    ).not.toThrow();
  });

  it("streams progress chunks via AsyncEventQueue without timer polling", async () => {
    const queue = new AsyncEventQueue<string>();
    const received: string[] = [];

    const consumer = (async () => {
      for await (const chunk of queue) {
        received.push(chunk);
      }
    })();

    queue.push("delta1");
    queue.push("delta2");
    queue.push("delta3");
    queue.close();

    await consumer;
    expect(received).toEqual(["delta1", "delta2", "delta3"]);
  });

  it("converts registered tools to native AI SDK v7 tool definitions via toSdkToolDefinitions", () => {
    const registry = new ToolRegistry({ includeDefaults: false });

    const echoSchema = z.object({ text: z.string() });
    const echoTool: AgentTool<typeof echoSchema, { text: string }> = {
      name: "echo",
      description: "Echoes input text",
      inputSchema: echoSchema,
      execute: async (params) => {
        return { text: params.text };
      },
    };

    registry.register(echoTool);
    const sdkTools = registry.toSdkToolDefinitions();

    expect(sdkTools.echo).toBeDefined();
    expect(sdkTools.echo!.description).toBe("Echoes input text");
  });
});

describe("Built-in File & Shell Tools", () => {
  let testWorkspace: string;

  beforeEach(() => {
    testWorkspace = join(tmpdir(), `greg-agent-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(testWorkspace, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testWorkspace, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  it("executes WriteFileTool and ReadFileTool with offset and line pagination", async () => {
    const writeTool = new WriteFileTool();
    const readTool = new ReadFileTool();

    const writeContext = {
      threadId: "t1",
      toolCallId: "c1",
      workingDirectory: testWorkspace,
    };

    // 1. Write file
    const content = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");
    const writeResult = await writeTool.execute(
      { filePath: "sub/test.txt", content },
      writeContext,
    );

    expect(writeResult.status).toBe("created");
    expect(writeResult.linesWritten).toBe(5);

    // 2. Read full file
    const readResult = await readTool.execute(
      { filePath: "sub/test.txt" },
      writeContext,
    );

    expect(readResult.totalLines).toBe(5);
    expect(readResult.linesReturned).toBe(5);
    expect(readResult.content).toContain("1: line 1");
    expect(readResult.content).toContain("5: line 5");

    // 3. Read slice with offset and limit
    const slicedResult = await readTool.execute(
      { filePath: "sub/test.txt", offset: 2, limit: 2 },
      writeContext,
    );

    expect(slicedResult.totalLines).toBe(5);
    expect(slicedResult.startLine).toBe(2);
    expect(slicedResult.linesReturned).toBe(2);
    expect(slicedResult.content).toBe("2: line 2\n3: line 3");
  });

  it("executes EditFileTool for surgical replacements", async () => {
    const writeTool = new WriteFileTool();
    const editTool = new EditFileTool();

    const context = {
      threadId: "t1",
      toolCallId: "c1",
      workingDirectory: testWorkspace,
    };

    await writeTool.execute(
      {
        filePath: "app.ts",
        content: "const a = 1;\nconst b = 2;\nconst c = 1;\n",
      },
      context,
    );

    // Fails on identical strings
    await expect(
      editTool.execute(
        { filePath: "app.ts", oldString: "const a", newString: "const a" },
        context,
      ),
    ).rejects.toThrow("identical");

    // Fails on duplicate without replaceAll
    await expect(
      editTool.execute(
        { filePath: "app.ts", oldString: "= 1;", newString: "= 10;" },
        context,
      ),
    ).rejects.toThrow("Found 2 matches");

    // Succeeds with replaceAll = true
    const editResult = await editTool.execute(
      {
        filePath: "app.ts",
        oldString: "= 1;",
        newString: "= 10;",
        replaceAll: true,
      },
      context,
    );

    expect(editResult.replacementsApplied).toBe(2);

    // Read back
    const readTool = new ReadFileTool();
    const readRes = await readTool.execute({ filePath: "app.ts" }, context);
    expect(readRes.content).toContain("const a = 10;");
    expect(readRes.content).toContain("const c = 10;");
  });

  it("executes BashTool capturing command output and exit codes", async () => {
    const bashTool = new BashTool();
    let emittedProgress = "";

    const context = {
      threadId: "t1",
      toolCallId: "c1",
      workingDirectory: testWorkspace,
      emitProgress: (chunk: string) => {
        emittedProgress += chunk;
      },
    };

    const result = await bashTool.execute(
      { command: "echo 'hello from bash'" },
      context,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello from bash");
    expect(emittedProgress).toContain("hello from bash");
  });

  it("executes GlobTool and GrepTool across files", async () => {
    // Setup directory structure
    writeFileSync(join(testWorkspace, "fileA.ts"), "export const ALPHA = 42;\n");
    writeFileSync(join(testWorkspace, "fileB.ts"), "export const BETA = 99;\n");
    mkdirSync(join(testWorkspace, "node_modules"), { recursive: true });
    writeFileSync(join(testWorkspace, "node_modules", "ignored.ts"), "export const ALPHA = 1;\n");

    const globTool = new GlobTool();
    const grepTool = new GrepTool();

    const context = {
      threadId: "t1",
      toolCallId: "c1",
      workingDirectory: testWorkspace,
    };

    // Glob search
    const globRes = await globTool.execute({ pattern: "**/*.ts" }, context);
    expect(globRes.matches).toContain("fileA.ts");
    expect(globRes.matches).toContain("fileB.ts");
    // Verifies node_modules is ignored
    expect(globRes.matches.some((m) => m.includes("node_modules"))).toBe(false);

    // Grep search
    const grepRes = await grepTool.execute({ pattern: "ALPHA" }, context);
    expect(grepRes.totalMatches).toBe(1);
    expect(grepRes.matches[0]?.filePath).toBe("fileA.ts");
    expect(grepRes.matches[0]?.lineNumber).toBe(1);
    expect(grepRes.matches[0]?.line).toContain("export const ALPHA = 42;");
  });

  it("preserves literal regex substitution sequences in EditFileTool replacements", async () => {
    const writeTool = new WriteFileTool();
    const editTool = new EditFileTool();
    const readTool = new ReadFileTool();
    const context = {
      threadId: "t1",
      toolCallId: "c1",
      workingDirectory: testWorkspace,
    };

    await writeTool.execute(
      {
        filePath: "literal.txt",
        content: "price is PLACEHOLDER\ncode is TOKEN\n",
      },
      context,
    );

    // Replace PLACEHOLDER with "$100" (contains $1)
    await editTool.execute(
      {
        filePath: "literal.txt",
        oldString: "PLACEHOLDER",
        newString: "$100",
      },
      context,
    );

    // Replace TOKEN with "$& and $$" (contains $& and $$)
    await editTool.execute(
      {
        filePath: "literal.txt",
        oldString: "TOKEN",
        newString: "$& and $$",
      },
      context,
    );

    const readRes = await readTool.execute({ filePath: "literal.txt" }, context);
    expect(readRes.content).toContain("price is $100");
    expect(readRes.content).toContain("code is $& and $$");
  });

  it("rejects path traversal attempts outside workspace root", async () => {
    const writeTool = new WriteFileTool();
    const readTool = new ReadFileTool();
    const context = {
      threadId: "t1",
      toolCallId: "c1",
      workingDirectory: testWorkspace,
    };

    await expect(
      writeTool.execute(
        { filePath: "../outside.txt", content: "forbidden" },
        context,
      ),
    ).rejects.toThrow("resolves outside");

    await expect(
      readTool.execute({ filePath: "../../etc/passwd" }, context),
    ).rejects.toThrow("resolves outside");
  });

  it("sanitizes environment variables in BashTool, stripping API keys and secrets", async () => {
    const bashTool = new BashTool();
    const context = {
      threadId: "t1",
      toolCallId: "c1",
      workingDirectory: testWorkspace,
    };

    process.env.ANTHROPIC_API_KEY = "super-secret-key";
    process.env.TEST_AUTH_TOKEN = "secret-token";

    try {
      const res = await bashTool.execute({ command: "env" }, context);
      expect(res.stdout).not.toContain("super-secret-key");
      expect(res.stdout).not.toContain("secret-token");
      expect(res.stdout).toContain("TERM=dumb");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.TEST_AUTH_TOKEN;
    }
  });

  it("rejects invalid regex patterns and sets isTruncated on single-file limits", async () => {
    const grepTool = new GrepTool();
    const context = {
      threadId: "t1",
      toolCallId: "c1",
      workingDirectory: testWorkspace,
    };

    writeFileSync(
      join(testWorkspace, "many.txt"),
      Array.from({ length: 10 }, (_, i) => `match line ${i}`).join("\n"),
    );

    // Invalid regex throws error
    await expect(
      grepTool.execute({ pattern: "(unclosed group" }, context),
    ).rejects.toThrow("Invalid regular expression");

    // Single-file headLimit truncation sets isTruncated: true
    const res = await grepTool.execute(
      { pattern: "match line", path: "many.txt", headLimit: 3 },
      context,
    );
    expect(res.matches.length).toBe(3);
    expect(res.isTruncated).toBe(true);
  });

  describe("TaskManager and Background Shell Integration", () => {
    it("allows TaskManagerTool and BashTool to be registered and unregistered independently", () => {
      const registry = new ToolRegistry({ includeDefaults: false });

      // TaskManagerTool can be registered without bash
      registry.register(new TaskManagerTool());
      expect(registry.has("taskManager")).toBe(true);
      expect(registry.has("bash")).toBe(false);

      // BashTool can also be registered
      registry.register(new BashTool());
      expect(registry.has("bash")).toBe(true);

      // Unregistering bash does NOT remove taskManager
      registry.unregister("bash");
      expect(registry.has("bash")).toBe(false);
      expect(registry.has("taskManager")).toBe(true);
    });

    it("launches an immediate background task when waitMsBeforeAsync is 0", async () => {
      const taskManager = new TaskManager({
        persist: false,
        threadId: "test-thread-bg",
      });
      const bashTool = new BashTool();
      const taskTool = new TaskManagerTool();
      const context = {
        threadId: "test-thread-bg",
        toolCallId: "call_1",
        workingDirectory: testWorkspace,
        taskManager,
      };

      const bashRes = await bashTool.execute(
        {
          command: 'node -e "setTimeout(() => console.log(\'done\'), 500)"',
          waitMsBeforeAsync: 0,
        },
        context,
      );

      expect(bashRes.status).toBe("running");
      expect(bashRes.exitCode).toBeNull();
      expect(bashRes.taskId).toBeDefined();

      const taskId = bashRes.taskId!;

      // List tasks via TaskManagerTool
      const listRes = await taskTool.execute({ action: "list" }, context);
      expect(listRes.action).toBe("list");
      if (listRes.action === "list") {
        expect(listRes.tasks.some((t) => t.id === taskId)).toBe(true);
      }

      await taskManager.shutdown();
    });

    it("automatically handoffs long-running commands to background after waitMsBeforeAsync", async () => {
      const taskManager = new TaskManager({
        persist: false,
        threadId: "test-thread-handoff",
      });
      const bashTool = new BashTool();
      const context = {
        threadId: "test-thread-handoff",
        toolCallId: "call_2",
        workingDirectory: testWorkspace,
        taskManager,
      };

      const bashRes = await bashTool.execute(
        {
          command: 'node -e "setTimeout(() => console.log(\'later\'), 400)"',
          waitMsBeforeAsync: 50,
        },
        context,
      );

      expect(bashRes.status).toBe("running");
      expect(bashRes.taskId).toBeDefined();
      expect(bashRes.message).toContain("detached to background task");

      await taskManager.shutdown();
    });

    it("executes line-paged reads with mandatory offset and limit", async () => {
      const taskManager = new TaskManager({
        persist: false,
        threadId: "test-thread-paged",
      });
      const bashTool = new BashTool();
      const taskTool = new TaskManagerTool();
      const context = {
        threadId: "test-thread-paged",
        toolCallId: "call_3",
        workingDirectory: testWorkspace,
        taskManager,
      };

      // Generate 10 distinct lines in a script
      const script =
        'node -e "for(let i=1;i<=10;i++) console.log(\'line_\' + i);"';
      const bashRes = await bashTool.execute(
        { command: script, waitMsBeforeAsync: 0 },
        context,
      );
      const taskId = bashRes.taskId!;

      // Wait for the script to finish writing output
      for (let i = 0; i < 40; i++) {
        const task = taskManager.getTask(taskId);
        if (task && task.status !== "running" && task.totalLines >= 10) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // Read page 1 (lines 1 to 4)
      const page1 = await taskTool.execute(
        { action: "read", taskId, offset: 1, limit: 4 },
        context,
      );
      expect(page1.action).toBe("read");
      if (page1.action === "read") {
        expect(page1.offset).toBe(1);
        expect(page1.limit).toBe(4);
        expect(page1.lines).toEqual(["line_1", "line_2", "line_3", "line_4"]);
        expect(page1.hasMore).toBe(true);
      }

      // Read page 2 (lines 5 to 8)
      const page2 = await taskTool.execute(
        { action: "read", taskId, offset: 5, limit: 4 },
        context,
      );
      if (page2.action === "read") {
        expect(page2.offset).toBe(5);
        expect(page2.lines).toEqual(["line_5", "line_6", "line_7", "line_8"]);
        expect(page2.hasMore).toBe(true);
      }

      // Read page 3 (lines 9 to 10)
      const page3 = await taskTool.execute(
        { action: "read", taskId, offset: 9, limit: 4 },
        context,
      );
      if (page3.action === "read") {
        expect(page3.offset).toBe(9);
        expect(page3.lines).toEqual(["line_9", "line_10"]);
        expect(page3.hasMore).toBe(false);
      }

      // Invalid offset < 1 throws error
      await expect(
        taskTool.execute(
          { action: "read", taskId, offset: 0, limit: 5 },
          context,
        ),
      ).rejects.toThrow("Offset must be >= 1");

      await taskManager.shutdown();
    });

    it("sends interactive stdin input to a running background task", async () => {
      const taskManager = new TaskManager({
        persist: false,
        threadId: "test-thread-stdin",
      });
      const bashTool = new BashTool();
      const taskTool = new TaskManagerTool();
      const context = {
        threadId: "test-thread-stdin",
        toolCallId: "call_4",
        workingDirectory: testWorkspace,
        taskManager,
      };

      // Spawns a process waiting for readline input
      const script =
        'node -e "const readline = require(\'readline\'); const rl = readline.createInterface({ input: process.stdin }); rl.on(\'line\', (l) => { process.stdout.write(\'ECHO:\' + l + \'\\n\', () => process.exit(0)); });"';

      const bashRes = await bashTool.execute(
        { command: script, waitMsBeforeAsync: 0 },
        context,
      );
      const taskId = bashRes.taskId!;

      // Allow node to start listening
      await new Promise((resolve) => setTimeout(resolve, 300));

      const inputRes = await taskTool.execute(
        { action: "sendInput", taskId, input: "secretPayload", newline: true },
        context,
      );

      expect(inputRes.action).toBe("sendInput");
      if (inputRes.action === "sendInput") {
        expect(inputRes.bytesWritten).toBeGreaterThan(0);
      }

      // Wait for process to exit and flush echo
      await new Promise((resolve) => setTimeout(resolve, 500));

      const readRes = await taskTool.execute(
        { action: "read", taskId, offset: 1, limit: 10 },
        context,
      );
      if (readRes.action === "read") {
        expect(readRes.lines.some((l) => l.includes("ECHO:secretPayload"))).toBe(
          true,
        );
      }

      await taskManager.shutdown();
    });

    it("terminates a running background task process tree via stop action", async () => {
      const taskManager = new TaskManager({
        persist: false,
        threadId: "test-thread-stop",
      });
      const bashTool = new BashTool();
      const taskTool = new TaskManagerTool();
      const context = {
        threadId: "test-thread-stop",
        toolCallId: "call_5",
        workingDirectory: testWorkspace,
        taskManager,
      };

      const bashRes = await bashTool.execute(
        {
          command: 'node -e "setInterval(() => console.log(\'alive\'), 100)"',
          waitMsBeforeAsync: 0,
        },
        context,
      );
      const taskId = bashRes.taskId!;

      // Stop the task
      const stopRes = await taskTool.execute(
        { action: "stop", taskId, signal: "SIGTERM" },
        context,
      );

      expect(stopRes.action).toBe("stop");
      if (stopRes.action === "stop") {
        expect(stopRes.status).toBe("killed");
      }

      await taskManager.shutdown();
    });
  });
});
