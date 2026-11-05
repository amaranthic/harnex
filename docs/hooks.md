# Lifecycle Hooks & Authorization

Harnex provides inward interception hooks via [`AgentHooks`](../src/hooks/types.ts). Hooks allow applications to enforce security authorization, modify user prompts, inject dynamic context, evaluate task completion, and observe errors.

---

## 1. Defining Hooks

Hooks are configured on `AgentEngineConfig.hooks`:

```typescript
import {
  type AgentHooks,
  type PermissionDecision,
} from "@amaranthic/hernex";

const hooks: AgentHooks = {
  // Pre-turn modification or veto
  onBeforeTurn: async ({ turnIndex, userPrompt }) => {
    if (userPrompt.includes("forbidden")) {
      return { veto: true, vetoReason: "Policy violation: forbidden keyword" };
    }
    return {
      injectedInstructions: "Be concise and format code snippets in markdown.",
    };
  },

  // Mandatory fail-closed tool authorization
  onAuthorizeTool: async ({ toolName, parameters, workingDirectory }) => {
    if (toolName === "bash") {
      // Prompt user or evaluate safety policy
      return { decision: "deny", reason: "Bash execution is restricted." };
    }
    return { decision: "allow" };
  },

  // Completion decision when model stops proposing tools
  onShouldStop: async ({ turnIndex, finishReason, transcript }) => {
    // Return shouldStop: false with a reminderPrompt to guide the model further
    return { shouldStop: true };
  },

  // Guaranteed post-turn cleanup
  onAfterTurn: async ({ turnIndex, finishReason, totalUsage }) => {
    console.log(`Turn ${turnIndex} finalized with reason "${finishReason}"`);
  },

  // Diagnostic notification
  onError: async ({ error, origin, turnIndex, isFatal }) => {
    console.error(`Diagnostic error [${origin}] in turn ${turnIndex}:`, error);
  },
};
```

---

## 2. Fail-Closed Tool Authorization

> [!CAUTION]
> **All tools fail closed by default.**
> If `hooks.onAuthorizeTool` is omitted or undefined, the engine denies **all** tool executions.
> If an authorization hook throws an unhandled error, the engine treats it as an immediate denial and emits an error event. Tool execution never proceeds on a thrown error.

---

## 3. Composing Multiple Hook Layers

When multiple modules or plugins provide hooks, combine them deterministically with [`composeAgentHooks`](../src/hooks/composeAgentHooks.ts):

```typescript
import { composeAgentHooks, type AgentHooks } from "@amaranthic/hernex";

const securityLayer: AgentHooks = {
  onAuthorizeTool: async ({ toolName }) => {
    if (toolName === "bash") return { decision: "deny", reason: "Disabled by security policy" };
    return { decision: "allow" };
  },
};

const loggingLayer: AgentHooks = {
  onBeforeTurn: async ({ userPrompt }) => {
    console.log("Observing prompt:", userPrompt);
  },
  onAfterTurn: async ({ finishReason }) => {
    console.log("Turn finished:", finishReason);
  },
};

const composedHooks = composeAgentHooks([securityLayer, loggingLayer]);
```

### Composition Ordering Semantics
1. **`onBeforeTurn`**: Executed in array order. Each hook receives the updated effective prompt. Non-empty injected instructions concatenate with `\n\n`. Any veto immediately short-circuits subsequent hooks and aborts the turn.
2. **`onShouldStop`**: All layers must return `shouldStop: true` to stop. If any layer returns `shouldStop: false`, execution continues, concatenating reminder prompts in layer order.
3. **`onAuthorizeTool`**: Every layer must explicitly return `{ decision: "allow" }`. A single deny or thrown error denies execution.
4. **`onAfterTurn`**: Every layer runs inside the `finally` block even if a prior layer fails.
5. **`onError`**: Called at most once per layer. Failures within an error hook do not trigger recursive error dispatch.
