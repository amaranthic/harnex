/**
 * @fileoverview Test suite for model string parsing, credential validation, and ProviderRegistry isolation.
 */

import { describe, expect, it } from "bun:test";
import {
  parseModelString,
  validateCredentials,
  resolveModel,
  ProviderRegistry,
  HernexInvalidModelStringError,
  HernexMissingCredentialsError,
  type ProviderAdapter,
} from "../src/index.js";

describe("modelParsing", () => {
  it("should correctly split simple provider and model ID on the first slash", () => {
    const result = parseModelString("openai/gpt-4o");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
  });

  it("should preserve multi-slash model IDs without truncation or re-splitting", () => {
    const result = parseModelString("openrouter/openrouter/free");
    expect(result.provider).toBe("openrouter");
    expect(result.modelId).toBe("openrouter/free");
  });

  it("should preserve multiple slashes in complex nested model identifiers", () => {
    const result = parseModelString("compatible/org/sub-org/custom-model-v1");
    expect(result.provider).toBe("compatible");
    expect(result.modelId).toBe("org/sub-org/custom-model-v1");
  });

  it("should trim surrounding whitespace from provider and modelId", () => {
    const result = parseModelString("  anthropic  /  claude-3-5-sonnet  ");
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-3-5-sonnet");
  });

  it("should throw HernexInvalidModelStringError when no slash is present", () => {
    expect(() => parseModelString("gpt-4o")).toThrow(
      HernexInvalidModelStringError,
    );

    try {
      parseModelString("gpt-4o");
    } catch (error) {
      expect(HernexInvalidModelStringError.isInstance(error)).toBe(true);
      if (HernexInvalidModelStringError.isInstance(error)) {
        expect(error.modelString).toBe("gpt-4o");
        expect(error.message).toContain("No '/' delimiter found");
      }
    }
  });

  it("should throw HernexInvalidModelStringError when provider segment is empty", () => {
    expect(() => parseModelString("/gpt-4o")).toThrow(
      HernexInvalidModelStringError,
    );

    try {
      parseModelString("/gpt-4o");
    } catch (error) {
      expect(HernexInvalidModelStringError.isInstance(error)).toBe(true);
      if (HernexInvalidModelStringError.isInstance(error)) {
        expect(error.message).toContain(
          "Provider identifier before '/' is empty",
        );
      }
    }
  });

  it("should throw HernexInvalidModelStringError when modelId segment is empty", () => {
    expect(() => parseModelString("openai/")).toThrow(
      HernexInvalidModelStringError,
    );

    try {
      parseModelString("openai/");
    } catch (error) {
      expect(HernexInvalidModelStringError.isInstance(error)).toBe(true);
      if (HernexInvalidModelStringError.isInstance(error)) {
        expect(error.message).toContain("Model identifier after '/' is empty");
      }
    }
  });

  it("should throw HernexInvalidModelStringError when given non-string input", () => {
    // @ts-expect-error Testing non-string input
    expect(() => parseModelString(12345)).toThrow(
      HernexInvalidModelStringError,
    );
  });
});

describe("credentialsValidation", () => {
  it("should pass when both non-empty apiKey and baseUrl are provided", () => {
    expect(() => {
      validateCredentials(
        {
          apiKey: "sk-valid-key",
          baseUrl: "https://api.openai.com/v1",
        },
        "openai",
      );
    }).not.toThrow();
  });

  it("should throw HernexMissingCredentialsError when apiKey is missing or null", () => {
    expect(() =>
      // @ts-expect-error Testing missing apiKey
      validateCredentials({ baseUrl: "https://api.openai.com/v1" }, "openai"),
    ).toThrow(HernexMissingCredentialsError);

    try {
      // @ts-expect-error Testing missing apiKey
      validateCredentials({ baseUrl: "https://api.openai.com/v1" }, "openai");
    } catch (error) {
      expect(HernexMissingCredentialsError.isInstance(error)).toBe(true);
      if (HernexMissingCredentialsError.isInstance(error)) {
        expect(error.missingField).toBe("apiKey");
        expect(error.provider).toBe("openai");
      }
    }
  });

  it("should throw HernexMissingCredentialsError when apiKey is an empty string", () => {
    expect(() =>
      validateCredentials(
        {
          apiKey: "   ",
          baseUrl: "https://api.openai.com/v1",
        },
        "openai",
      ),
    ).toThrow(HernexMissingCredentialsError);
  });

  it("should throw HernexMissingCredentialsError when baseUrl is missing", () => {
    expect(() =>
      // @ts-expect-error Testing missing baseUrl
      validateCredentials({ apiKey: "sk-valid-key" }, "anthropic"),
    ).toThrow(HernexMissingCredentialsError);

    try {
      // @ts-expect-error Testing missing baseUrl
      validateCredentials({ apiKey: "sk-valid-key" }, "anthropic");
    } catch (error) {
      expect(HernexMissingCredentialsError.isInstance(error)).toBe(true);
      if (HernexMissingCredentialsError.isInstance(error)) {
        expect(error.missingField).toBe("baseUrl");
        expect(error.provider).toBe("anthropic");
      }
    }
  });

  it("should throw HernexMissingCredentialsError when baseUrl is an empty string", () => {
    expect(() =>
      validateCredentials(
        {
          apiKey: "sk-valid-key",
          baseUrl: "   ",
        },
        "anthropic",
      ),
    ).toThrow(HernexMissingCredentialsError);
  });

  it("requires valid credentials for LanguageModel object inputs in resolveModel", () => {
    const mockModel = {
      specificationVersion: "v1",
      provider: "mock",
      modelId: "test",
    } as any;

    expect(() =>
      resolveModel(mockModel, { apiKey: "", baseUrl: "https://mock.com" }),
    ).toThrow(HernexMissingCredentialsError);

    expect(() =>
      resolveModel(mockModel, { apiKey: "key", baseUrl: "" }),
    ).toThrow(HernexMissingCredentialsError);

    expect(
      resolveModel(mockModel, { apiKey: "key", baseUrl: "https://mock.com" }),
    ).toBe(mockModel);
  });
});

describe("ProviderRegistry Isolation & Management", () => {
  it("rejects duplicate provider registration", () => {
    const registry = new ProviderRegistry([]);
    const adapter: ProviderAdapter = {
      providerId: "custom",
      createModel: () => ({}) as any,
    };

    registry.register(adapter);
    expect(() => registry.register(adapter)).toThrow(/already registered/);
  });

  it("unregisters and lists registered providers accurately", () => {
    const registry = new ProviderRegistry([]);
    const adapter1: ProviderAdapter = {
      providerId: "provider1",
      createModel: () => ({}) as any,
    };
    const adapter2: ProviderAdapter = {
      providerId: "provider2",
      createModel: () => ({}) as any,
    };

    registry.register(adapter1);
    registry.register(adapter2);
    expect(registry.list()).toEqual(["provider1", "provider2"]);
    expect(registry.has("provider1")).toBe(true);

    expect(registry.unregister("provider1")).toBe(true);
    expect(registry.has("provider1")).toBe(false);
    expect(registry.list()).toEqual(["provider2"]);
    expect(registry.unregister("provider1")).toBe(false);
  });
});
