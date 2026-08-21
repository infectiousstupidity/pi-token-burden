import { isRecord } from './utils.js';

const ATELIER_SIDEBAR_CHANNEL = 'pi-atelier:sidebar-panels';
const ATELIER_SIDEBAR_PANEL_ID = 'token-burden:budget';
const VERSION = 1;
const SOURCE = 'pi-token-burden';
const PANEL_TITLE = 'Token burden';

interface AtelierSidebarRow {
  text: string;
  role?: string;
}

interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface CurrentPanel {
  id: typeof ATELIER_SIDEBAR_PANEL_ID;
  title: typeof PANEL_TITLE;
  rows: AtelierSidebarRow[];
}

interface RegisterEvent {
  version: typeof VERSION;
  type: 'register';
  source: typeof SOURCE;
  revision: number;
  panel: CurrentPanel;
  requestId?: string;
}

interface UnregisterEvent {
  version: typeof VERSION;
  type: 'unregister';
  source: typeof SOURCE;
  revision: number;
  id: typeof ATELIER_SIDEBAR_PANEL_ID;
}

function isDiscoveryEvent(value: unknown): value is {
  version: typeof VERSION;
  type: 'discover';
  requestId: string;
} {
  return (
    isRecord(value) &&
    value.version === VERSION &&
    value.type === 'discover' &&
    typeof value.requestId === 'string'
  );
}

export class AtelierSidebar {
  readonly panelId = ATELIER_SIDEBAR_PANEL_ID;
  private currentPanel: CurrentPanel | null = null;
  private revision = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly events: EventBus,
    options: { onDiscover?(requestId: string): void } = {},
  ) {
    this.unsubscribe = events.on(ATELIER_SIDEBAR_CHANNEL, (data) => {
      if (!isDiscoveryEvent(data)) {
        return;
      }

      options.onDiscover?.(data.requestId);
      this.emitRegister(data.requestId);
    });
  }

  update(rows: readonly AtelierSidebarRow[]): void {
    this.currentPanel = {
      id: ATELIER_SIDEBAR_PANEL_ID,
      title: PANEL_TITLE,
      rows: rows.map((row) => ({ ...row })),
    };
    this.emitRegister();
  }

  clear(): void {
    if (this.currentPanel === null) {
      return;
    }

    this.currentPanel = null;
    const event: UnregisterEvent = {
      version: VERSION,
      type: 'unregister',
      source: SOURCE,
      revision: this.nextRevision(),
      id: ATELIER_SIDEBAR_PANEL_ID,
    };
    this.events.emit(ATELIER_SIDEBAR_CHANNEL, event);
  }

  dispose(): void {
    this.unsubscribe();
  }

  private emitRegister(requestId?: string): void {
    if (this.currentPanel === null) {
      return;
    }

    const event: RegisterEvent = {
      version: VERSION,
      type: 'register',
      source: SOURCE,
      revision: this.nextRevision(),
      panel: this.currentPanel,
      ...(requestId === undefined ? {} : { requestId }),
    };
    this.events.emit(ATELIER_SIDEBAR_CHANNEL, event);
  }

  private nextRevision(): number {
    if (this.revision === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Atelier sidebar revision exhausted');
    }

    this.revision += 1;
    return this.revision;
  }
}
