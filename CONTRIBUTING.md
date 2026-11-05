# Contributing to Hernex

Thank you for contributing to **Hernex** (`@amaranthic/hernex`)!

`@amaranthic/hernex` is an execution harness and runtime bridge between application code and [Vercel AI SDK v7](https://ai-sdk.dev). It standardizes single-turn execution, fail-closed tool authorization, single-owner process execution, and snapshot rollbacks, while leaving agent personas, user experience, and high-level goal planning to product code.

---

## 🏛️ Core Architectural Invariants

Every contribution must preserve Hernex's fundamental design principles:

1. **The First-Slash Rule**:
   - Model strings are parsed by splitting strictly on the **first `/` only**.
   - The segment before the first slash is the provider ID (`openai`, `anthropic`, `google`, `openrouter`, etc.).
   - All segments after the first slash form the `modelId` (e.g. `openrouter/openrouter/free`) and are preserved intact.

2. **Mandatory Explicit Credentials**:
   - Every execution request **requires** non-empty `apiKey: string` and `baseUrl: string`.
   - Never introduce ambient environment variable fallbacks in runtime functions.
   - Provider mismatch: per-turn `model` cannot fall back across providers without explicit per-turn credentials.

3. **Curated Public Surface & Raw Subpath**:
   - The root export (`@amaranthic/hernex`) exposes curated Hernex runtime wrappers, engine, tools, thread stores, and checkpoint stores.
   - Raw native Vercel AI SDK capabilities are available via the opt-in subpath `@amaranthic/hernex/ai`.
   - Every `index.ts` must be a pure export barrel without declaration or runtime logic statements.

4. **Process Execution & Security Boundaries**:
   - `TaskManager` is the sole owner of process spawning (`spawn`) across the codebase.
   - `BashTool` commands run as the host operating system user with sanitized environment variables. Bash is an authorized shell capability, **not** a filesystem sandbox.

5. **Stateless Multi-Tenant Isolation**:
   - Provider instances are instantiated statelessly within the call frame. Never cache credentials in shared or module-level global variables.

---

## 📐 Strict Coding & Style Standards

### 1. Strict Identifier Casing
- **`camelCase`**: Strictly required for all variables, properties, functions, and methods.
- **`PascalCase`**: Strictly required for all classes, types, interfaces, and enums.
- **No Other Casing Allowed**: `snake_case` is forbidden in code identifiers across the codebase.

### 2. Comprehensive JSDoc Documentation
- Every module, exported function, class, interface, type alias, parameter, and return value **must** be documented with rich JSDoc comments (`/** ... */`).
- Comments must provide clear descriptions, `@param` details, `@returns` explanations, and usage examples where beneficial.

### 3. Verification Over Assumptions
- Never assume library signatures from memory.
- Always inspect installed package type declarations directly inside `node_modules/`.

---

## 🧪 Test Suite Architecture

To maintain high velocity, clean maintenance, and deep test coverage:

- **Strict File Limit**: Restrict the test suite to a **maximum of 6 to 8 test files** strictly within `tests/`:
  1. [`tests/model.test.ts`](tests/model.test.ts) — First-slash parsing, whitespace trimming, and credential validation.
  2. [`tests/providers.test.ts`](tests/providers.test.ts) — Provider registry, custom provider registration, and mock HTTP endpoint.
  3. [`tests/runtime.test.ts`](tests/runtime.test.ts) — `generateText`, `streamText`, `generateObject`, `streamObject`, and `./ai` subpath.
  4. [`tests/engine.test.ts`](tests/engine.test.ts) — Microkernel lifecycle, lazy turn reservation, signal aggregation, reasoning levels, and hook veto.
  5. [`tests/tools.test.ts`](tests/tools.test.ts) — Built-in tools (`readFile`, `writeFile`, `editFile`, `bash`, `glob`, `grep`), path guards, and `TaskManager`.
  6. [`tests/storage.test.ts`](tests/storage.test.ts) — Home directory resolution, atomic writes, file locking, JSONL recovery, and value codec.
  7. [`tests/threads.test.ts`](tests/threads.test.ts) — `FileThreadStore` lifecycle and transcript reconstruction.
  8. [`tests/checkpoints.test.ts`](tests/checkpoints.test.ts) — `FileCheckpointStore`, SHA-256 content-addressed blobs, and restore conflict detection.

---

## 🛠️ Development Workflow

- **Package Management**: Use `npm` for package installation and lockfile updates.
- **Execution & Testing**: Use `bun` for script execution, typechecks, and tests:
  ```bash
  bun run typecheck
  bun test
  bun run build
  ```

---

## 📜 License

Licensed under the [MIT License](LICENSE).
