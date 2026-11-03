/**
 * @fileoverview Test suite for provider registry, adapter resolution, custom providers, and compatible endpoints.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import http from "node:http";
import {
  ProviderRegistry,
  resolveModel,
  generateText,
  HernexUnsupportedProviderError,
} from "../src/index.js";

describe("providerResolution", () => {
  it("should contain all 13 supported providers in the default ProviderRegistry", () => {
    const registry = new ProviderRegistry();
    const supported = registry.list();
    const expected = [
      "openai",
      "anthropic",
      "google",
      "xai",
      "deepseek",
      "groq",
      "mistral",
      "cohere",
      "togetherai",
      "alibaba",
      "openrouter",
      "compatible",
      "vercelgateway",
    ];

    expect(supported).toHaveLength(13);
    for (const provider of expected) {
      expect(supported).toContain(provider);
      expect(registry.has(provider)).toBe(true);
    }
  });

  it("should return false for unknown providers in registry.has()", () => {
    const registry = new ProviderRegistry();
    expect(registry.has("unknown-ai")).toBe(false);
    expect(registry.has("gateway")).toBe(false);
  });

  it("should throw HernexUnsupportedProviderError for unregistered providers", () => {
    const registry = new ProviderRegistry();
    expect(() =>
      resolveModel(
        "unknown-ai/some-model",
        {
          apiKey: "test-key",
          baseUrl: "https://api.unknown.com",
        },
        registry,
      ),
    ).toThrow(HernexUnsupportedProviderError);

    try {
      registry.resolve("non-existent");
    } catch (error) {
      expect(HernexUnsupportedProviderError.isInstance(error)).toBe(true);
      if (HernexUnsupportedProviderError.isInstance(error)) {
        expect(error.provider).toBe("non-existent");
        expect(error.supportedProviders).toContain("openai");
        expect(error.message).toContain("compatible/model_name");
      }
    }
  });

  it("should support isolated ProviderRegistry instances, custom registration, and duplicate rejection", () => {
    const registry = new ProviderRegistry([]);
    expect(registry.list()).toHaveLength(0);

    const mockAdapter = {
      providerId: "mock-provider",
      createModel: (modelId: string) =>
        ({
          modelId,
          provider: "mock-provider",
          specificationVersion: "v1",
        }) as any,
    };

    registry.register(mockAdapter);
    expect(registry.has("mock-provider")).toBe(true);
    expect(registry.resolve("mock-provider")).toBe(mockAdapter);

    expect(() => registry.register(mockAdapter)).toThrow(/already registered/);

    const resolved = resolveModel(
      "mock-provider/fast-v1",
      { apiKey: "test-key", baseUrl: "https://mock.test" },
      registry,
    );
    expect(resolved).toBeDefined();
  });
});

describe("compatibleProvider", () => {
  let server: http.Server;
  let serverBaseUrl: string;
  let receivedAuthHeader = "";
  let receivedRequestBody: Record<string, unknown> = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      receivedAuthHeader = req.headers.authorization ?? "";

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });

      req.on("end", () => {
        try {
          receivedRequestBody = JSON.parse(body) as Record<string, unknown>;
        } catch {
          receivedRequestBody = {};
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test-123",
            object: "chat.completion",
            created: 1700000000,
            model: "custom-org/llama-3-8b",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Response from mock compatible endpoint",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 15,
              completion_tokens: 7,
              total_tokens: 22,
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

  it("should direct request to custom endpoint using compatible prefix", async () => {
    const result = await generateText({
      model: "compatible/custom-org/llama-3-8b",
      apiKey: "custom-bearer-secret",
      baseUrl: serverBaseUrl,
      prompt: "Hello local endpoint",
    });

    expect(result.text).toBe("Response from mock compatible endpoint");
    expect(receivedAuthHeader).toBe("Bearer custom-bearer-secret");
    expect(receivedRequestBody.model).toBe("custom-org/llama-3-8b");
  });
});
