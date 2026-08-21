import { AtelierSidebar } from './atelier-sidebar.js';
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
});
