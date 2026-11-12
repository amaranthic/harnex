/**
 * @fileoverview Test suite for storage primitives: homeDirectory, atomicFile, lock, jsonl, and valueCodec.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveHomeDirectory,
  atomicWriteFile,
  withFileLock,
  withWorkspaceFileLock,
  getWorkspaceLockPath,
  isProcessAlive,
  appendJsonl,
  readJsonl,
  encodeValue,
  decodeValue,
} from "../src/storage/index.js";
import { HernexLockError } from "../src/errors.js";

describe("storage primitives", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(
      tmpdir(),
      `hernex_storage_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe("resolveHomeDirectory", () => {
    it("respects explicit homeDirectory option", () => {
      const explicit = path.join(testDir, "custom_home");
      const resolved = resolveHomeDirectory({ homeDirectory: explicit });
      expect(resolved).toBe(path.resolve(explicit));
    });

    it("respects HERNEX_HOME environment variable", () => {
      const originalEnv = process.env.HERNEX_HOME;
      try {
        process.env.HERNEX_HOME = path.join(testDir, "env_home");
        const resolved = resolveHomeDirectory();
        expect(resolved).toBe(path.resolve(testDir, "env_home"));
      } finally {
        if (originalEnv !== undefined) {
          process.env.HERNEX_HOME = originalEnv;
        } else {
          delete process.env.HERNEX_HOME;
        }
      }
    });

    it("falls back to default .greg directory when no options or env are set", () => {
      const originalEnv = process.env.HERNEX_HOME;
      try {
        delete process.env.HERNEX_HOME;
        const resolved = resolveHomeDirectory();
        expect(resolved).toContain(".greg");
      } finally {
        if (originalEnv !== undefined) {
          process.env.HERNEX_HOME = originalEnv;
        }
      }
    });
  });

  describe("atomicWriteFile", () => {
    it("writes string content atomically to destination", async () => {
      const dest = path.join(testDir, "nested", "target.txt");
      const bytes = await atomicWriteFile(dest, "hello atomic world");
      expect(bytes).toBe(18);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, "utf-8")).toBe("hello atomic world");
    });

    it("writes binary buffer atomically to destination", async () => {
      const dest = path.join(testDir, "binary.dat");
      const buffer = Buffer.from([1, 2, 3, 4, 5]);
      const bytes = await atomicWriteFile(dest, buffer);
      expect(bytes).toBe(5);
      expect(readFileSync(dest)).toEqual(buffer);
    });

    it("replaces existing destination file content cleanly without corruption", async () => {
      const dest = path.join(testDir, "replace.txt");
      await atomicWriteFile(dest, "initial content version 1");
      expect(readFileSync(dest, "utf-8")).toBe("initial content version 1");

      const bytes = await atomicWriteFile(dest, "updated content version 2");
      expect(bytes).toBe(25);
      expect(readFileSync(dest, "utf-8")).toBe("updated content version 2");

      const siblingFiles = readdirSync(testDir);
      const lingeringTemps = siblingFiles.filter((f) =>
        f.startsWith("replace.txt.tmp."),
      );
      expect(lingeringTemps).toHaveLength(0);
    });

    it("preserves POSIX file permissions when replacing an existing file and honors explicit mode", async () => {
      // 1. Existing executable file (0o750)
      const scriptPath = path.join(testDir, "script.sh");
      writeFileSync(scriptPath, "#!/bin/bash\necho 1");
      chmodSync(scriptPath, 0o750);
      expect(statSync(scriptPath).mode & 0o777).toBe(0o750);

      await atomicWriteFile(scriptPath, "#!/bin/bash\necho 2");
      expect(readFileSync(scriptPath, "utf-8")).toBe("#!/bin/bash\necho 2");
      expect(statSync(scriptPath).mode & 0o777).toBe(0o750);

      // 2. Existing restricted file (0o600)
      const secretPath = path.join(testDir, "secret.key");
      writeFileSync(secretPath, "old-secret");
      chmodSync(secretPath, 0o600);
      expect(statSync(secretPath).mode & 0o777).toBe(0o600);

      await atomicWriteFile(secretPath, "new-secret");
      expect(readFileSync(secretPath, "utf-8")).toBe("new-secret");
      expect(statSync(secretPath).mode & 0o777).toBe(0o600);

      // 3. Explicit mode override
      const overridePath = path.join(testDir, "override.txt");
      await atomicWriteFile(overridePath, "custom-mode", { mode: 0o700 });
      expect(statSync(overridePath).mode & 0o777).toBe(0o700);
    });

    it("handles concurrent writes with unique cryptographically random sibling temp names", async () => {
      const dest = path.join(testDir, "concurrent.txt");
      const writesCount = 15;
      const promises = Array.from({ length: writesCount }, (_, i) =>
        atomicWriteFile(dest, `payload-data-${i}`),
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(writesCount);
      expect(existsSync(dest)).toBe(true);
      const finalContent = readFileSync(dest, "utf-8");
      expect(finalContent).toMatch(/^payload-data-\d+$/);

      const siblingFiles = readdirSync(testDir);
      const lingeringTemps = siblingFiles.filter((f) =>
        f.startsWith("concurrent.txt.tmp."),
      );
      expect(lingeringTemps).toHaveLength(0);
    });

    it("cleans up sibling temp file on write or rename failure", async () => {
      const dest = path.join(testDir, "cleanup_fail.txt");
      const renameSpy = spyOn(fsPromises, "rename").mockImplementation(
        async () => {
          throw new Error("simulated rename failure");
        },
      );

      try {
        await expect(atomicWriteFile(dest, "failed content")).rejects.toThrow(
          "simulated rename failure",
        );
      } finally {
        renameSpy.mockRestore();
      }

      const siblingFiles = readdirSync(testDir);
      const lingeringTemps = siblingFiles.filter((f) =>
        f.startsWith("cleanup_fail.txt.tmp."),
      );
      expect(lingeringTemps).toHaveLength(0);
    });

    it("combines primary write error and cleanup failure into AggregateError", async () => {
      const dest = path.join(testDir, "aggregate_fail.txt");
      const renameSpy = spyOn(fsPromises, "rename").mockImplementation(
        async () => {
          throw new Error("simulated primary rename error");
        },
      );
      const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(
        async () => {
          throw new Error("simulated cleanup error");
        },
      );

      try {
        let thrownError: unknown = null;
        try {
          await atomicWriteFile(dest, "aggregate test content");
        } catch (error) {
          thrownError = error;
        }

        expect(thrownError).toBeInstanceOf(AggregateError);
        const agg = thrownError as AggregateError;
        expect(agg.errors).toHaveLength(2);
        expect((agg.errors[0] as Error).message).toBe(
          "simulated primary rename error",
        );
        expect((agg.errors[1] as Error).message).toBe(
          "simulated cleanup error",
        );
        expect(agg.message).toContain("Failed to atomically write");
        expect(agg.message).toContain("failed to clean up temporary file");
      } finally {
        renameSpy.mockRestore();
        unlinkSpy.mockRestore();
      }
    });
  });

  describe("withFileLock", () => {
    it("executes async action while holding exclusive lock", async () => {
      const lockFile = path.join(testDir, "exclusive.lock");
      let executed = false;

      const result = await withFileLock(lockFile, async () => {
        executed = true;
        expect(existsSync(lockFile)).toBe(true);
        return "lock_success";
      });

      expect(result).toBe("lock_success");
      expect(executed).toBe(true);
      expect(existsSync(lockFile)).toBe(false);
    });

    it("serializes concurrent lockers on the same lock file", async () => {
      const lockFile = path.join(testDir, "serial.lock");
      const order: number[] = [];
      let resolveLocker1Acquired: () => void;
      const locker1AcquiredPromise = new Promise<void>((resolve) => {
        resolveLocker1Acquired = resolve;
      });

      const locker1 = withFileLock(lockFile, async () => {
        resolveLocker1Acquired();
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push(1);
        return 1;
      });

      await locker1AcquiredPromise;

      const locker2 = withFileLock(lockFile, async () => {
        order.push(2);
        return 2;
      });

      const results = await Promise.all([locker1, locker2]);
      expect(results).toEqual([1, 2]);
      expect(order).toEqual([1, 2]);
    });

    it("immediately propagates non-EEXIST acquisition errors without retry", async () => {
      const lockFile = path.join(testDir, "non_eexist.lock");
      const nonEexistError = Object.assign(new Error("Permission denied"), {
        code: "EACCES",
      });
      const openSpy = spyOn(fsPromises, "open").mockImplementation(async () => {
        throw nonEexistError;
      });

      try {
        await expect(
          withFileLock(lockFile, async () => "value", { timeoutMs: 2000 }),
        ).rejects.toThrow("Permission denied");
      } finally {
        openSpy.mockRestore();
      }
    });

    it("times out with HernexLockError including lockPath when lock remains held", async () => {
      const lockFile = path.join(testDir, "timeout.lock");
      // Pre-create lock file to simulate an existing active holder
      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: process.pid,
          token: "other_token",
          createdAt: Date.now(),
        }),
      );

      let caughtError: unknown = null;
      try {
        await withFileLock(lockFile, async () => "ok", {
          timeoutMs: 60,
          retryIntervalMs: 15,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(HernexLockError);
      const lockError = caughtError as HernexLockError;
      expect(lockError.lockPath).toBe(path.resolve(lockFile));
      expect(lockError.message).toContain("Failed to acquire lock");
      expect(lockError.message).toContain("within 60ms");
    });

    it("detects token mismatch on release and preserves the foreign lock file", async () => {
      const lockFile = path.join(testDir, "mismatch.lock");

      let caughtError: unknown = null;
      try {
        await withFileLock(lockFile, async () => {
          // Tamper with lock file while held
          writeFileSync(
            lockFile,
            JSON.stringify({
              pid: 99999,
              token: "tampered_foreign_token",
              createdAt: Date.now(),
            }),
          );
          return "action_complete";
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(HernexLockError);
      const lockError = caughtError as HernexLockError;
      expect(lockError.message).toContain("Lock token mismatch");
      expect(lockError.lockPath).toBe(path.resolve(lockFile));
      // Foreign lock file must remain untouched
      expect(existsSync(lockFile)).toBe(true);
    });

    it("propagates release failure when the operation succeeds", async () => {
      const lockFile = path.join(testDir, "release_failure.lock");
      const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(
        async () => {
          throw new Error("simulated lock unlink failure");
        },
      );

      try {
        await expect(
          withFileLock(lockFile, async () => "op_done"),
        ).rejects.toThrow("simulated lock unlink failure");
      } finally {
        unlinkSpy.mockRestore();
      }
    });

    it("combines operation error and release failure into AggregateError", async () => {
      const lockFile = path.join(testDir, "op_and_release_failure.lock");
      const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(
        async () => {
          throw new Error("simulated lock release error");
        },
      );

      try {
        let caughtError: unknown = null;
        try {
          await withFileLock(lockFile, async () => {
            throw new Error("simulated operation error");
          });
        } catch (error) {
          caughtError = error;
        }

        expect(caughtError).toBeInstanceOf(AggregateError);
        const agg = caughtError as AggregateError;
        expect(agg.errors).toHaveLength(2);
        expect((agg.errors[0] as Error).message).toBe(
          "simulated operation error",
        );
        expect((agg.errors[1] as Error).message).toBe(
          "simulated lock release error",
        );
        expect(agg.message).toContain(
          "Operation failed and lock release also failed",
        );
      } finally {
        unlinkSpy.mockRestore();
      }
    });

    it("correctly identifies process liveness with isProcessAlive", () => {
      // Current process is alive
      expect(isProcessAlive(process.pid)).toBe(true);
      // Non-existent PID is dead
      expect(isProcessAlive(9999999)).toBe(false);
      // Invalid PIDs
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive(1.5)).toBe(false);
    });

    it("safely recovers a stale lock held by a dead PID without waiting for timeout", async () => {
      const lockFile = path.join(testDir, "stale_dead_pid.lock");
      // Pre-create lock file simulating a dead process (PID 9999999)
      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: 9999999,
          token: "dead_owner_token",
          createdAt: Date.now() - 5000,
        }),
      );

      const result = await withFileLock(
        lockFile,
        async () => {
          expect(existsSync(lockFile)).toBe(true);
          const currentContent = JSON.parse(readFileSync(lockFile, "utf-8"));
          expect(currentContent.pid).toBe(process.pid);
          expect(currentContent.token).not.toBe("dead_owner_token");
          return "recovered_ok";
        },
        { timeoutMs: 1000 },
      );

      expect(result).toBe("recovered_ok");
      expect(existsSync(lockFile)).toBe(false);
    });

    it("safely recovers a stale lock whose age exceeds staleMs even if PID is alive", async () => {
      const lockFile = path.join(testDir, "stale_age_exceeded.lock");
      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: process.pid,
          token: "aged_owner_token",
          createdAt: Date.now() - 100_000,
        }),
      );

      const result = await withFileLock(
        lockFile,
        async () => {
          const currentContent = JSON.parse(readFileSync(lockFile, "utf-8"));
          expect(currentContent.token).not.toBe("aged_owner_token");
          return "reclaimed_by_stale_ms";
        },
        { staleMs: 50_000, timeoutMs: 1000 },
      );

      expect(result).toBe("reclaimed_by_stale_ms");
      expect(existsSync(lockFile)).toBe(false);
    });

    it("aborts stale lock reclamation without displacing new owner if lock was replaced during race", async () => {
      const lockFile = path.join(testDir, "reclaim_race.lock");
      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: 9999999,
          token: "abandoned_token",
          createdAt: Date.now() - 10000,
        }),
      );

      // Simulate another process taking the lock right before atomic rename
      const originalRename = fsPromises.rename;
      let replacedByAnotherProcess = false;
      const renameSpy = spyOn(fsPromises, "rename").mockImplementation(
        async (from, to) => {
          if (to === path.resolve(lockFile) && !replacedByAnotherProcess) {
            replacedByAnotherProcess = true;
            // Write a live owner lock
            writeFileSync(
              lockFile,
              JSON.stringify({
                pid: process.pid,
                token: "active_legit_token",
                createdAt: Date.now(),
              }),
            );
            // Staging rename will fail
            throw new Error("simulated contention collision");
          }
          return originalRename(from, to);
        },
      );

      try {
        await expect(
          withFileLock(lockFile, async () => "should_not_run", {
            timeoutMs: 100,
            retryIntervalMs: 20,
          }),
        ).rejects.toThrow();

        // The live owner's lock file must NOT have been displaced
        const content = JSON.parse(readFileSync(lockFile, "utf-8"));
        expect(content.token).toBe("active_legit_token");
      } finally {
        renameSpy.mockRestore();
      }
    });
  });

  describe("withWorkspaceFileLock", () => {
    it("serializes concurrent operations targeting the same workspace file", async () => {
      const workspaceDir = path.join(testDir, "ws_lock");
      mkdirSync(workspaceDir, { recursive: true });
      const targetFile = "shared.txt";
      const order: number[] = [];

      let resolveOp1Acquired: () => void;
      const op1AcquiredPromise = new Promise<void>((resolve) => {
        resolveOp1Acquired = resolve;
      });

      const op1 = withWorkspaceFileLock(
        workspaceDir,
        targetFile,
        async () => {
          resolveOp1Acquired();
          await new Promise((resolve) => setTimeout(resolve, 60));
          order.push(1);
          return 1;
        },
        { homeDirectory: testDir },
      );

      await op1AcquiredPromise;

      const op2 = withWorkspaceFileLock(
        workspaceDir,
        targetFile,
        async () => {
          order.push(2);
          return 2;
        },
        { homeDirectory: testDir },
      );

      const results = await Promise.all([op1, op2]);
      expect(results).toEqual([1, 2]);
      expect(order).toEqual([1, 2]);
    });

    it("acquires multi-file locks in deterministic lexicographical order without deadlocking", async () => {
      const workspaceDir = path.join(testDir, "ws_multi");
      mkdirSync(workspaceDir, { recursive: true });

      // Thread A targets [fileB, fileA]
      // Thread B targets [fileA, fileB]
      // Because withWorkspaceFileLock sorts files lexicographically, both acquire fileA then fileB
      const order: string[] = [];

      const opA = withWorkspaceFileLock(
        workspaceDir,
        ["fileB.txt", "fileA.txt"],
        async () => {
          order.push("A");
          return "A";
        },
        { homeDirectory: testDir },
      );

      const opB = withWorkspaceFileLock(
        workspaceDir,
        ["fileA.txt", "fileB.txt"],
        async () => {
          order.push("B");
          return "B";
        },
        { homeDirectory: testDir },
      );

      const results = await Promise.all([opA, opB]);
      expect(results).toHaveLength(2);
      expect(order).toHaveLength(2);

      // Verify lock file locations are outside workspaceDir inside homeDirectory
      const lockPathA = getWorkspaceLockPath(
        workspaceDir,
        "fileA.txt",
        testDir,
      );
      expect(lockPathA.startsWith(testDir)).toBe(true);
      expect(lockPathA.includes(workspaceDir)).toBe(false);
      expect(existsSync(lockPathA)).toBe(false); // cleaned up on release
    });
  });

  describe("jsonl append and read", () => {
    it("appends and reads structured records using versioned envelope", async () => {
      const jsonlFile = path.join(testDir, "records.jsonl");

      await appendJsonl(jsonlFile, { id: 1, name: "alpha" });
      await appendJsonl(jsonlFile, { id: 2, name: "beta" });

      const records = await readJsonl<{ id: number; name: string }>(jsonlFile);
      expect(records).toEqual([
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" },
      ]);
    });

    it("reads legacy raw JSON lines without envelope fallback", async () => {
      const jsonlFile = path.join(testDir, "legacy.jsonl");
      writeFileSync(
        jsonlFile,
        '{"legacy": true, "name": "first"}\n{"legacy": false, "name": "second"}\n',
      );

      const records = await readJsonl<{ legacy: boolean; name: string }>(
        jsonlFile,
      );
      expect(records).toEqual([
        { legacy: true, name: "first" },
        { legacy: false, name: "second" },
      ]);
    });

    it("recovers from a torn trailing line without crashing during read", async () => {
      const jsonlFile = path.join(testDir, "torn.jsonl");

      await appendJsonl(jsonlFile, { id: 100, status: "complete" });
      // Simulate torn write: write an incomplete JSON line without trailing newline
      writeFileSync(
        jsonlFile,
        readFileSync(jsonlFile, "utf-8") + '{"id": 200, "status": "par',
      );

      const records = await readJsonl<{ id: number; status: string }>(
        jsonlFile,
      );
      expect(records).toEqual([{ id: 100, status: "complete" }]);
    });

    it("repairs torn non-newline-terminated final line before next append", async () => {
      const jsonlFile = path.join(testDir, "torn_append.jsonl");

      await appendJsonl(jsonlFile, { id: 1, title: "first" });
      // Append torn incomplete line without trailing newline
      writeFileSync(
        jsonlFile,
        readFileSync(jsonlFile, "utf-8") + '{"id": 2, "broken',
      );

      // Now append a new valid record; it should repair the torn tail first
      await appendJsonl(jsonlFile, { id: 3, title: "third" });

      const records = await readJsonl<{ id: number; title: string }>(jsonlFile);
      expect(records).toEqual([
        { id: 1, title: "first" },
        { id: 3, title: "third" },
      ]);
    });

    it("propagates truncate failure during torn line recovery fail-closed", async () => {
      const jsonlFile = path.join(testDir, "truncate_fail.jsonl");
      writeFileSync(jsonlFile, '{"id": 1}\n{"torn": "incomplete');

      const truncateSpy = spyOn(fsPromises, "truncate").mockImplementation(
        async () => {
          throw new Error("simulated truncate I/O error");
        },
      );

      try {
        await expect(readJsonl(jsonlFile)).rejects.toThrow(
          "simulated truncate I/O error",
        );
        await expect(appendJsonl(jsonlFile, { id: 2 })).rejects.toThrow(
          "simulated truncate I/O error",
        );
      } finally {
        truncateSpy.mockRestore();
      }
    });

    it("fails closed when middle record is corrupt", async () => {
      const jsonlFile = path.join(testDir, "corrupt_middle.jsonl");
      writeFileSync(jsonlFile, '{"id": 1}\n{"malformed json line\n{"id": 3}\n');

      await expect(readJsonl(jsonlFile)).rejects.toThrow(
        /Corrupt JSONL entry at line 2/,
      );
    });

    it("fails closed when newline-terminated final record is corrupt", async () => {
      const jsonlFile = path.join(testDir, "corrupt_terminated.jsonl");
      writeFileSync(jsonlFile, '{"id": 1}\n{"corrupt": incomplete}\n');

      await expect(readJsonl(jsonlFile)).rejects.toThrow(
        /Corrupt JSONL entry at line 2/,
      );
    });
  });

  describe("valueCodec", () => {
    it("round-trips primitive values and complex structures losslessly", () => {
      const data = {
        name: "Test",
        count: 42,
        active: true,
        nothing: null,
        missing: undefined,
        nanVal: NaN,
        infVal: Infinity,
        negInfVal: -Infinity,
        negZeroVal: -0,
        url: new URL("https://example.com/api/test"),
        bufferPayload: Buffer.from("binary buffer payload"),
        uint8Payload: new Uint8Array([10, 20, 30, 40]),
        nested: {
          items: [1, "two", false, null, undefined],
        },
      };

      const encoded = encodeValue(data);
      const decoded = decodeValue(encoded) as any;

      expect(decoded.name).toBe("Test");
      expect(decoded.count).toBe(42);
      expect(decoded.active).toBe(true);
      expect(decoded.nothing).toBeNull();
      expect(decoded.missing).toBeUndefined();
      expect(Number.isNaN(decoded.nanVal)).toBe(true);
      expect(decoded.infVal).toBe(Infinity);
      expect(decoded.negInfVal).toBe(-Infinity);
      expect(Object.is(decoded.negZeroVal, -0)).toBe(true);
      expect(decoded.url).toBeInstanceOf(URL);
      expect(decoded.url.href).toBe("https://example.com/api/test");

      // Verify Buffer vs Uint8Array distinction
      expect(Buffer.isBuffer(decoded.bufferPayload)).toBe(true);
      expect(decoded.bufferPayload.toString("utf-8")).toBe(
        "binary buffer payload",
      );

      expect(Buffer.isBuffer(decoded.uint8Payload)).toBe(false);
      expect(decoded.uint8Payload).toBeInstanceOf(Uint8Array);
      expect(Array.from(decoded.uint8Payload)).toEqual([10, 20, 30, 40]);

      expect(decoded.nested.items).toEqual([1, "two", false, null, undefined]);
    });

    it("rejects circular references with TypeError", () => {
      const cyclic: Record<string, unknown> = { id: 1 };
      cyclic.self = cyclic;

      expect(() => encodeValue(cyclic)).toThrow(TypeError);
      expect(() => encodeValue(cyclic)).toThrow("circular reference detected");
    });

    it("rejects functions, symbols, and bigint with TypeError", () => {
      expect(() => encodeValue(() => {})).toThrow(
        "functions are not serializable",
      );
      expect(() => encodeValue(Symbol("unsupported"))).toThrow(
        "symbols are not serializable",
      );
      expect(() => encodeValue(BigInt(12345))).toThrow(
        "bigint is not supported",
      );
    });

    it("rejects unsupported prototypes and custom class instances with TypeError", () => {
      class CustomEntity {
        constructor(readonly id: number) {}
      }

      expect(() => encodeValue(new CustomEntity(1))).toThrow(TypeError);
      expect(() => encodeValue(new CustomEntity(1))).toThrow(
        /unsupported prototype/,
      );
    });

    it("encodes and decodes valid acyclic diamond structures and shared sibling references losslessly", () => {
      const sharedItem = {
        id: "shared-meta",
        attributes: ["active", "primary"],
        count: 100,
      };

      const diamondObject = {
        leftBranch: sharedItem,
        rightBranch: sharedItem,
        directArray: [sharedItem, sharedItem],
        nested: {
          deepRef: sharedItem,
        },
      };

      const encoded = encodeValue(diamondObject);
      const decoded = decodeValue(encoded) as typeof diamondObject;

      expect(decoded.leftBranch.id).toBe("shared-meta");
      expect(decoded.rightBranch.id).toBe("shared-meta");
      expect(decoded.leftBranch.count).toBe(100);
      expect(decoded.directArray[0]!.attributes).toEqual(["active", "primary"]);
      expect(decoded.directArray[1]!.id).toBe("shared-meta");
      expect(decoded.nested.deepRef.id).toBe("shared-meta");
    });

    it("rejects indirect circular reference cycles in objects and arrays fail-closed", () => {
      const parent: Record<string, unknown> = { name: "parent" };
      const child: Record<string, unknown> = { parent };
      parent.child = child;

      expect(() => encodeValue(parent)).toThrow(TypeError);
      expect(() => encodeValue(parent)).toThrow("circular reference detected");

      const cyclicArray: unknown[] = [];
      cyclicArray.push(cyclicArray);
      expect(() => encodeValue(cyclicArray)).toThrow(TypeError);
      expect(() => encodeValue(cyclicArray)).toThrow(
        "circular reference detected",
      );
    });

    it("preserves __proto__ property as an own property without prototype manipulation", () => {
      const maliciousPayload: Record<string, unknown> = {};
      Object.defineProperty(maliciousPayload, "__proto__", {
        value: { isAdmin: true, injectedSecret: "compromised" },
        enumerable: true,
        writable: true,
        configurable: true,
      });

      const encoded = encodeValue(maliciousPayload);
      const decoded = decodeValue(encoded) as Record<string, unknown>;

      // The property must be an own property
      expect(Object.prototype.hasOwnProperty.call(decoded, "__proto__")).toBe(
        true,
      );
      // The prototype of decoded object must remain Object.prototype
      expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
      // It must NOT pollute or inject properties onto Object.prototype or empty objects
      expect((decoded as any).isAdmin).toBeUndefined();
      expect(({} as any).isAdmin).toBeUndefined();
      expect(({} as any).injectedSecret).toBeUndefined();
      // The encoded value round-trips correctly
      expect((decoded as any)["__proto__"]).toEqual({
        isAdmin: true,
        injectedSecret: "compromised",
      });
    });

    it("preserves null-prototype dictionary objects across round-trip encoding and decoding", () => {
      const nullDict: Record<string, unknown> = Object.create(null);
      nullDict.alpha = "first";
      nullDict.beta = 42;
      nullDict.nested = { standard: true };

      const encoded = encodeValue(nullDict);
      expect(encoded.type).toBe("object");
      if (encoded.type === "object") {
        expect(encoded.isNullPrototype).toBe(true);
      }

      const decoded = decodeValue(encoded) as Record<string, unknown>;
      expect(Object.getPrototypeOf(decoded)).toBeNull();
      expect(decoded.alpha).toBe("first");
      expect(decoded.beta).toBe(42);
      expect((decoded.nested as any).standard).toBe(true);
      expect(Object.getPrototypeOf(decoded.nested)).toBe(Object.prototype);
    });
  });
});
