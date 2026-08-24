import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { fromPartial } from '@total-typescript/shoehorn';

import type { ParsedPrompt } from './types.js';

const ATELIER_SIDEBAR_CHANNEL = 'pi-atelier:sidebar-panels';

interface TestContext {
  getSystemPrompt(): string;
  getContextUsage(): { contextWindow?: number } | null;
  hasUI: boolean;
  isIdle(): boolean;
  model?: { api?: string; provider?: string; contextWindow?: number };
}

type CommandHandler = (args: string, ctx: TestContext) => Promise<void>;
type EventHandler = (event: Record<string, unknown>, ctx: TestContext) => void | Promise<void>;

interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

interface MeasureTokenBudgetModule {
  buildSidebarMeasurementKey(input: {
    prompt: string;
    allTools: ToolDefinition[];
    activeToolNames: string[];
    modelApi?: string;
    modelProvider?: string;
    details?: boolean;
  }): string;
  measureTokenBudget(input: {
    prompt: string;
    allTools: ToolDefinition[];
    activeToolNames: string[];
    modelApi?: string;
    modelProvider?: string;
    details?: boolean;
  }): ParsedPrompt;
}

const { evaluations, mockRunTokenBurden, mockMeasureTokenBudget } = vi.hoisted(() => ({
  evaluations: { runTokenBurden: 0, measureTokenBudget: 0 },
  mockRunTokenBurden: vi.fn(async (): Promise<void> => undefined),
  mockMeasureTokenBudget: vi.fn<MeasureTokenBudgetModule['measureTokenBudget']>(),
}));

vi.mock('./runTokenBurden.js', () => {
  evaluations.runTokenBurden += 1;
  return { runTokenBurden: mockRunTokenBurden };
});

vi.mock('./measureTokenBudget.js', async (importOriginal) => {
  evaluations.measureTokenBudget += 1;
  const original = await importOriginal<MeasureTokenBudgetModule>();
  return { ...original, measureTokenBudget: mockMeasureTokenBudget };
});

class FakeEventBus implements EventBus {
  readonly emitted: Array<{ channel: string; data: unknown }> = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    for (const handler of this.handlers.get(channel) ?? []) {
      handler(data);
    }
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }

  discover(requestId = 'request-1'): void {
    for (const handler of this.handlers.get(ATELIER_SIDEBAR_CHANNEL) ?? []) {
      handler({ version: 1, type: 'discover', requestId });
    }
  }
}

function createContext(prompt = 'session prompt'): TestContext {
  return {
    getSystemPrompt: vi.fn(() => prompt),
    getContextUsage: vi.fn(() => ({ contextWindow: 10_000 })),
    hasUI: false,
    isIdle: vi.fn(() => true),
    model: {
      api: 'anthropic-messages',
      provider: 'openrouter',
      contextWindow: 8_000,
    },
  };
}

async function setupExtension(): Promise<{
  bus: FakeEventBus;
  handlers: Map<string, EventHandler>;
  command: CommandHandler;
  pi: ExtensionAPI;
  tools: ToolDefinition[];
  activeToolNames: string[];
}> {
  const bus = new FakeEventBus();
  const handlers = new Map<string, EventHandler>();
  let command: CommandHandler | undefined;
  const tools = [
    { name: 'read', description: 'Read files', parameters: {} },
    { name: 'bash', description: 'Run commands', parameters: {} },
  ];
  const activeToolNames = ['read'];
  const pi = fromPartial<ExtensionAPI>({
    events: bus,
    on: vi.fn((event: string, handler: EventHandler) => handlers.set(event, handler)),
    registerCommand: vi.fn((name: string, options: { handler: CommandHandler }) => {
      if (name === 'token-burden') {
        command = options.handler;
      }
    }),
    getAllTools: vi.fn(() => tools),
    getActiveTools: vi.fn(() => activeToolNames),
  });

  const { default: extension } = await import('./index.js');
  await extension(pi);

  if (!command) {
    throw new Error('token-burden handler not registered');
  }

  return { bus, handlers, command, pi, tools, activeToolNames };
}

function getEventHandler(handlers: Map<string, EventHandler>, eventName: string): EventHandler {
  const handler = handlers.get(eventName);
  if (!handler) {
    throw new Error(`${eventName} handler not registered`);
  }
  return handler;
}

function runEvent(
  handlers: Map<string, EventHandler>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: TestContext,
): void {
  void getEventHandler(handlers, eventName)(event, ctx);
}

function runOptionalEvent(
  handlers: Map<string, EventHandler>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: TestContext,
): void {
  void handlers.get(eventName)?.(event, ctx);
}

async function measureSettledPrompt(
  handlers: Map<string, EventHandler>,
  ctx: TestContext,
  prompt: string,
  expectedCalls: number,
): Promise<void> {
  runEvent(
    handlers,
    'before_agent_start',
    { type: 'before_agent_start', systemPrompt: prompt },
    ctx,
  );
  runEvent(handlers, 'agent_settled', { type: 'agent_settled' }, ctx);
  await flushAsync();
  expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(expectedCalls);
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

const measured: ParsedPrompt = {
  sections: [{ label: 'Base prompt', chars: 24, tokens: 6 }],
  totalChars: 24,
  totalTokens: 6,
  skills: [],
};

beforeEach(() => {
  vi.resetModules();
  evaluations.runTokenBurden = 0;
  evaluations.measureTokenBudget = 0;
  mockRunTokenBurden.mockReset();
  mockMeasureTokenBudget.mockReset();
  mockMeasureTokenBudget.mockReturnValue(measured);
});

afterEach(async () => {
  await flushAsync();
});

describe('token-burden extension entrypoint', () => {
  it('registers /token-burden without evaluating the heavy modules', async () => {
    let handler: CommandHandler | null = null;
    const pi = fromPartial<ExtensionAPI>({
      events: new FakeEventBus(),
      on: vi.fn(),
      registerCommand: vi.fn(
        (name: string, { handler: registeredHandler }: { handler: CommandHandler }) => {
          expect(name).toBe('token-burden');
          handler = registeredHandler;
        },
      ),
    });

    const { default: extension } = await import('./index.js');
    await extension(pi);

    expect(handler).toBeTypeOf('function');
    expect(evaluations.runTokenBurden).toBe(0);
    expect(evaluations.measureTokenBudget).toBe(0);
  });

  it('loads the command module only when /token-burden is used', async () => {
    const { command, pi } = await setupExtension();
    const ctx = createContext('command prompt');

    await command('first', ctx);
    await command('second', ctx);

    expect(evaluations.runTokenBurden).toBe(1);
    expect(mockRunTokenBurden).toHaveBeenCalledTimes(2);
    expect(mockRunTokenBurden).toHaveBeenLastCalledWith(pi, 'second', ctx);
  });

  it('advertises the Atelier panel without measuring when there is no session yet', async () => {
    const { bus } = await setupExtension();

    bus.discover('structural-discovery');
    await flushAsync();

    expect(mockMeasureTokenBudget).not.toHaveBeenCalled();
    expect(evaluations.measureTokenBudget).toBe(0);
    expect(bus.emitted.at(-1)?.data).toMatchObject({
      type: 'register',
      requestId: 'structural-discovery',
      panel: {
        id: 'token-burden:budget',
        rows: [{ text: 'Measuring…', role: 'context' }],
      },
    });
  });
});

describe('Atelier sidebar lifecycle', () => {
  it('captures a prompt before discovery and measures it only after discovery while settled', async () => {
    const { bus, handlers, tools } = await setupExtension();
    const ctx = createContext('base chat prompt');

    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'captured before discovery' },
      ctx,
    );
    runEvent(handlers, 'agent_settled', { type: 'agent_settled' }, ctx);

    expect(mockMeasureTokenBudget).not.toHaveBeenCalled();
    expect(evaluations.measureTokenBudget).toBe(0);

    bus.discover();
    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(1);
    });
    expect(mockMeasureTokenBudget).toHaveBeenCalledWith({
      prompt: 'captured before discovery',
      allTools: tools,
      activeToolNames: ['read'],
      modelApi: 'anthropic-messages',
      modelProvider: 'openrouter',
      details: false,
    });
  });

  it('measures the base chat after discovery and session start', async () => {
    const { bus, handlers, tools } = await setupExtension();
    const ctx = createContext('base chat prompt');

    bus.discover();
    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);

    expect(mockMeasureTokenBudget).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(1);
    });

    expect(mockMeasureTokenBudget).toHaveBeenCalledWith({
      prompt: 'base chat prompt',
      allTools: tools,
      activeToolNames: ['read'],
      modelApi: 'anthropic-messages',
      modelProvider: 'openrouter',
      details: false,
    });
  });

  it('also measures when discovery happens after session start', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext('base chat prompt');

    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);
    bus.discover();

    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(1);
    });
  });

  it('defers the exact assembled prompt until the agent settles', async () => {
    const { bus, handlers, tools } = await setupExtension();
    const ctx = createContext('base chat prompt');

    bus.discover();
    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);

    const result = getEventHandler(handlers, 'before_agent_start')(
      { type: 'before_agent_start', systemPrompt: 'exact assembled prompt' },
      ctx,
    );

    expect(result).toBeUndefined();
    await flushAsync();
    expect(mockMeasureTokenBudget).not.toHaveBeenCalled();
    expect(evaluations.measureTokenBudget).toBe(0);

    runOptionalEvent(
      handlers,
      'message_start',
      { type: 'message_start', message: { role: 'assistant' } },
      ctx,
    );
    runOptionalEvent(
      handlers,
      'message_end',
      { type: 'message_end', message: { role: 'assistant' } },
      ctx,
    );
    await flushAsync();
    expect(mockMeasureTokenBudget).not.toHaveBeenCalled();
    expect(evaluations.measureTokenBudget).toBe(0);

    runEvent(handlers, 'agent_settled', { type: 'agent_settled' }, ctx);
    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(1);
    });

    expect(mockMeasureTokenBudget).toHaveBeenCalledWith({
      prompt: 'exact assembled prompt',
      allTools: tools,
      activeToolNames: ['read'],
      modelApi: 'anthropic-messages',
      modelProvider: 'openrouter',
      details: false,
    });
  });

  it('does not start measurement when settled fires before the context reports idle', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext();
    const isIdle = vi.mocked(ctx.isIdle);
    bus.discover();

    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'active prompt' },
      ctx,
    );
    isIdle.mockReturnValue(false);
    runEvent(handlers, 'agent_settled', { type: 'agent_settled' }, ctx);
    await flushAsync();

    expect(mockMeasureTokenBudget).not.toHaveBeenCalled();
    expect(evaluations.measureTokenBudget).toBe(0);
  });

  it('coalesces repeated runs to the latest prompt before settling', async () => {
    const { bus, handlers, tools } = await setupExtension();
    const ctx = createContext();
    bus.discover();

    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'stale prompt' },
      ctx,
    );
    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'latest prompt' },
      ctx,
    );
    runOptionalEvent(
      handlers,
      'message_end',
      { type: 'message_end', message: { role: 'assistant' } },
      ctx,
    );
    await flushAsync();

    expect(mockMeasureTokenBudget).not.toHaveBeenCalled();
    expect(evaluations.measureTokenBudget).toBe(0);

    runEvent(handlers, 'agent_settled', { type: 'agent_settled' }, ctx);
    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(1);
    });
    expect(mockMeasureTokenBudget).toHaveBeenCalledWith({
      prompt: 'latest prompt',
      allTools: tools,
      activeToolNames: ['read'],
      modelApi: 'anthropic-messages',
      modelProvider: 'openrouter',
      details: false,
    });
  });

  it('reuses the previous measurement with the same schema object', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext('same prompt');
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
  });

  it('reuses the previous measurement with a reconstructed equivalent schema', async () => {
    const { bus, handlers, tools } = await setupExtension();
    const ctx = createContext();
    tools[0] = {
      name: 'read',
      description: 'Read files',
      parameters: { required: ['path'], properties: { path: { type: 'string' } } },
    };
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
    tools[0] = {
      name: 'read',
      description: 'Read files',
      parameters: { properties: { path: { type: 'string' } }, required: ['path'] },
    };
    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
  });

  it('remeasures when the cached schema object is mutated in place', async () => {
    const { bus, handlers, tools } = await setupExtension();
    const ctx = createContext();
    const parameters = { properties: { path: { type: 'string' } } };
    tools[0] = { name: 'read', description: 'Read files', parameters };
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
    parameters.properties.path.type = 'number';
    await measureSettledPrompt(handlers, ctx, 'same prompt', 2);
  });

  it('reuses the previous measurement when active tool names are reordered', async () => {
    const { activeToolNames, bus, handlers } = await setupExtension();
    const ctx = createContext();
    activeToolNames.push('bash');
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
    activeToolNames.reverse();
    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
  });

  it('remeasures when active tool membership changes', async () => {
    const { activeToolNames, bus, handlers } = await setupExtension();
    const ctx = createContext();
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
    activeToolNames.push('bash');
    await measureSettledPrompt(handlers, ctx, 'same prompt', 2);
  });

  it('remeasures when an active tool description changes', async () => {
    const { bus, handlers, tools } = await setupExtension();
    const ctx = createContext();
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
    tools[0] = { name: 'read', description: 'Read file contents', parameters: {} };
    await measureSettledPrompt(handlers, ctx, 'same prompt', 2);
  });

  it('remeasures when active tool parameters change', async () => {
    const { bus, handlers, tools } = await setupExtension();
    const ctx = createContext();
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
    tools[0] = { name: 'read', description: 'Read files', parameters: { type: 'object' } };
    await measureSettledPrompt(handlers, ctx, 'same prompt', 2);
  });

  it('ignores changes to inactive tool schemas', async () => {
    const { bus, handlers, tools } = await setupExtension();
    const ctx = createContext();
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
    tools[1] = {
      name: 'bash',
      description: 'Execute shell commands',
      parameters: { type: 'object' },
    };
    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
  });

  it('remeasures when the tool inventory changes between empty and nonempty', async () => {
    const { bus, handlers, tools } = await setupExtension();
    const ctx = createContext();
    tools.splice(0);
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
    tools.push({ name: 'bash', description: 'Run commands', parameters: {} });
    await measureSettledPrompt(handlers, ctx, 'same prompt', 2);
  });

  it('remeasures when the effective provider envelope changes', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext();
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
    if (ctx.model) {
      ctx.model.api = 'openai-responses';
    }
    await measureSettledPrompt(handlers, ctx, 'same prompt', 2);
  });

  it('remeasures when the assembled prompt changes', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext();
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'first prompt', 1);
    await measureSettledPrompt(handlers, ctx, 'second prompt', 2);
  });

  it('remeasures the current prompt after selecting a different model envelope', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext('same prompt');
    bus.discover();

    await measureSettledPrompt(handlers, ctx, 'same prompt', 1);
    if (ctx.model) {
      ctx.model.api = 'openai-responses';
    }
    runEvent(handlers, 'model_select', { type: 'model_select' }, ctx);
    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(2);
    });
  });
});
