/**
 * @fileoverview Test suite for Hernex runtime execution wrappers and ./ai escape hatch.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import http from "node:http";
import {
  generateText,
  streamText,
} from "../src/index.js";
import * as aiEscapeHatch from "../src/ai.js";

describe("runtimeExecution", () => {
  let server: http.Server;
  let serverBaseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });

      req.on("end", () => {
        const parsedBody = body
          ? (JSON.parse(body) as Record<string, unknown>)
          : {};
        const isStreaming = parsedBody["stream"] === true;

        if (isStreaming) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          res.write(
            `data: ${JSON.stringify({
              id: "stream-chunk-1",
              choices: [
                { delta: { content: "Streaming " }, finish_reason: null },
              ],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              id: "stream-chunk-2",
              choices: [
                { delta: { content: "text " }, finish_reason: null },
              ],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              id: "stream-chunk-3",
              choices: [
                { delta: { content: "works!" }, finish_reason: "stop" },
              ],
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const isObjectRequest = JSON.stringify(parsedBody).includes("person");
        const content = isObjectRequest
          ? JSON.stringify({ name: "Alice", age: 30 })
          : "Standard execution response";

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-exec-123",
            object: "chat.completion",
            created: 1700000000,
            model: "custom/fast",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content,
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as { port: number };
        serverBaseUrl = `http://127.0.0.1:${address.port}/v1`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("should execute generateText with prompt and instructions", async () => {
    const result = await generateText({
      model: "compatible/custom/fast",
      apiKey: "test-token",
      baseUrl: serverBaseUrl,
      prompt: "Hello world",
      system: "Be concise",
    });

    expect(result.text).toBe("Standard execution response");
    expect(result.usage.totalTokens).toBe(15);
  });

  it("should execute streamText and stream tokens correctly", async () => {
    const result = streamText({
      model: "compatible/custom/fast",
      apiKey: "test-token",
      baseUrl: serverBaseUrl,
      prompt: "Stream this response",
    });

    let accumulatedText = "";
    for await (const chunk of result.textStream) {
      accumulatedText += chunk;
    }

    expect(accumulatedText).toBe("Streaming text works!");
  });

  it("should expose raw AI SDK functionality through ./ai escape hatch", () => {
    expect(typeof aiEscapeHatch.generateText).toBe("function");
    expect(typeof aiEscapeHatch.streamText).toBe("function");
    expect(typeof aiEscapeHatch.tool).toBe("function");
  });

  it("does not expose internal primitives or obsolete aliases from root entry", async () => {
    const root = await import("../src/index.js");
    const rootKeys = Object.keys(root);

    // Internal primitives should not be leaked
    expect(rootKeys).not.toContain("z");
    expect(rootKeys).not.toContain("ToolExecutionQueue");
    expect(rootKeys).not.toContain("atomicWriteFile");
    expect(rootKeys).not.toContain("resolvePathWithinWorkspace");
    expect(rootKeys).not.toContain("getSafeBashEnvironment");
    expect(rootKeys).not.toContain("AsyncEventQueue");
    expect(rootKeys).not.toContain("runTurn");

    // Obsolete Greg aliases should not exist
    expect(rootKeys.some((k) => k.startsWith("Greg"))).toBe(false);
  });
});
