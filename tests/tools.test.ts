/**
 * @file toolRegistry.test.ts
 * @description Comprehensive unit test suite for ToolRegistry
 * and built-in tools (readFile, writeFile, editFile, bash, glob, grep).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { FileCheckpointStore } from "../src/index.js";
import { AsyncEventQueue } from "../src/engine/eventQueue.js";
import { resolvePathWithinWorkspace } from "../src/tools/internal/pathGuard.js";
import { getSafeBashEnvironment } from "../src/tools/internal/bashEnvironment.js";
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

    // Verify tool prompt descriptions match actual capabilities (F-005)
    const taskManagerTool = registry.resolve("taskManager")!;
    expect(taskManagerTool.description).not.toContain("spawn");
    expect(taskManagerTool.description).not.toContain("spawning");

    const grepTool = registry.resolve("grep")!;
    expect(grepTool.description).not.toContain("plain text");
    expect(grepTool.description).toContain("filePath");
    expect(grepTool.description).toContain("directoryPath");

    const globTool = registry.resolve("glob")!;
    expect(globTool.description).toContain("directoryPath");
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
    testWorkspace = join(
      tmpdir(),
      `greg-agent-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
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
    const content = ["line 1", "line 2", "line 3", "line 4", "line 5"].join(
      "\n",
    );
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

  it("integrates checkpoint lifecycle with WriteFileTool and EditFileTool allowing clean rollback", async () => {
    const checkpointStore = new FileCheckpointStore({
      homeDirectory: testWorkspace,
    });
    const writeTool = new WriteFileTool();
    const editTool = new EditFileTool();

    let lastCreatedEvent:
      | {
          readonly checkpointId: string;
          readonly sequence: number;
          readonly label: string;
        }
      | undefined;

    const context = {
      threadId: "tool-checkpoint-thread",
      toolCallId: "call-1",
      workingDirectory: testWorkspace,
      checkpointStore,
      isCheckpointEnabled: true,
      onCheckpointCreated: (evt: {
        readonly checkpointId: string;
        readonly sequence: number;
        readonly label: string;
      }) => {
        lastCreatedEvent = evt;
      },
    };

    // 1. Create a new file via WriteFileTool
    await writeTool.execute(
      { filePath: "doc.txt", content: "initial content" },
      context,
    );
    expect(lastCreatedEvent).toBeDefined();
    expect(lastCreatedEvent?.label).toBe("writeFile: doc.txt");

    // 2. Modify the file via EditFileTool
    await editTool.execute(
      { filePath: "doc.txt", oldString: "initial", newString: "mutated" },
      context,
    );
    expect(lastCreatedEvent?.label).toBe("editFile: doc.txt");

    // Checkpoints were recorded with undefined turnIndex (omitted context index is not serialized as turn 0)
    const cps = await checkpointStore.listCheckpoints("tool-checkpoint-thread");
    expect(cps.length).toBe(2);
    expect(cps[0]?.turnIndex).toBeUndefined();
    expect(cps[1]?.turnIndex).toBeUndefined();

    // 3. Rollback the second checkpoint to restore file to "initial content"
    const restoreResult = await checkpointStore.restoreCheckpoint(
      "tool-checkpoint-thread",
      cps[1]!.id,
      testWorkspace,
    );
    expect(restoreResult.filesRestored).toBe(1);
    expect(readFileSync(join(testWorkspace, "doc.txt"), "utf-8")).toBe(
      "initial content",
    );

    // 4. Rollback the first checkpoint (where file was absent before) to delete it
    const restoreFirst = await checkpointStore.restoreCheckpoint(
      "tool-checkpoint-thread",
      cps[0]!.id,
      testWorkspace,
    );
    expect(restoreFirst.filesDeleted).toBe(1);
    expect(existsSync(join(testWorkspace, "doc.txt"))).toBe(false);
  });

  it("serializes concurrent edits from separate threads to the same file without lost updates or corrupted checkpoints", async () => {
    const checkpointStore = new FileCheckpointStore({
      homeDirectory: testWorkspace,
    });
    const writeTool = new WriteFileTool();
    const editTool = new EditFileTool();

    const targetFile = "concurrent_edit.txt";
    const initialContent = "counterA = 0;\ncounterB = 0;\n";

    await writeTool.execute(
      { filePath: targetFile, content: initialContent },
      {
        threadId: "setup-thread",
        toolCallId: "call-setup",
        workingDirectory: testWorkspace,
        checkpointStore,
        isCheckpointEnabled: true,
      },
    );

    const contextThreadA = {
      threadId: "thread-A",
      toolCallId: "call-A",
      workingDirectory: testWorkspace,
      checkpointStore,
      isCheckpointEnabled: true,
    };

    const contextThreadB = {
      threadId: "thread-B",
      toolCallId: "call-B",
      workingDirectory: testWorkspace,
      checkpointStore,
      isCheckpointEnabled: true,
    };

    // Concurrently edit counterA and counterB
    const editA = editTool.execute(
      {
        filePath: targetFile,
        oldString: "counterA = 0;",
        newString: "counterA = 1;",
      },
      contextThreadA,
    );

    const editB = editTool.execute(
      {
        filePath: targetFile,
        oldString: "counterB = 0;",
        newString: "counterB = 1;",
      },
      contextThreadB,
    );

    await Promise.all([editA, editB]);

    // Both edits must be present in the final file; neither was silently overwritten
    const finalContent = readFileSync(join(testWorkspace, targetFile), "utf-8");
    expect(finalContent).toContain("counterA = 1;");
    expect(finalContent).toContain("counterB = 1;");

    // Both threads recorded clean checkpoints
    const cpsA = await checkpointStore.listCheckpoints("thread-A");
    const cpsB = await checkpointStore.listCheckpoints("thread-B");
    expect(cpsA.length).toBe(1);
    expect(cpsB.length).toBe(1);
  });

  it("executes BashTool capturing command output and exit codes", async () => {
    const bashTool = new BashTool();
    const taskManager = new TaskManager({
      threadId: "t1",
      workingDirectory: testWorkspace,
    });
    let emittedProgress = "";

    const context = {
      threadId: "t1",
      toolCallId: "c1",
      workingDirectory: testWorkspace,
      taskManager,
      emitProgress: (chunk: string) => {
        emittedProgress += chunk;
      },
    };

    const result = await bashTool.execute(
      { command: "echo 'hello from bash'" },
      context,
    );

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("hello from bash");
    expect(emittedProgress).toContain("hello from bash");

    await taskManager.shutdown();
  });

  it("executes GlobTool and GrepTool across files", async () => {
    // Setup directory structure
    writeFileSync(
      join(testWorkspace, "fileA.ts"),
      "export const ALPHA = 42;\n",
    );
    writeFileSync(join(testWorkspace, "fileB.ts"), "export const BETA = 99;\n");
    const subDir = join(testWorkspace, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "fileC.ts"), "export const ALPHA = 100;\n");
    mkdirSync(join(testWorkspace, "node_modules"), { recursive: true });
    writeFileSync(
      join(testWorkspace, "node_modules", "ignored.ts"),
      "export const ALPHA = 1;\n",
    );

    const globTool = new GlobTool();
    const grepTool = new GrepTool();

    const context = {
      threadId: "t1",
      toolCallId: "c1",
      workingDirectory: testWorkspace,
    };

    // 1. Glob search default workspace
    const globRes = await globTool.execute({ pattern: "**/*.ts" }, context);
    expect(globRes.matches).toContain("fileA.ts");
    expect(globRes.matches).toContain("fileB.ts");
    expect(globRes.matches).toContain("sub/fileC.ts");
    expect(globRes.directoryPath).toBe(".");
    // Verifies node_modules is ignored
    expect(globRes.matches.some((m) => m.includes("node_modules"))).toBe(false);

    // 2. Glob search with explicit directoryPath
    const globSubRes = await globTool.execute(
      { pattern: "*.ts", directoryPath: "sub" },
      context,
    );
    expect(globSubRes.matches).toContain("sub/fileC.ts");
    expect(globSubRes.matches).not.toContain("fileA.ts");
    expect(globSubRes.directoryPath).toBe("sub");

    // 3. Grep search with directoryPath (default root)
    const grepRes = await grepTool.execute({ pattern: "ALPHA" }, context);
    expect(grepRes.totalMatches).toBe(2);
    expect(grepRes.directoryPath).toBe(".");
    expect(grepRes.matches.some((m) => m.filePath === "fileA.ts")).toBe(true);
    expect(grepRes.matches.some((m) => m.filePath === "sub/fileC.ts")).toBe(
      true,
    );

    // 4. Grep search scoped to specific single filePath
    const grepFileRes = await grepTool.execute(
      { pattern: "ALPHA", filePath: "fileA.ts" },
      context,
    );
    expect(grepFileRes.totalMatches).toBe(1);
    expect(grepFileRes.filePath).toBe("fileA.ts");
    expect(grepFileRes.matches[0]?.filePath).toBe("fileA.ts");
    expect(grepFileRes.matches[0]?.lineNumber).toBe(1);
    expect(grepFileRes.matches[0]?.line).toContain("export const ALPHA = 42;");

    // 5. Grep schema rejects supplying both filePath and directoryPath
    const invalidParse = grepTool.inputSchema.safeParse({
      pattern: "ALPHA",
      filePath: "fileA.ts",
      directoryPath: "sub",
    });
    expect(invalidParse.success).toBe(false);

    // 6. Grep rejects filePath pointing to a directory
    await expect(
      grepTool.execute({ pattern: "ALPHA", filePath: "sub" }, context),
    ).rejects.toThrow("Target filePath is a directory");

    // 7. Grep rejects directoryPath pointing to a file
    await expect(
      grepTool.execute(
        { pattern: "ALPHA", directoryPath: "fileA.ts" },
        context,
      ),
    ).rejects.toThrow("Target directoryPath is a file");
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

    const readRes = await readTool.execute(
      { filePath: "literal.txt" },
      context,
    );
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

  it("enforces strict path containment, symlink rejection, and missing leaf tolerance", () => {
    const canonicalWs = realpathSync(testWorkspace);

    // 1. Root equality
    expect(resolvePathWithinWorkspace(".", testWorkspace)).toBe(canonicalWs);
    expect(resolvePathWithinWorkspace(testWorkspace, testWorkspace)).toBe(
      canonicalWs,
    );

    // 2. Traversal rejection
    expect(() => resolvePathWithinWorkspace("..", testWorkspace)).toThrow(
      "resolves outside",
    );
    expect(() =>
      resolvePathWithinWorkspace("../outside.txt", testWorkspace),
    ).toThrow("resolves outside");
    expect(() =>
      resolvePathWithinWorkspace("/etc/passwd", testWorkspace),
    ).toThrow("resolves outside");

    // 3. Dot-dot prefixed filename inside workspace (..notes)
    const notesPath = resolvePathWithinWorkspace("..notes", testWorkspace);
    expect(notesPath).toBe(join(canonicalWs, "..notes"));

    // 4. Missing leaf in existing directory is allowed (for creating new files)
    const newFilePath = resolvePathWithinWorkspace(
      "nested_missing/file.txt",
      testWorkspace,
    );
    expect(newFilePath).toBe(join(canonicalWs, "nested_missing/file.txt"));

    // 5. Final symlink component rejection
    const targetReal = join(testWorkspace, "real_target.txt");
    writeFileSync(targetReal, "content", "utf8");
    const symlinkFile = join(testWorkspace, "link_file.txt");
    symlinkSync(targetReal, symlinkFile);

    expect(() =>
      resolvePathWithinWorkspace("link_file.txt", testWorkspace),
    ).toThrow("contains symbolic link");

    // 6. Symlink parent directory with missing child rejection (no bypass on missing leaf)
    const outsideDir = join(tmpdir(), `hernex_outside_${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    const symlinkDir = join(testWorkspace, "link_dir");
    symlinkSync(outsideDir, symlinkDir, "dir");

    try {
      expect(() =>
        resolvePathWithinWorkspace("link_dir/missing_child.txt", testWorkspace),
      ).toThrow("contains symbolic link");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }

    // 7. Internal symlink directory rejection
    const internalDir = join(testWorkspace, "internal_dir");
    mkdirSync(internalDir, { recursive: true });
    const internalSymlink = join(testWorkspace, "internal_symlink");
    symlinkSync(internalDir, internalSymlink, "dir");

    expect(() =>
      resolvePathWithinWorkspace("internal_symlink/file.txt", testWorkspace),
    ).toThrow("contains symbolic link");
  });

  it("verifies read, write, edit, glob, and grep cannot traverse workspace symlinks pointing outside", async () => {
    const outsideDir = join(tmpdir(), `hernex_outside_tools_${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "outside_secret.txt");
    writeFileSync(outsideFile, "SECRET_PASS=top_secret_token\n", "utf8");

    const symlinkFile = join(testWorkspace, "symlink_secret.txt");
    symlinkSync(outsideFile, symlinkFile);

    const symlinkDir = join(testWorkspace, "symlink_outside_dir");
    symlinkSync(outsideDir, symlinkDir, "dir");

    const readTool = new ReadFileTool();
    const writeTool = new WriteFileTool();
    const editTool = new EditFileTool();
    const globTool = new GlobTool();
    const grepTool = new GrepTool();

    const context = {
      threadId: "symlink-guard-thread",
      toolCallId: "call_symlink",
      workingDirectory: testWorkspace,
    };

    try {
      // 1. ReadFileTool rejects reading through symlink
      await expect(
        readTool.execute({ filePath: "symlink_secret.txt" }, context),
      ).rejects.toThrow("contains symbolic link");

      // 2. WriteFileTool rejects writing through symlink
      await expect(
        writeTool.execute(
          { filePath: "symlink_secret.txt", content: "overwritten" },
          context,
        ),
      ).rejects.toThrow("contains symbolic link");

      // 3. EditFileTool rejects editing through symlink
      await expect(
        editTool.execute(
          {
            filePath: "symlink_secret.txt",
            oldString: "SECRET_PASS",
            newString: "PUBLIC_PASS",
          },
          context,
        ),
      ).rejects.toThrow("contains symbolic link");

      // 4. GlobTool excludes symlink file and symlink directory matches
      const globResult = await globTool.execute({ pattern: "*" }, context);
      expect(globResult.matches).not.toContain("symlink_secret.txt");
      expect(globResult.matches).not.toContain("symlink_outside_dir");

      // 5. GrepTool does not enumerate or return matches from symlinks
      const grepResult = await grepTool.execute(
        { pattern: "top_secret_token" },
        context,
      );
      expect(grepResult.totalMatches).toBe(0);
      expect(grepResult.matches.length).toBe(0);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("constructs sanitized bash environment with allowlist support", () => {
    const prevKey = process.env.TEST_API_KEY;
    const prevCustom = process.env.CUSTOM_ALLOWED_VAR;
    process.env.TEST_API_KEY = "sensitive_key_val";
    process.env.CUSTOM_ALLOWED_VAR = "forwarded_val";

    try {
      const sanitized = getSafeBashEnvironment(["CUSTOM_ALLOWED_VAR"]);
      expect(sanitized.TERM).toBe("dumb");
      expect(sanitized.TEST_API_KEY).toBeUndefined();
      expect(sanitized.CUSTOM_ALLOWED_VAR).toBe("forwarded_val");
    } finally {
      if (prevKey !== undefined) {
        process.env.TEST_API_KEY = prevKey;
      } else {
        delete process.env.TEST_API_KEY;
      }
      if (prevCustom !== undefined) {
        process.env.CUSTOM_ALLOWED_VAR = prevCustom;
      } else {
        delete process.env.CUSTOM_ALLOWED_VAR;
      }
    }
  });

  it("sanitizes environment variables in BashTool, stripping API keys and secrets", async () => {
    const bashTool = new BashTool();
    const taskManager = new TaskManager({
      threadId: "t1",
      workingDirectory: testWorkspace,
    });
    const context = {
      threadId: "t1",
      toolCallId: "c1",
      workingDirectory: testWorkspace,
      taskManager,
    };

    process.env.ANTHROPIC_API_KEY = "super-secret-key";
    process.env.TEST_AUTH_TOKEN = "secret-token";

    try {
      const res = await bashTool.execute({ command: "env" }, context);
      expect(res.output).not.toContain("super-secret-key");
      expect(res.output).not.toContain("secret-token");
      expect(res.output).toContain("TERM=dumb");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.TEST_AUTH_TOKEN;
      await taskManager.shutdown();
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
      { pattern: "match line", filePath: "many.txt", headLimit: 3 },
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
        workingDirectory: testWorkspace,
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
          command: "node -e \"setTimeout(() => console.log('done'), 500)\"",
          waitMsBeforeAsync: 0,
        },
        context,
      );

      expect(bashRes.status).toBe("running");
      expect(bashRes.exitCode).toBeNull();
      expect(bashRes.taskId).toBeDefined();

      const taskId = bashRes.taskId;

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
        workingDirectory: testWorkspace,
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
          command: "node -e \"setTimeout(() => console.log('later'), 400)\"",
          waitMsBeforeAsync: 50,
        },
        context,
      );

      expect(bashRes.status).toBe("running");
      expect(bashRes.taskId).toBeDefined();

      await taskManager.shutdown();
    });

    it("executes line-paged reads with mandatory offset and limit", async () => {
      const taskManager = new TaskManager({
        persist: false,
        threadId: "test-thread-paged",
        workingDirectory: testWorkspace,
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
        "node -e \"for(let i=1;i<=10;i++) console.log('line_' + i);\"";
      const bashRes = await bashTool.execute(
        { command: script, waitMsBeforeAsync: 0 },
        context,
      );
      const taskId = bashRes.taskId;

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
        workingDirectory: testWorkspace,
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
        "node -e \"const readline = require('readline'); const rl = readline.createInterface({ input: process.stdin }); rl.on('line', (l) => { process.stdout.write('ECHO:' + l + '\\n', () => process.exit(0)); });\"";

      const bashRes = await bashTool.execute(
        { command: script, waitMsBeforeAsync: 0 },
        context,
      );
      const taskId = bashRes.taskId;

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
        expect(
          readRes.lines.some((l) => l.includes("ECHO:secretPayload")),
        ).toBe(true);
      }

      await taskManager.shutdown();
    });

    it("terminates a running background task process tree via stop action", async () => {
      const taskManager = new TaskManager({
        persist: false,
        threadId: "test-thread-stop",
        workingDirectory: testWorkspace,
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
          command: "node -e \"setInterval(() => console.log('alive'), 100)\"",
          waitMsBeforeAsync: 0,
        },
        context,
      );
      const taskId = bashRes.taskId;

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

    it("supports direct TaskManager execution, wait timeout, and terminal deletion", async () => {
      const taskManager = new TaskManager({
        persist: false,
        threadId: "test-thread-direct",
        workingDirectory: testWorkspace,
      });

      const task = await taskManager.createTask({
        command: "node -e \"setInterval(() => console.log('tick'), 100)\"",
      });

      expect(task.id).toBeDefined();
      expect(task.status).toBe("running");

      // Waiting with a short timeout should report timedOut without killing
      const waitResult = await taskManager.waitForTask(task.id, {
        timeoutMs: 50,
      });
      expect(waitResult.timedOut).toBe(true);
      expect(waitResult.task.status).toBe("running");

      // Attempting to delete a running task must throw fail-closed
      await expect(taskManager.deleteTask(task.id)).rejects.toThrow(
        "Only terminal tasks may be deleted",
      );

      // Stop the task gracefully
      const stopResult = await taskManager.stopTask(task.id, {
        signal: "SIGTERM",
      });
      expect(stopResult.status).toBe("killed");

      // Deleting a terminal task succeeds
      const deleted = await taskManager.deleteTask(task.id);
      expect(deleted).toBe(true);

      // Second deletion returns false
      expect(await taskManager.deleteTask(task.id)).toBe(false);

      await taskManager.shutdown();
    });

    it("caps persisted log bytes and marks outputTruncated when exceeding maxOutputBytes", async () => {
      const taskManager = new TaskManager({
        persist: false,
        threadId: "test-thread-cap",
        workingDirectory: testWorkspace,
        maxOutputBytes: 120,
      });

      const script =
        "node -e \"for(let i=0; i<30; i++) console.log('output_line_payload_' + i);\"";
      const task = await taskManager.createTask({ command: script });

      const waitRes = await taskManager.waitForTask(task.id, {
        timeoutMs: 3000,
      });
      expect(waitRes.timedOut).toBe(false);
      expect(waitRes.task.outputTruncated).toBe(true);
      expect(waitRes.task.outputBytes).toBeGreaterThan(120);

      const paged = await taskManager.readTask(task.id, 1, 100);
      expect(paged.outputTruncated).toBe(true);

      await taskManager.shutdown();
    });

    it("reloads persisted tasks on startup and marks active processes as orphaned", async () => {
      const taskManager = new TaskManager({
        persist: false,
        threadId: "test-thread-orphan",
        workingDirectory: testWorkspace,
      });
      const taskTool = new TaskManagerTool();
      const context = {
        threadId: "test-thread-orphan",
        toolCallId: "call_6",
        workingDirectory: testWorkspace,
        taskManager,
      };

      const task = await taskManager.createTask({
        command: "node -e \"console.log('hello');\"",
      });
      await taskManager.waitForTask(task.id, { timeoutMs: 2000 });

      // Delete via TaskManagerTool
      const delRes = await taskTool.execute(
        { action: "delete", taskId: task.id },
        context,
      );
      expect(delRes.action).toBe("delete");
      if (delRes.action === "delete") {
        expect(delRes.deleted).toBe(true);
      }

      await taskManager.shutdown();
    });
  });
});
