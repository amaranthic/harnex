/**
 * @fileoverview Test suite for storage primitives: homeDirectory, atomicFile, lock, jsonl, and valueCodec.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveHomeDirectory,
  atomicWriteFile,
  withFileLock,
  appendJsonl,
  readJsonl,
  encodeValue,
  decodeValue,
} from "../src/storage/index.js";

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

      const locker1 = withFileLock(lockFile, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push(1);
        return 1;
      });

      const locker2 = withFileLock(lockFile, async () => {
        order.push(2);
        return 2;
      });

      const results = await Promise.all([locker1, locker2]);
      expect(results).toEqual([1, 2]);
      expect(order).toEqual([1, 2]);
    });
  });

  describe("jsonl append and read", () => {
    it("appends and reads structured records", async () => {
      const jsonlFile = path.join(testDir, "records.jsonl");

      await appendJsonl(jsonlFile, { id: 1, name: "alpha" });
      await appendJsonl(jsonlFile, { id: 2, name: "beta" });

      const records = await readJsonl<{ id: number; name: string }>(jsonlFile);
      expect(records).toEqual([
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" },
      ]);
    });

    it("recovers from a torn trailing line without crashing", async () => {
      const jsonlFile = path.join(testDir, "torn.jsonl");

      await appendJsonl(jsonlFile, { id: 100, status: "complete" });
      // Simulate torn write: write an incomplete JSON line without trailing newline
      writeFileSync(jsonlFile, readFileSync(jsonlFile, "utf-8") + '{"id": 200, "status": "par');

      const records = await readJsonl<{ id: number; status: string }>(jsonlFile);
      expect(records).toEqual([{ id: 100, status: "complete" }]);
    });
  });

  describe("valueCodec", () => {
    it("round-trips primitive values and complex structures", () => {
      const data = {
        name: "Test",
        count: 42,
        active: true,
        nothing: null,
        url: new URL("https://example.com/api/test"),
        buffer: Buffer.from("binary payload"),
        nested: {
          items: [1, "two", false],
        },
      };

      const encoded = encodeValue(data);
      const decoded = decodeValue(encoded) as any;

      expect(decoded.name).toBe("Test");
      expect(decoded.count).toBe(42);
      expect(decoded.active).toBe(true);
      expect(decoded.nothing).toBeNull();
      expect(decoded.url.href).toBe("https://example.com/api/test");
      expect(Buffer.from(decoded.buffer).toString("utf-8")).toBe("binary payload");
      expect(decoded.nested.items).toEqual([1, "two", false]);
    });
  });
});
