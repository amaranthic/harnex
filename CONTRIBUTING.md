# Contributing to Hernex

Thank you for your interest in contributing to **Hernex** (`@amaranthic/hernex`)!

`@amaranthic/hernex` is the unified AI agent runtime, microkernel engine, and tool execution harness built directly on [Vercel AI SDK v7](https://ai-sdk.dev). It provides dynamic single-string model resolution, mandatory per-request credentials, autonomous multi-step turn orchestration, durable thread persistence, and content-addressed delta checkpointing.

To maintain code quality, security, and developer ergonomics, all contributors and coding agents must strictly adhere to the engineering guardrails and architecture contracts documented below.

---

## 🏛️ Core Architectural Invariants

Every contribution must preserve Hernex's fundamental design principles:

1. **The First-Slash Rule**:
   - Model strings are parsed by splitting strictly on the **first `/` only**.
   - The segment before the first slash is the `provider` identifier (e.g. `openai`, `anthropic`, `google`, `openrouter`, `vercelgateway`, `compatible`).
   - All segments after the first slash form the `modelId` (e.g. `openrouter/openrouter/free`, `compatible/org/model`) and are preserved completely intact without secondary splitting.

2. **Mandatory Explicit Credentials**:
   - Every execution request **requires** non-empty `apiKey: string` and `baseUrl: string` values.
   - Never introduce silent fallbacks to ambient `process.env` singletons in runtime calls.
   - Credential isolation: per-turn `model` cannot fall back across providers without per-turn credentials.

3. **Curated Public Surface & Raw Subpath**:
   - The root export (`@amaranthic/hernex`) exposes curated Hernex runtime wrappers, engine, tool registry, thread stores, and checkpoint stores.
   - Raw native Vercel AI SDK capabilities are available via the opt-in subpath `@amaranthic/hernex/ai`.

4. **Security Boundaries & Path Guards**:
   - All filesystem operations are strictly contained within the active workspace root via `resolvePathWithinWorkspace`.
   - Bash execution sanitizes environment variables to avoid leaking ambient API keys or tokens.

5. **Stateless Multi-Tenant Isolation**:
   - Provider instances are instantiated statelessly within the call frame. Never cache credentials in shared or module-level global variables.

---

## 📐 Strict Coding & Style Standards

### 1. Strict Identifier Casing
- **`camelCase`**: Strictly required for all variables, properties, functions, and methods.
- **`PascalCase`**: Strictly required for all classes, types, interfaces, and enums.
- **No Other Casing Allowed**: `snake_case` is strictly forbidden in code identifiers across the codebase.

### 2. Comprehensive JSDoc Documentation
- Every module, exported function, class, interface, type alias, parameter, and return value **must** be documented with rich JSDoc comments (`/** ... */`).
- Comments must provide clear context, detailed `@param` descriptions, `@returns` explanations, `@throws` documentation, and practical examples where beneficial.

### 3. Verification Over Assumptions
- Never assume library APIs, package signatures, or options from outdated training data.
- Always inspect installed package type declarations (`.d.ts`) directly inside `node_modules/`.

---

## 🧪 Test Suite Architecture

To maintain high velocity, clean maintenance, and deep test coverage:

- **Strict File Limit**: Restrict the test suite to a **maximum of 6 to 8 high-quality, high-coverage test files** located strictly within `tests/`:
  1. [`tests/model.test.ts`](tests/model.test.ts) — First-slash parsing, whitespace trimming, and credential validation.
  2. [`tests/providers.test.ts`](tests/providers.test.ts) — Provider registry, custom provider registration, and mock HTTP endpoint.
  3. [`tests/runtime.test.ts`](tests/runtime.test.ts) — `generateText`, `streamText`, `generateObject`, and `./ai` subpath.
  4. [`tests/engine.test.ts`](tests/engine.test.ts) — Microkernel lifecycle, turn reservation, reasoning levels, and hook veto.
  5. [`tests/tools.test.ts`](tests/tools.test.ts) — Built-in tools (`readFile`, `writeFile`, `editFile`, `bash`, `glob`, `grep`), path guards, and `TaskManagerTool`.
  6. [`tests/storage.test.ts`](tests/storage.test.ts) — Home directory resolution, atomic writes, file locking, JSONL append/recovery, and lossless value codec.
  7. [`tests/threads.test.ts`](tests/threads.test.ts) — `MemoryThreadStore` and `FileThreadStore` lifecycle and transcript reconstruction.
  8. [`tests/checkpoints.test.ts`](tests/checkpoints.test.ts) — `FileCheckpointStore`, SHA-256 content-addressed blobs, and restore conflict detection.

- **Test Runner**:
  ```bash
  bun test
  ```

---

## 🛠️ Development Workflow & Tooling Rules

- **Package Management**: Use `npm` strictly for package management (`npm install`, lockfile updates).
- **Execution & Testing**: Use `bun` for script execution, typechecks, and tests (`bun test`, `bun run build`, `bun run typecheck`).

### Commands
```bash
# Typecheck source and tests
bun run typecheck

# Run test suite
bun test

# Build distribution bundle
bun run build
```

---

## 📝 Commit & Pull Request Guidelines

### Commit Message Convention
Adhere to [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` A new feature or provider adapter
- `fix:` A bug fix or error correction
- `docs:` Documentation improvements
- `test:` Adding or refining test suites
- `chore:` Dependency updates or build tooling
- `refactor:` Code refactoring without behavioral changes

---

## 📜 License

Licensed under the [MIT License](LICENSE).
