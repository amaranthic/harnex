/**
 * @fileoverview Interactive agent terminal session demonstrating dynamic model switching,
 * reasoning effort configuration, bash command authorization (y/n), and background task management with AgentEngine.
 *
 * Commands:
 *   .model 1              - Switches to Model 1: Google Gemini Flash Lite (google/gemini-flash-lite-latest)
 *   .model 2              - Switches to Model 2: OpenRouter Free tier (openrouter/openrouter/free)
 *   .model <provider/id>  - Switches to any arbitrary model (e.g. .model openai/gpt-4o)
 *   .effort <level>       - Sets reasoning level (none, minimal, low, medium, high, xhigh, max, provider-default)
 *   .status               - Displays current model, reasoning effort, and active tools
 *   .help                 - Displays help instructions
 *   .exit / .quit         - Terminates the session
 *
 * Usage:
 *   node examples/example.ts
 *   node examples/example.ts --smoke
 *
 * @packageDocumentation
 */

import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import {
  AgentEngine,
  type AgentReasoningLevel,
  BashTool,
  GlobTool,
  GrepTool,
  ReadFileTool,
  TaskManagerTool,
  ToolRegistry,
} from "../src/index.js";

/**
 * Valid reasoning levels supported by AI SDK v7.
 */
const validReasoningLevels: readonly AgentReasoningLevel[] = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * Preset Model Definitions for quick switching via `.model 1` and `.model 2`.
 */
interface ModelPreset {
  readonly id: string;
  readonly displayName: string;
  readonly modelString: string;
  readonly envVar: string;
  readonly baseUrl: string;
  readonly getApiKey: () => string;
}

const modelPresets: Record<"1" | "2", ModelPreset> = {
  "1": {
    id: "1",
    displayName: "gemini-flash-lite-latest",
    modelString: "google/gemini-flash-lite-latest",
    envVar: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    getApiKey: () => process.env.GEMINI_API_KEY ?? "",
  },
  "2": {
    id: "2",
    displayName: "openrouter/openrouter/free",
    modelString: "openrouter/openrouter/free",
    envVar: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    getApiKey: () => process.env.OPENROUTER_API_KEY ?? "",
  },
};

/**
 * Resolves credentials for any given model string.
 *
 * @param model - Model string (e.g. 'google/gemini-flash-lite-latest', 'openrouter/openrouter/free').
 * @returns Object with apiKey and baseUrl.
 */
function resolveCredentialsForModel(model: string): {
  apiKey: string;
  baseUrl: string;
  envVarName?: string;
} {
  if (model === modelPresets["1"].modelString) {
    return {
      apiKey: modelPresets["1"].getApiKey(),
      baseUrl: modelPresets["1"].baseUrl,
      envVarName: modelPresets["1"].envVar,
    };
  }

  if (model === modelPresets["2"].modelString) {
    return {
      apiKey: modelPresets["2"].getApiKey(),
      baseUrl: modelPresets["2"].baseUrl,
      envVarName: modelPresets["2"].envVar,
    };
  }

  const provider = model.split("/")[0]?.toLowerCase();

  switch (provider) {
    case "google":
      return {
        apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        envVarName: "GEMINI_API_KEY",
      };
    case "openrouter":
      return {
        apiKey: process.env.OPENROUTER_API_KEY ?? "",
        baseUrl: "https://openrouter.ai/api/v1",
        envVarName: "OPENROUTER_API_KEY",
      };
    case "anthropic":
      return {
        apiKey: process.env.ANTHROPIC_API_KEY ?? "",
        baseUrl: "https://api.anthropic.com/v1",
        envVarName: "ANTHROPIC_API_KEY",
      };
    case "openai":
      return {
        apiKey: process.env.OPENAI_API_KEY ?? "",
        baseUrl: "https://api.openai.com/v1",
        envVarName: "OPENAI_API_KEY",
      };
    default:
      return {
        apiKey: process.env.API_KEY ?? "",
        baseUrl: process.env.BASE_URL ?? "https://api.openai.com/v1",
        envVarName: "API_KEY",
      };
  }
}

/**
 * Runs the interactive agent terminal loop or smoke test.
 */
async function main(): Promise<void> {
  // 1. Build a ToolRegistry with exploration tools, bash, and task management
  const tools = new ToolRegistry({ includeDefaults: false });
  tools.register(new ReadFileTool());
  tools.register(new GlobTool());
  tools.register(new GrepTool());
  tools.register(new BashTool());
  tools.register(new TaskManagerTool());

  // Non-network CI smoke mode
  if (process.argv.includes("--smoke")) {
    console.log("Hernex example smoke test mode passed successfully.");
    console.log(`Working Directory: ${process.cwd()}`);
    console.log(`Registered Tools:  ${tools.list().map((t) => t.name).join(", ")}`);
    return;
  }

  const rl = readline.createInterface({ input, output });

  // 2. Initial session parameters (defaults to Preset 1)
  let activeModel = modelPresets["1"].modelString;
  let activeReasoningEffort: AgentReasoningLevel = "high";
  const workingDirectory = process.cwd();

  const initialCredentials = resolveCredentialsForModel(activeModel);

  // 3. Instantiate the core engine with interactive tool authorization hook for bash
  const engine = new AgentEngine({
    threadId: `th_example_${Date.now()}`,
    workingDirectory,
    model: activeModel,
    apiKey: initialCredentials.apiKey || "placeholder-key",
    baseUrl: initialCredentials.baseUrl,
    instructions:
      "You are an assistant with access to filesystem exploration tools (readFile, glob, grep), " +
      "bash execution, and background task management (taskManager). " +
      "For long-running processes or servers, use waitMsBeforeAsync to run in background.",
    tools,
    reasoning: activeReasoningEffort,
    hooks: {
      onAuthorizeTool: async (context) => {
        if (context.toolName === "bash") {
          const rawParams = context.parameters as { command?: unknown } | undefined;
          const commandStr =
            rawParams && typeof rawParams.command === "string"
              ? rawParams.command
              : JSON.stringify(context.parameters);

          console.log(`\n[Security] Shell execution proposed: "${commandStr}"`);
          const answer = await rl.question("Authorize this bash command? (y/n): ");
          const normalized = answer.trim().toLowerCase();

          if (normalized === "y" || normalized === "yes") {
            return { decision: "allow" };
          }
          return {
            decision: "deny",
            reason: `User denied authorization to execute: ${commandStr}`,
          };
        }

        // Allow non-bash tools by default
        return { decision: "allow" };
      },
    },
  });

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║               Hernex Agent Core — Interactive Example            ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log(`Working Directory: ${workingDirectory}`);
  console.log(`Active Model:      ${activeModel} (Preset 1: ${modelPresets["1"].displayName})`);
  console.log(`Reasoning Effort:  ${activeReasoningEffort}`);
  console.log(`Active Tools:      ${tools.list().map((t) => t.name).join(", ")}`);
  console.log("\nQuick Model Switching:");
  console.log(`  .model 1          - ${modelPresets["1"].displayName} (${modelPresets["1"].modelString}) [Env: ${modelPresets["1"].envVar}]`);
  console.log(`  .model 2          - ${modelPresets["2"].displayName} (${modelPresets["2"].modelString}) [Env: ${modelPresets["2"].envVar}]`);
  console.log("  .model <id>       - Custom model string (e.g. .model openai/gpt-4o)");
  console.log("\nOther Commands:");
  console.log("  .effort <level>   - Change reasoning effort (none, low, medium, high, max)");
  console.log("  .status           - Display current configuration");
  console.log("  .help             - Display this help message");
  console.log("  .exit / .quit     - Exit terminal session\n");

  try {
    while (true) {
      const line = await rl.question("\nagent> ");
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      if (
        trimmed === ".exit" ||
        trimmed === ".quit" ||
        trimmed.toLowerCase() === "exit" ||
        trimmed.toLowerCase() === "quit"
      ) {
        console.log("Goodbye!");
        break;
      }

      if (trimmed === ".help") {
        console.log("\nCommands:");
        console.log(`  .model 1          - Switch to ${modelPresets["1"].displayName} (uses ${modelPresets["1"].envVar})`);
        console.log(`  .model 2          - Switch to ${modelPresets["2"].displayName} (uses ${modelPresets["2"].envVar})`);
        console.log("  .model <id>       - Switch to custom model (e.g. .model openai/gpt-4o)");
        console.log("  .effort <level>   - Change effort: " + validReasoningLevels.join(", "));
        console.log("  .status           - Show current session settings");
        console.log("  .exit / .quit     - Exit REPL");
        continue;
      }

      if (trimmed === ".status") {
        const creds = resolveCredentialsForModel(activeModel);
        const hasKey = Boolean(creds.apiKey && creds.apiKey.length > 0);
        console.log(`\nModel:            ${activeModel}`);
        console.log(`API Key Status:   ${hasKey ? "✓ Present" : `✗ Missing (${creds.envVarName ?? "API Key"})`}`);
        console.log(`Reasoning Effort: ${activeReasoningEffort}`);
        console.log(`Current Turn:     ${engine.currentTurn}`);
        console.log(`Messages Count:   ${engine.messages.length}`);
        console.log(`Registered Tools: ${tools.list().map((t) => t.name).join(", ")}`);
        continue;
      }

      if (trimmed.startsWith(".model")) {
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2 || !parts[1]) {
          console.log("Usage:\n  .model 1  -> gemini-flash-lite-latest\n  .model 2  -> openrouter/openrouter/free\n  .model <custom>");
          continue;
        }

        const choice = parts[1].trim();
        if (choice === "1" || choice === "gemini-flash-lite-latest") {
          activeModel = modelPresets["1"].modelString;
          console.log(`✓ Active model set to [1]: gemini-flash-lite-latest (${activeModel})`);
          continue;
        }

        if (choice === "2" || choice === "openrouter/openrouter/free") {
          activeModel = modelPresets["2"].modelString;
          console.log("✓ Active model set to [2]: openrouter/openrouter/free");
          continue;
        }

        activeModel = choice;
        console.log(`✓ Active model switched to: ${activeModel}`);
        continue;
      }

      if (trimmed.startsWith(".effort")) {
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2 || !parts[1]) {
          console.log("Usage: .effort <level>\nAllowed levels: " + validReasoningLevels.join(", "));
          continue;
        }

        const candidate = parts[1].toLowerCase() as AgentReasoningLevel;
        if (!validReasoningLevels.includes(candidate)) {
          console.log(`Invalid effort level "${parts[1]}". Allowed: ${validReasoningLevels.join(", ")}`);
          continue;
        }

        activeReasoningEffort = candidate;
        console.log(`✓ Reasoning effort set to: ${activeReasoningEffort}`);
        continue;
      }

      const credentials = resolveCredentialsForModel(activeModel);

      if (!credentials.apiKey) {
        console.error(
          `❌ Cannot run turn: Missing API key. Please set ${credentials.envVarName ?? "API key"} in your environment.`,
        );
        continue;
      }

      console.log(`\n--- [Turn ${engine.currentTurn + 1} | Model: ${activeModel} | Effort: ${activeReasoningEffort}] ---`);

      try {
        const turnStream = engine.runTurn({
          userPrompt: trimmed,
          model: activeModel,
          apiKey: credentials.apiKey,
          baseUrl: credentials.baseUrl,
          reasoning: activeReasoningEffort,
        });

        for await (const event of turnStream) {
          switch (event.type) {
            case "tokenDelta":
              process.stdout.write(event.text);
              break;
            case "thoughtDelta":
              process.stdout.write(event.text);
              break;
            case "toolCallProposed":
              console.log(`\n[Tool Proposed: ${event.toolName}]`);
              break;
            case "toolExecutionStarted":
              console.log(`[Tool Executing: ${event.toolName}]`);
              break;
            case "toolExecutionDelta":
              process.stdout.write(event.chunk);
              break;
            case "toolExecutionFinished":
              console.log(
                `\n[Tool Finished: ${event.toolName}${event.isError ? " (Failed)" : " (Success)"}]`,
              );
              break;
            case "turnFinished":
              console.log(`\n[Turn Finished: ${event.finishReason}]`);
              break;
            case "error":
              console.error(`\n[Engine Error: ${event.origin}] ${event.error.message}`);
              break;
            default:
              break;
          }
        }
      } catch (error) {
        console.error(`\nFailed to complete turn: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    rl.close();
  }
}

// Execute REPL
main().catch((error) => {
  console.error("Fatal example error:", error);
  process.exit(1);
});
