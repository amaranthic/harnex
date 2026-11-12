# @amaranthic/hernex

[![npm version](https://img.shields.io/npm/v/@amaranthic/hernex.svg?style=flat-square)](https://www.npmjs.com/package/@amaranthic/hernex)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node-%3E%3D22-brightgreen.svg?style=flat-square)](https://nodejs.org)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.2-black.svg?style=flat-square)](https://bun.sh)
[![Vercel AI SDK](https://img.shields.io/badge/AI%20SDK-v7-black.svg?style=flat-square)](https://ai-sdk.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg?style=flat-square)](https://www.typescriptlang.org)

Hernex is a focused agent execution harness and runtime bridge between application code and the Vercel AI SDK. It provides deterministic multi-step turn loops, fail-closed tool authorization, single-owner process execution, and content-addressed snapshot rollbacks while leaving agent personas, user experience, and high-level goal planning to product code.

---

## Quick Start

```bash
bun add @amaranthic/hernex
```

```typescript
import { AgentEngine, ToolRegistry } from "@amaranthic/hernex";

const tools = new ToolRegistry({ includeDefaults: true });

const engine = new AgentEngine({
  threadId: "thread-001",
  workingDirectory: process.cwd(),
  model: "anthropic/claude-3-7-sonnet",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  baseUrl: "https://api.anthropic.com/v1",
  tools,
  hooks: {
    onAuthorizeTool: async () => ({ decision: "allow" }),
  },
});

for await (const event of engine.runTurn("Check working directory status")) {
  if (event.type === "tokenDelta") {
    process.stdout.write(event.text);
  }
}
```

---

## Key Invariants

1. **Explicit Credentials**: All runtime calls require explicit, non-empty `apiKey` and `baseUrl`. There are no hidden ambient environment variable fallbacks.
2. **First-Slash Model Parsing**: Models format as `provider/model_id` (e.g. `openrouter/openrouter/free`). Splitting occurs strictly on the first slash only.
3. **Fail-Closed Authorization**: All tools require explicit authorization via `hooks.onAuthorizeTool`; omission denies execution.
4. **Host Shell Capability**: `BashTool` runs with the host user's permissions with environment sanitization. It is an authorized host shell capability, not a filesystem sandbox.
5. **Raw SDK Subpath**: Direct Vercel AI SDK functions and schemas remain accessible via `@amaranthic/hernex/ai`.

---

## Documentation

- [Agent Engine & Turn Lifecycle](docs/agent.md)
- [Outward Streaming Events](docs/events.md)
- [Inward Interception Hooks](docs/hooks.md)
- [Tool Registry & Built-In Tools](docs/tools.md)

---

## License

MIT © Amaranthic
