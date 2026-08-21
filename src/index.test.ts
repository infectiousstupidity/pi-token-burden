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
type EventHandler = (event: Record<string, unknown>, ctx: TestContext) => void;

interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface MeasureTokenBudgetInput {
  prompt: string;
  allTools: unknown[];
  activeToolNames: string[];
  modelApi?: string;
  modelProvider?: string;
}

interface MeasureTokenBudgetModule {
  measureTokenBudget(input: MeasureTokenBudgetInput): ParsedPrompt;
}

interface ReportViewModule {
  showReport(...args: unknown[]): Promise<void>;
}

const MEASURE_TOKEN_BUDGET_MOCK = vi.fn<MeasureTokenBudgetModule['measureTokenBudget']>();
const SHOW_REPORT_MOCK = vi.fn<ReportViewModule['showReport']>();

vi.mock<MeasureTokenBudgetModule>(import('./measureTokenBudget.js'), () => ({
  measureTokenBudget: MEASURE_TOKEN_BUDGET_MOCK,
}));

vi.mock<ReportViewModule>(import('./report-view.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  showReport: SHOW_REPORT_MOCK,
}));

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
  tools: unknown[];
}> {
  const bus = new FakeEventBus();
  const handlers = new Map<string, EventHandler>();
  let command: CommandHandler | undefined;
  const tools = [
    { name: 'read', description: 'Read files', parameters: {} },
    { name: 'bash', description: 'Run commands', parameters: {} },
  ];
  const pi = {
    events: bus,
    on: vi.fn((event: string, handler: EventHandler) => handlers.set(event, handler)),
    registerCommand: vi.fn((name: string, options: { handler: CommandHandler }) => {
      if (name === 'token-burden') {
        command = options.handler;
      }
    }),
    getAllTools: vi.fn(() => tools),
    getActiveTools: vi.fn(() => ['read']),
  };

  const { default: extension } = await import('./index.js');
  await extension(fromPartial(pi));

  if (!command) {
    throw new Error('token-burden handler not registered');
  }

  return { bus, handlers, command, tools };
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
  handler(event, ctx);
}

const measured: ParsedPrompt = {
  sections: [{ label: 'Base prompt', chars: 24, tokens: 6 }],
  totalChars: 24,
  totalTokens: 6,
  skills: [],
};

describe('extension', () => {
  beforeEach(() => {
    MEASURE_TOKEN_BUDGET_MOCK.mockReset();
    MEASURE_TOKEN_BUDGET_MOCK.mockReturnValue(measured);
    SHOW_REPORT_MOCK.mockReset();
  });

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

    expect(MEASURE_TOKEN_BUDGET_MOCK).not.toHaveBeenCalled();
  });

  it('publishes the current session on discovery', async () => {
    const { bus, handlers, tools } = await setupExtension();
    const ctx = createContext('current prompt');
    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);

    bus.discover('discover-current');

    expect(MEASURE_TOKEN_BUDGET_MOCK).toHaveBeenCalledWith({
      prompt: 'current prompt',
      allTools: tools,
      activeToolNames: ['read'],
      modelApi: 'anthropic-messages',
      modelProvider: 'openrouter',
    });
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
    const { bus, handlers } = await setupExtension();
    const ctx = createContext('late session');

    bus.discover('before-session');
    expect(MEASURE_TOKEN_BUDGET_MOCK).not.toHaveBeenCalled();

    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);

    expect(MEASURE_TOKEN_BUDGET_MOCK).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'late session' }),
    );
    expect(bus.emitted).toHaveLength(1);
  });

  it('refreshes before agent start from the exact event system prompt', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext('stale prompt');
    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);
    bus.discover();
    MEASURE_TOKEN_BUDGET_MOCK.mockClear();

    runEvent(
      handlers,
      'before_agent_start',
      { type: 'before_agent_start', systemPrompt: 'exact assembled prompt' },
      ctx,
    );

    expect(MEASURE_TOKEN_BUDGET_MOCK).toHaveBeenCalledOnce();
    expect(MEASURE_TOKEN_BUDGET_MOCK).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'exact assembled prompt' }),
    );
  });

  it('refreshes on model select only after Atelier discovery', async () => {
    const { bus, handlers } = await setupExtension();
    const ctx = createContext('model prompt');
    runEvent(handlers, 'session_start', { type: 'session_start' }, ctx);

    runEvent(handlers, 'model_select', { type: 'model_select' }, ctx);
    expect(MEASURE_TOKEN_BUDGET_MOCK).not.toHaveBeenCalled();

    bus.discover();
    MEASURE_TOKEN_BUDGET_MOCK.mockClear();
    runEvent(handlers, 'model_select', { type: 'model_select' }, ctx);

    expect(MEASURE_TOKEN_BUDGET_MOCK).toHaveBeenCalledOnce();
    expect(MEASURE_TOKEN_BUDGET_MOCK).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'model prompt' }),
    );
  });

  it('keeps the token-burden command independent of Atelier discovery', async () => {
    const { command, tools } = await setupExtension();
    const ctx = createContext('command prompt');

    await command('', ctx);

    expect(MEASURE_TOKEN_BUDGET_MOCK).toHaveBeenCalledWith({
      prompt: 'command prompt',
      allTools: tools,
      activeToolNames: ['read'],
      modelApi: 'anthropic-messages',
      modelProvider: 'openrouter',
    });
    expect(SHOW_REPORT_MOCK).not.toHaveBeenCalled();
  });

  it('still opens the full report overlay without Atelier discovery', async () => {
    const { command } = await setupExtension();
    const ctx = { ...createContext('overlay prompt'), hasUI: true };

    await command('', ctx);

    expect(SHOW_REPORT_MOCK).toHaveBeenCalledOnce();
    expect(SHOW_REPORT_MOCK).toHaveBeenCalledWith(
      measured,
      ctx,
      expect.objectContaining({ contextWindow: 10_000 }),
    );
  });
});
