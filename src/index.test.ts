import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { fromPartial } from '@total-typescript/shoehorn';

import type { ParsedPrompt } from './types.js';

const ATELIER_SIDEBAR_CHANNEL = 'pi-atelier:sidebar-panels';

interface TestContext {
  getSystemPrompt(): string;
  getContextUsage(): { contextWindow?: number } | null;
  hasUI: boolean;
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

vi.mock('./measureTokenBudget.js', () => {
  evaluations.measureTokenBudget += 1;
  return { measureTokenBudget: mockMeasureTokenBudget };
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
}> {
  const bus = new FakeEventBus();
  const handlers = new Map<string, EventHandler>();
  let command: CommandHandler | undefined;
  const tools = [
    { name: 'read', description: 'Read files', parameters: {} },
    { name: 'bash', description: 'Run commands', parameters: {} },
  ];
  const pi = fromPartial<ExtensionAPI>({
    events: bus,
    on: vi.fn((event: string, handler: EventHandler) => handlers.set(event, handler)),
    registerCommand: vi.fn((name: string, options: { handler: CommandHandler }) => {
      if (name === 'token-burden') {
        command = options.handler;
      }
    }),
    getAllTools: vi.fn(() => tools),
    getActiveTools: vi.fn(() => ['read']),
  });

  const { default: extension } = await import('./index.js');
  await extension(pi);

  if (!command) {
    throw new Error('token-burden handler not registered');
  }

  return { bus, handlers, command, pi, tools };
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

  it('cancels a pending startup refresh when the first prompt is submitted', async () => {
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

    runEvent(
      handlers,
      'message_start',
      { type: 'message_start', message: { role: 'assistant' } },
      ctx,
    );
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

  it('uses assistant message_end as a fallback', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext();
    bus.discover();

    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'fallback prompt' },
      ctx,
    );
    runEvent(
      handlers,
      'message_end',
      { type: 'message_end', message: { role: 'assistant' } },
      ctx,
    );

    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(1);
    });
  });

  it('reuses the previous measurement when nothing changed', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext('same prompt');
    bus.discover();

    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'same prompt' },
      ctx,
    );
    runEvent(
      handlers,
      'message_start',
      { type: 'message_start', message: { role: 'assistant' } },
      ctx,
    );
    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(1);
    });
    mockMeasureTokenBudget.mockClear();

    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'same prompt' },
      ctx,
    );
    runEvent(
      handlers,
      'message_start',
      { type: 'message_start', message: { role: 'assistant' } },
      ctx,
    );
    await flushAsync();

    expect(mockMeasureTokenBudget).not.toHaveBeenCalled();
  });

  it('remeasures when the assembled prompt changes', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext();
    bus.discover();

    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'first prompt' },
      ctx,
    );
    runEvent(
      handlers,
      'message_start',
      { type: 'message_start', message: { role: 'assistant' } },
      ctx,
    );
    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(1);
    });
    mockMeasureTokenBudget.mockClear();

    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'second prompt' },
      ctx,
    );
    runEvent(
      handlers,
      'message_start',
      { type: 'message_start', message: { role: 'assistant' } },
      ctx,
    );
    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(1);
    });
  });

  it('remeasures the current prompt after model selection', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext('same prompt');
    bus.discover();

    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'same prompt' },
      ctx,
    );
    runEvent(
      handlers,
      'message_start',
      { type: 'message_start', message: { role: 'assistant' } },
      ctx,
    );
    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(1);
    });
    mockMeasureTokenBudget.mockClear();

    runEvent(handlers, 'model_select', { type: 'model_select' }, ctx);
    await vi.waitFor(() => {
      expect(mockMeasureTokenBudget).toHaveBeenCalledTimes(1);
    });
  });
});
