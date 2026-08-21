import { AtelierSidebar, buildAtelierSidebarRows, formatCompactTokens } from './atelier-sidebar.js';
import { isRecord } from './utils.js';

const ATELIER_SIDEBAR_CHANNEL = 'pi-atelier:sidebar-panels';

interface EmittedEvent {
  channel: string;
  data: unknown;
}

class FakeEventBus {
  readonly emitted: EmittedEvent[] = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    for (const handler of this.handlers.get(channel) ?? []) {
      handler(data);
    }
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    const channelHandlers = this.handlers.get(channel) ?? new Set();
    channelHandlers.add(handler);
    this.handlers.set(channel, channelHandlers);

    return () => {
      channelHandlers.delete(handler);
    };
  }

  send(data: unknown): void {
    for (const handler of this.handlers.get(ATELIER_SIDEBAR_CHANNEL) ?? []) {
      handler(data);
    }
  }
}

function eventData(bus: FakeEventBus): Array<Record<string, unknown>> {
  return bus.emitted.map(({ data }) => {
    if (!isRecord(data)) {
      throw new Error('Expected emitted event data to be an object');
    }
    return data;
  });
}

describe('Atelier sidebar row formatting', () => {
  it.each([
    [950, '950'],
    [1_200, '1.2k'],
    [12_400, '12.4k'],
    [131_000, '131k'],
  ])('formats %i tokens as %s', (tokens, formatted) => {
    expect(formatCompactTokens(tokens)).toBe(formatted);
  });

  it.each([
    [999_499, '999k'],
    [999_500, '1m'],
    [999_999, '1m'],
    [999_499_999, '999m'],
    [999_500_000, '1b'],
    [999_999_999, '1b'],
    [-999_499, '-999k'],
    [-999_500, '-1m'],
    [-999_999, '-1m'],
    [-999_499_999, '-999m'],
    [-999_500_000, '-1b'],
    [-999_999_999, '-1b'],
  ])('rolls %i tokens over at the rounded unit boundary as %s', (tokens, formatted) => {
    expect(formatCompactTokens(tokens)).toBe(formatted);
  });

  it('shows context-window usage when the window is known and positive', () => {
    const rows = buildAtelierSidebarRows({
      parsed: {
        sections: [{ label: 'Base prompt', chars: 20_000, tokens: 5_100 }],
        totalChars: 50_000,
        totalTokens: 12_400,
        skills: [],
      },
      contextWindow: 131_000,
    });

    expect(rows).toEqual([
      { text: '12.4k / 131k (9.5%)', role: 'context' },
      { text: 'Base prompt 5.1k' },
    ]);
  });

  it.each([undefined, 0])('shows total tokens when context window is %s', (contextWindow) => {
    const rows = buildAtelierSidebarRows({
      parsed: {
        sections: [],
        totalChars: 4_000,
        totalTokens: 950,
        skills: [],
      },
      contextWindow,
    });

    expect(rows).toEqual([{ text: '950 tokens', role: 'context' }]);
  });

  it('sorts top-level Budget Sections and combines overflow into Other', () => {
    const rows = buildAtelierSidebarRows({
      parsed: {
        sections: [
          { label: 'Metadata', chars: 1, tokens: 300 },
          { label: 'Base prompt', chars: 1, tokens: 5_100 },
          { label: 'Project instructions', chars: 1, tokens: 3_000 },
          { label: 'Skills', chars: 1, tokens: 2_100 },
          { label: 'Tool definitions', chars: 1, tokens: 1_900 },
          { label: 'System append', chars: 1, tokens: 600 },
          { label: 'Prompt overhead', chars: 1, tokens: 200 },
          { label: 'Extra context', chars: 1, tokens: 100 },
        ],
        totalChars: 1,
        totalTokens: 13_300,
        skills: [],
      },
    });

    expect(rows).toEqual([
      { text: '13.3k tokens', role: 'context' },
      { text: 'Base prompt 5.1k' },
      { text: 'Project instructions 3k' },
      { text: 'Skills 2.1k' },
      { text: 'Tool definitions 1.9k' },
      { text: 'System append 600' },
      { text: 'Metadata 300' },
      { text: 'Other 300' },
    ]);
  });
});

describe('Atelier sidebar publisher', () => {
  it('emits a valid register event on update', () => {
    const bus = new FakeEventBus();
    const publisher = new AtelierSidebar(bus);
    const rows = [{ text: '1.2k tokens', role: 'context' }, { text: 'Skills 200' }];

    publisher.update(rows);

    expect(bus.emitted).toEqual([
      {
        channel: ATELIER_SIDEBAR_CHANNEL,
        data: {
          version: 1,
          type: 'register',
          source: 'pi-token-burden',
          revision: 1,
          panel: {
            id: 'token-burden:budget',
            title: 'Token burden',
            rows,
          },
        },
      },
    ]);
    expect(publisher.panelId).toBe('token-burden:budget');
  });

  it('increments revision on subsequent updates', () => {
    const bus = new FakeEventBus();
    const publisher = new AtelierSidebar(bus);

    publisher.update([{ text: 'First' }]);
    publisher.update([{ text: 'Second' }]);

    expect(eventData(bus).map((event) => event.revision)).toEqual([1, 2]);
  });

  it('replays the current panel with the discovery request ID', () => {
    const bus = new FakeEventBus();
    const onDiscover = vi.fn<(requestId: string) => void>();
    const publisher = new AtelierSidebar(bus, { onDiscover });
    const rows = [{ text: 'Current total' }];
    publisher.update(rows);

    bus.send({ version: 1, type: 'discover', requestId: 'request-42' });

    expect(bus.emitted.at(-1)?.data).toEqual({
      version: 1,
      type: 'register',
      source: 'pi-token-burden',
      revision: 2,
      panel: {
        id: 'token-burden:budget',
        title: 'Token burden',
        rows,
      },
      requestId: 'request-42',
    });
    expect(onDiscover).toHaveBeenCalledWith('request-42');
  });

  it('replays the panel after an async discovery callback settles', async () => {
    const bus = new FakeEventBus();
    let resolveDiscovery: (() => void) | undefined;
    const discovery = new Promise<void>((resolve) => {
      resolveDiscovery = resolve;
    });
    const onDiscover = vi.fn(() => discovery);
    const publisher = new AtelierSidebar(bus, { onDiscover });
    publisher.update([{ text: 'Current total' }]);
    bus.emitted.length = 0;

    bus.send({ version: 1, type: 'discover', requestId: 'async-request' });
    expect(bus.emitted).toEqual([]);

    resolveDiscovery?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(onDiscover).toHaveBeenCalledOnce();
    expect(bus.emitted.at(-1)?.data).toEqual({
      version: 1,
      type: 'register',
      source: 'pi-token-burden',
      revision: 2,
      panel: {
        id: 'token-burden:budget',
        title: 'Token burden',
        rows: [{ text: 'Current total' }],
      },
      requestId: 'async-request',
    });
  });

  it('skips the replay when an async discovery callback rejects', async () => {
    const bus = new FakeEventBus();
    const onDiscover = vi.fn(() => Promise.reject(new Error('measurement failed')));
    const publisher = new AtelierSidebar(bus, { onDiscover });
    publisher.update([{ text: 'Current total' }]);
    bus.emitted.length = 0;

    bus.send({ version: 1, type: 'discover', requestId: 'failing-request' });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(onDiscover).toHaveBeenCalledOnce();
    expect(bus.emitted).toEqual([]);
  });

  it('signals discovery without emitting a panel before the first update', () => {
    const bus = new FakeEventBus();
    const onDiscover = vi.fn<(requestId: string) => void>();
    new AtelierSidebar(bus, { onDiscover });

    bus.send({ version: 1, type: 'discover', requestId: 'early-request' });

    expect(bus.emitted).toEqual([]);
    expect(onDiscover).toHaveBeenCalledWith('early-request');
  });

  it.each([
    null,
    [],
    {},
    { version: 2, type: 'discover', requestId: 'request' },
    { version: 1, type: 'register', requestId: 'request' },
    { version: 1, type: 'discover' },
    { version: 1, type: 'discover', requestId: 42 },
  ])('ignores malformed discovery payload %#', (payload) => {
    const bus = new FakeEventBus();
    const onDiscover = vi.fn<(requestId: string) => void>();
    const publisher = new AtelierSidebar(bus, { onDiscover });
    publisher.update([{ text: 'Current' }]);
    bus.emitted.length = 0;

    bus.send(payload);

    expect(bus.emitted).toEqual([]);
    expect(onDiscover).not.toHaveBeenCalled();
  });

  it('keeps revisions monotonic across updates and discovery replays', () => {
    const bus = new FakeEventBus();
    const publisher = new AtelierSidebar(bus);

    publisher.update([{ text: 'First' }]);
    bus.send({ version: 1, type: 'discover', requestId: 'one' });
    publisher.update([{ text: 'Second' }]);
    bus.send({ version: 1, type: 'discover', requestId: 'two' });

    expect(eventData(bus).map((event) => event.revision)).toEqual([1, 2, 3, 4]);
  });

  it('unregisters on clear and does not replay stale content', () => {
    const bus = new FakeEventBus();
    const publisher = new AtelierSidebar(bus);
    publisher.update([{ text: 'Current' }]);

    publisher.clear();
    bus.send({ version: 1, type: 'discover', requestId: 'after-clear' });

    expect(eventData(bus)).toEqual([
      expect.objectContaining({ type: 'register', revision: 1 }),
      {
        version: 1,
        type: 'unregister',
        source: 'pi-token-burden',
        revision: 2,
        id: 'token-burden:budget',
      },
    ]);
  });

  it('stops responding to discovery after disposal', () => {
    const bus = new FakeEventBus();
    const publisher = new AtelierSidebar(bus);
    publisher.update([{ text: 'Current' }]);
    publisher.dispose();
    bus.emitted.length = 0;

    bus.send({ version: 1, type: 'discover', requestId: 'after-dispose' });

    expect(bus.emitted).toEqual([]);
  });

  it('does not replay the panel after disposal during in-flight async discovery', async () => {
    const bus = new FakeEventBus();
    let resolveDiscovery: (() => void) | undefined;
    const discovery = new Promise<void>((resolve) => {
      resolveDiscovery = resolve;
    });
    const onDiscover = vi.fn(() => discovery);
    const publisher = new AtelierSidebar(bus, { onDiscover });
    publisher.update([{ text: 'Current total' }]);
    bus.emitted.length = 0;

    bus.send({ version: 1, type: 'discover', requestId: 'inflight-request' });
    publisher.dispose();

    resolveDiscovery?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(onDiscover).toHaveBeenCalledOnce();
    expect(bus.emitted).toEqual([]);
  });
});
