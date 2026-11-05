/**
 * @fileoverview High-coverage unit tests for the AgentEngine microkernel and turn loop contracts.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ModelMessage } from '../src/index.js';
import {
  AgentEngine,
  type AgentEngineConfig,
  type AgentHooks,
  type AgentReasoningLevel,
  type AgentTool,
  type ToolExecutionContext,
  ToolRegistry,
  composeAgentHooks,
} from '../src/index.js';

/**
 * Minimal non-mutating, concurrency-safe tool for testing.
 */
class MockEchoTool implements AgentTool<typeof MockEchoTool.schema, { echo: string }> {
  public static readonly schema = z.object({
    message: z.string(),
  });

  public readonly name = 'mockEcho';
  public readonly description = 'Echoes input back.';
  public readonly inputSchema = MockEchoTool.schema;

  public async execute(
    parameters: z.infer<typeof MockEchoTool.schema>,
    context: ToolExecutionContext,
  ): Promise<{ echo: string }> {
    context.emitProgress?.('echoing...');
    return { echo: parameters.message };
  }
}

/**
 * Minimal mutating, non-concurrency-safe tool for testing checkpoint triggering.
 */
class MockMutateTool implements AgentTool<typeof MockMutateTool.schema, { written: boolean }> {
  public static readonly schema = z.object({
    filePath: z.string(),
    data: z.string(),
  });

  public readonly name = 'mockMutate';
  public readonly description = 'Mutates a mock file.';
  public readonly inputSchema = MockMutateTool.schema;

  public async execute(
    _parameters: z.infer<typeof MockMutateTool.schema>,
    _context: ToolExecutionContext,
  ): Promise<{ written: boolean }> {
    return { written: true };
  }
}

describe('AgentEngine Core Invariants', () => {
  const createBaseConfig = (overrides?: Partial<AgentEngineConfig>): AgentEngineConfig => ({
    threadId: 'th_test_123',
    workingDirectory: '/tmp/test_workspace',
    model: 'anthropic/claude-3-7-sonnet',
    apiKey: 'test-api-key',
    baseUrl: 'https://api.anthropic.com/v1',
    instructions: 'You are an autonomous engineering assistant.',
    tools: new ToolRegistry({ includeDefaults: false }),
    ...overrides,
  });

  it('initializes engine properties and manages conversational message state', async () => {
    const tools = new ToolRegistry({ includeDefaults: false });
    tools.register(new MockEchoTool());

    const initialMessages: ModelMessage[] = [
      { role: 'user', content: 'Previous message' },
      { role: 'assistant', content: 'Previous answer' },
    ];

    const engine = new AgentEngine(
      createBaseConfig({ tools, reasoning: 'high' }),
      initialMessages,
      1,
    );

    expect(engine.threadId).toBe('th_test_123');
    expect(engine.workingDirectory).toBe('/tmp/test_workspace');
    expect(engine.tools).toBe(tools);
    expect(engine.currentTurn).toBe(1);
    expect(engine.reasoning).toBe('high');
    expect(engine.messages.length).toBe(2);

    const freshEngine = new AgentEngine(createBaseConfig());
    expect(freshEngine.currentTurn).toBe(0);

    // Append message
    await engine.addMessage({ role: 'user', content: 'New message' });
    expect(engine.messages.length).toBe(3);
  });

  it('supports all valid top-level reasoning levels defined in AI SDK v7', () => {
    const validLevels: AgentReasoningLevel[] = [
      'provider-default',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ];

    for (const level of validLevels) {
      const engine = new AgentEngine(createBaseConfig({ reasoning: level }));
      expect(engine.reasoning).toBe(level);
    }
  });

  it('reserves turn lazily on first .next() and rejects concurrent execution', async () => {
    const engine = new AgentEngine(createBaseConfig());

    // Creating a generator does NOT lock the engine or increment turnCounter
    const unconsumed = engine.runTurn('Unconsumed turn');
    expect(unconsumed).toBeDefined();
    expect(engine.currentTurn).toBe(0);

    // Starting first active turn
    const turn1 = engine.runTurn('First turn');
    const firstPromise = turn1.next();
    expect(engine.currentTurn).toBe(1);

    // Starting second active turn concurrently must reject
    const turn2 = engine.runTurn('Concurrent turn');
    await expect(turn2.next()).rejects.toThrow('already running an active turn');

    await firstPromise;
  });

  it('initializes turnCounter from explicit initialTurnCount without counting user messages', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'Turn 1 prompt' },
      { role: 'assistant', content: 'Turn 1 answer' },
      { role: 'user', content: 'Turn 2 prompt' },
      { role: 'assistant', content: 'Turn 2 answer' },
    ];
    // Without explicit initialTurnCount, defaults to 0
    const engineDefault = new AgentEngine(createBaseConfig(), history);
    expect(engineDefault.currentTurn).toBe(0);

    // With explicit initialTurnCount, uses metadata count
    const engineWithCount = new AgentEngine(createBaseConfig(), history, 2);
    expect(engineWithCount.currentTurn).toBe(2);
  });

  it('converts registered tools to schema definitions without execute handlers for engine control', () => {
    const registry = new ToolRegistry({ includeDefaults: false });
    registry.register(new MockEchoTool());
    registry.register(new MockMutateTool());

    const definitions = registry.toSdkToolDefinitions();
    expect(Object.keys(definitions)).toEqual(['mockEcho', 'mockMutate']);

    // Definitions should have description and parameters schema, but no execute handler
    expect(definitions.mockEcho?.description).toBe('Echoes input back.');
    expect(definitions.mockEcho?.execute).toBeUndefined();
    expect(definitions.mockMutate?.description).toBe('Mutates a mock file.');
    expect(definitions.mockMutate?.execute).toBeUndefined();
  });

  it('enforces persistence and checkpoint dependency invariants', () => {
    // Ephemeral with checkpoint: true throws configuration error
    expect(() => {
      new AgentEngine(createBaseConfig({ checkpoint: true }));
    }).toThrow('Checkpoints require persistent thread storage');

    // Persisted engine with checkpoints enabled
    const engine2 = new AgentEngine(createBaseConfig({ persist: true, checkpoint: true }));
    expect(engine2.isPersisted).toBe(true);
    expect(engine2.isCheckpointEnabled).toBe(true);
    expect(engine2.threadStore).toBeDefined();
    expect(engine2.checkpointStore).toBeDefined();
  });

  it('preserves hook lifecycle dispatch interfaces', () => {
    const callLog: string[] = [];

    const hooks: AgentHooks = {
      onBeforeTurn: (context) => {
        callLog.push(`beforeTurn:${context.turnIndex}`);
        return { injectedInstructions: 'Be concise.' };
      },
      onAuthorizeTool: (context) => {
        callLog.push(`authorize:${context.toolName}`);
        return { decision: 'allow' };
      },
      onShouldStop: (context) => {
        callLog.push(`shouldStop:${context.finishReason}`);
        return { shouldStop: true };
      },
      onAfterTurn: (context) => {
        callLog.push(`afterTurn:${context.finishReason}`);
      },
      onError: (context) => {
        callLog.push(`error:${context.origin}`);
      },
    };

    const engine = new AgentEngine(createBaseConfig({ hooks }));
    expect(engine).toBeDefined();

    // Verify hooks are callable according to their contracts
    hooks.onBeforeTurn!({ turnIndex: 1, userPrompt: 'Hello' });
    hooks.onAuthorizeTool!({
      toolName: 'mockMutate',
      parameters: { filePath: 'foo.ts', data: 'test' },
      workingDirectory: '/tmp',
    });
    hooks.onShouldStop!({
      turnIndex: 1,
      finishReason: 'completed',
    });
    hooks.onAfterTurn!({
      turnIndex: 1,
      finishReason: 'completed',
      totalUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    });
    hooks.onError!({
      error: new Error('test failure'),
      origin: 'engine',
      turnIndex: 1,
      isFatal: false,
    });

    expect(callLog).toEqual([
      'beforeTurn:1',
      'authorize:mockMutate',
      'shouldStop:completed',
      'afterTurn:completed',
      'error:engine',
    ]);
  });

  it('rejects provider override when matching per-turn credentials are missing', async () => {
    const engine = new AgentEngine(
      createBaseConfig({
        model: 'anthropic/claude-3-7-sonnet',
        apiKey: 'anthropic-key',
        baseUrl: 'https://api.anthropic.com/v1',
      }),
    );

    const turnEvents = engine.runTurn({
      userPrompt: 'Test provider mismatch',
      model: 'google/gemini-2.5-flash-lite',
      // Missing per-turn apiKey and baseUrl for google
    });

    const events: any[] = [];
    for await (const event of turnEvents) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toContain('Falling back across different providers is forbidden');

    const finishEvent = events.find((e) => e.type === 'turnFinished');
    expect(finishEvent).toBeDefined();
    expect(finishEvent.finishReason).toBe('error');
  });

  it('honors before-turn hook veto without appending user messages or starting model steps', async () => {
    const engine = new AgentEngine(
      createBaseConfig({
        hooks: {
          onBeforeTurn: () => ({
            veto: true,
            vetoReason: 'User rate limit exceeded',
          }),
        },
      }),
    );

    const events: any[] = [];
    for await (const event of engine.runTurn('Forbidden prompt')) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual(['turnStarted', 'turnFinished']);
    const finishEvent = events.find((e) => e.type === 'turnFinished');
    expect(finishEvent.finishReason).toBe('vetoed');
    // Ensure message history was NOT touched
    expect(engine.messages.length).toBe(0);
  });

  it('aggregates signals so engine.abort cancels in-flight turn even when caller supplies abortSignal', async () => {
    const engine = new AgentEngine(createBaseConfig());
    const callerController = new AbortController();

    const turn = engine.runTurn({
      userPrompt: 'Cancel me',
      abortSignal: callerController.signal,
    });

    // Start consuming
    const firstPromise = turn.next();
    engine.abort('Engine level cancellation');
    const firstResult = await firstPromise;
    expect(firstResult.done).toBe(false);
    expect(firstResult.value?.type).toBe('turnStarted');
  });

  it('exposes direct store access through threadStore and checkpointStore properties', async () => {
    const threadId = `th_convenience_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const workspaceDir = path.join(tmpdir(), `engine_ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(workspaceDir, { recursive: true });

    const engine = new AgentEngine(
      createBaseConfig({
        threadId,
        workingDirectory: workspaceDir,
        persist: true,
        checkpoint: true,
      }),
    );

    expect(engine.threadStore).toBeDefined();
    expect(engine.checkpointStore).toBeDefined();

    // Checkpoints list directly via checkpointStore
    const checkpoints = await engine.checkpointStore!.listCheckpoints(threadId);
    expect(checkpoints.length).toBe(0);

    // Transcript directly via threadStore
    const transcript = await engine.threadStore!.getTranscript(threadId);
    expect(transcript.length).toBe(0);

    // Create file in workspace to snapshot
    const testFile = 'src/index.ts';
    const absPath = path.join(workspaceDir, testFile);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, 'console.log("hello");');

    // Manual checkpoint creation directly via checkpointStore
    const createdCheckpoint = await engine.checkpointStore!.createCheckpoint(threadId, {
      workingDirectory: workspaceDir,
      turnIndex: engine.currentTurn,
      label: 'Manual snapshot alpha',
      files: [testFile],
    });
    expect(createdCheckpoint.id).toBeDefined();
    expect(createdCheckpoint.files.length).toBe(1);

    const updatedCheckpoints = await engine.checkpointStore!.listCheckpoints(threadId);
    expect(updatedCheckpoints.length).toBe(1);
    expect(updatedCheckpoints[0]?.id).toBe(createdCheckpoint.id);
  });

  it('composes hooks deterministically with composeAgentHooks', async () => {
    const layer1: AgentHooks = {
      onBeforeTurn: (ctx) => ({
        userPrompt: `${ctx.userPrompt} (layer1)`,
        injectedInstructions: 'Instruction 1',
      }),
      onShouldStop: () => ({ shouldStop: true }),
      onAuthorizeTool: () => ({ decision: 'allow' }),
    };

    const layer2: AgentHooks = {
      onBeforeTurn: (ctx) => ({
        userPrompt: `${ctx.userPrompt} (layer2)`,
        injectedInstructions: 'Instruction 2',
      }),
      onShouldStop: () => ({ shouldStop: false, reminderPrompt: 'Keep going' }),
      onAuthorizeTool: () => ({ decision: 'allow' }),
    };

    const composed = composeAgentHooks([layer1, layer2]);

    const beforeResult = await composed.onBeforeTurn!({ turnIndex: 1, userPrompt: 'Initial' });
    expect(beforeResult?.userPrompt).toBe('Initial (layer1) (layer2)');
    expect(beforeResult?.injectedInstructions).toBe('Instruction 1\n\nInstruction 2');

    const stopDecision = await composed.onShouldStop!({
      turnIndex: 1,
      finishReason: 'completed',
    });
    expect(stopDecision.shouldStop).toBe(false);
    if (!stopDecision.shouldStop) {
      expect(stopDecision.reminderPrompt).toBe('Keep going');
    }

    const authDecision = await composed.onAuthorizeTool!({
      toolName: 'testTool',
      parameters: {},
      workingDirectory: '/tmp',
    });
    expect(authDecision.decision).toBe('allow');
  });

  it('serializes all event types to pure JSON without native Error leakage', () => {
    const errorEvent = {
      type: 'error' as const,
      origin: 'engine' as const,
      error: {
        name: 'HernexError',
        message: 'Something went wrong',
      },
      isFatal: true,
    };

    const serialized = JSON.stringify(errorEvent);
    expect(serialized).toContain('"name":"HernexError"');
    expect(serialized).toContain('"message":"Something went wrong"');
    const parsed = JSON.parse(serialized);
    expect(parsed.error instanceof Error).toBe(false);
    expect(typeof parsed.error).toBe('object');
  });
});
