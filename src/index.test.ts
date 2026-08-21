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

interface MeasureForContextModule {
  measureForContext(pi: ExtensionAPI, ctx: TestContext, prompt: string): ParsedPrompt;
}

// Module-evaluation sentinels: each mock factory body runs when the module
// is evaluated. A static import of either heavy module in index.ts would
// fire the corresponding sentinel during extension load, which the
// registration test below forbids.
const { evaluations, mockRunTokenBurden, mockMeasureForContext } = vi.hoisted(() => ({
  evaluations: { runTokenBurden: 0, measureTokenBudget: 0 },
  mockRunTokenBurden: vi.fn(async (): Promise<void> => undefined),
  mockMeasureForContext: vi.fn<MeasureForContextModule['measureForContext']>(),
}));

vi.mock('./runTokenBurden.js', () => {
  evaluations.runTokenBurden += 1;
  return { runTokenBurden: mockRunTokenBurden };
});

vi.mock('./measureTokenBudget.js', () => {
  evaluations.measureTokenBudget += 1;
  return { measureForContext: mockMeasureForContext };
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

  return { bus, handlers, command, pi };
}

function runEvent(
  handlers: Map<string, EventHandler>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: TestContext,
): void {
  const handler = handlers.get(eventName);
  if (!handler) {
    throw new Error(`${eventName} handler not registered`);
  }
  void handler(event, ctx);
}

/** Let deferred dynamic imports and async publishes settle. */
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
  // Fresh module registry per test so the evaluation sentinels measure only
  // this test's imports, keeping the assertions robust to test ordering.
  vi.resetModules();
  evaluations.runTokenBurden = 0;
  evaluations.measureTokenBudget = 0;
  mockRunTokenBurden.mockReset();
  mockMeasureForContext.mockReset();
  mockMeasureForContext.mockReturnValue(measured);
});

afterEach(async () => {
  // Settle any publish started by the previous test before its mocks reset.
  await flushAsync();
});

describe('token-burden extension entrypoint', () => {
  it('exports a default function', async () => {
    const mod = await import('./index.js');
    expectTypeOf(mod.default).toBeFunction();
  });

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

  it('loads the command module on first invocation and caches it on the second', async () => {
    const { command, pi } = await setupExtension();
    const ctx = createContext('command prompt');

    await command('first', ctx);

    expect(evaluations.runTokenBurden).toBe(1);
    expect(mockRunTokenBurden).toHaveBeenCalledTimes(1);
    expect(mockRunTokenBurden).toHaveBeenCalledWith(pi, 'first', ctx);

    // ES module cache: a second invocation in the same process reuses the
    // already-loaded command module.
    await command('second', ctx);

    expect(evaluations.runTokenBurden).toBe(1);
    expect(mockRunTokenBurden).toHaveBeenCalledTimes(2);
    expect(mockRunTokenBurden).toHaveBeenLastCalledWith(pi, 'second', ctx);
  });

  it('loads the measurement module on Atelier discovery and registers the panel', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext('discovery prompt');
    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);

    bus.discover('structural-discovery');
    // The first cold dynamic import can take more than one macrotask tick,
    // so poll for the settled end state instead of a fixed flush.
    await vi.waitFor(() => {
      expect(bus.emitted.at(-1)?.data).toMatchObject({
        type: 'register',
        requestId: 'structural-discovery',
      });
    });

    expect(evaluations.measureTokenBudget).toBe(1);
    const last = bus.emitted.at(-1);
    expect(last?.channel).toBe(ATELIER_SIDEBAR_CHANNEL);
    expect(last?.data).toMatchObject({
      type: 'register',
      requestId: 'structural-discovery',
    });
  });
});

describe('Atelier sidebar lifecycle', () => {
  it('does not measure lifecycle events before Atelier discovery', async () => {
    const { handlers } = await setupExtension();
    const ctx = createContext();

    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);
    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'exact prompt' },
      ctx,
    );
    runEvent(handlers, 'model_select', { type: 'model_select' }, ctx);
    await flushAsync();

    expect(mockMeasureForContext).not.toHaveBeenCalled();
  });

  it('publishes the current session on discovery', async () => {
    const { bus, handlers, pi } = await setupExtension();
    const ctx = createContext('current prompt');
    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);

    bus.discover('discover-current');
    await vi.waitFor(() => {
      expect(mockMeasureForContext).toHaveBeenCalledTimes(1);
    });

    expect(mockMeasureForContext).toHaveBeenCalledWith(pi, ctx, 'current prompt');
    expect(bus.emitted.at(-1)).toEqual({
      channel: ATELIER_SIDEBAR_CHANNEL,
      data: {
        version: 1,
        type: 'register',
        source: 'pi-token-burden',
        revision: 2,
        panel: {
          id: 'token-burden:budget',
          title: 'Token burden',
          rows: [{ text: '6 / 10k (0.1%)', role: 'context' }, { text: 'Base prompt 6' }],
        },
        requestId: 'discover-current',
      },
    });
  });

  it('publishes at session start when Atelier was discovered first', async () => {
    const { bus, handlers, pi } = await setupExtension();
    const ctx = createContext('late session');

    bus.discover('before-session');
    await flushAsync();
    expect(mockMeasureForContext).not.toHaveBeenCalled();

    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);
    await vi.waitFor(() => {
      expect(mockMeasureForContext).toHaveBeenCalledTimes(1);
    });

    expect(mockMeasureForContext).toHaveBeenCalledWith(pi, ctx, 'late session');
    expect(bus.emitted).toHaveLength(1);
  });

  it('refreshes before agent start from the exact event system prompt', async () => {
    const { bus, handlers, pi } = await setupExtension();
    const ctx = createContext('stale prompt');
    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);
    bus.discover();
    await vi.waitFor(() => {
      expect(mockMeasureForContext).toHaveBeenCalledTimes(1);
    });
    mockMeasureForContext.mockClear();

    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'exact assembled prompt' },
      ctx,
    );
    await vi.waitFor(() => {
      expect(mockMeasureForContext).toHaveBeenCalledTimes(1);
    });

    expect(mockMeasureForContext).toHaveBeenCalledOnce();
    expect(mockMeasureForContext).toHaveBeenCalledWith(pi, ctx, 'exact assembled prompt');
  });

  it('refreshes on model select only after Atelier discovery', async () => {
    const { bus, handlers, pi } = await setupExtension();
    const ctx = createContext('model prompt');
    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);

    runEvent(handlers, 'model_select', { type: 'model_select' }, ctx);
    await flushAsync();
    expect(mockMeasureForContext).not.toHaveBeenCalled();

    bus.discover();
    await vi.waitFor(() => {
      expect(mockMeasureForContext).toHaveBeenCalledTimes(1);
    });
    mockMeasureForContext.mockClear();
    runEvent(handlers, 'model_select', { type: 'model_select' }, ctx);
    await vi.waitFor(() => {
      expect(mockMeasureForContext).toHaveBeenCalledTimes(1);
    });

    expect(mockMeasureForContext).toHaveBeenCalledOnce();
    expect(mockMeasureForContext).toHaveBeenCalledWith(pi, ctx, 'model prompt');
  });
});
