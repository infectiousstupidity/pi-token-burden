import type { ParsedPrompt } from './types.js';
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

interface AtelierSidebarRowsInput {
  parsed: ParsedPrompt;
  contextWindow?: number;
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

const MAX_PANEL_ROWS = 8;
const MAX_SECTION_ROWS = MAX_PANEL_ROWS - 1;

/** Format a token count without locale- or terminal-dependent output. */
export function formatCompactTokens(tokens: number): string {
  const scales = [
    { minimum: 1_000_000_000, divisor: 1_000_000_000, suffix: 'b' },
    { minimum: 1_000_000, divisor: 1_000_000, suffix: 'm' },
    { minimum: 1_000, divisor: 1_000, suffix: 'k' },
  ];
  const scale = scales.find(({ minimum }) => Math.abs(tokens) >= minimum);
  if (!scale) {
    return String(tokens);
  }

  const roundScaled = (value: number): number => {
    const magnitude = Math.abs(value);
    const roundedMagnitude =
      magnitude < 100 ? Math.round(magnitude * 10) / 10 : Math.round(magnitude);
    return Math.sign(value) * roundedMagnitude;
  };
  const rounded = roundScaled(tokens / scale.divisor);
  const largerScale = scales.find(({ minimum }) => minimum === scale.minimum * 1_000);

  if (Math.abs(rounded) >= 1_000 && largerScale) {
    return `${String(roundScaled(tokens / largerScale.divisor))}${largerScale.suffix}`;
  }

  return `${String(rounded)}${scale.suffix}`;
}

/**
 * Some labels carry details in parentheses (Tool definitions inventory,
 * Context files filenames), which is too wide for the sidebar. The details
 * remain available in the /token-burden overlay, so the sidebar row uses
 * the short label.
 */
function sidebarSectionLabel(section: { label: string }): string {
  return section.label.replace(/\s*\(.*\)$/, '');
}

/** Build a compact read-only summary from top-level Budget Sections. */
export function buildAtelierSidebarRows({
  parsed,
  contextWindow,
}: AtelierSidebarRowsInput): AtelierSidebarRow[] {
  const formattedTotal = formatCompactTokens(parsed.totalTokens);
  const hasContextWindow =
    contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0;
  const totalText = hasContextWindow
    ? `${formattedTotal} / ${formatCompactTokens(contextWindow)} (${String(
        Math.round((parsed.totalTokens / contextWindow) * 1_000) / 10,
      )}%)`
    : `${formattedTotal} tokens`;

  const sortedSections = parsed.sections.toSorted((left, right) => right.tokens - left.tokens);
  const visibleSections =
    sortedSections.length <= MAX_SECTION_ROWS
      ? sortedSections
      : [
          ...sortedSections.slice(0, MAX_SECTION_ROWS - 1),
          {
            label: 'Other',
            tokens: sortedSections
              .slice(MAX_SECTION_ROWS - 1)
              .reduce((total, section) => total + section.tokens, 0),
          },
        ];

  return [
    { text: totalText, role: 'context' },
    ...visibleSections.map((section) => ({
      text: `${sidebarSectionLabel(section)} ${formatCompactTokens(section.tokens)}`,
    })),
  ];
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
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly events: EventBus,
    options: { onDiscover?(requestId: string): void | Promise<void> } = {},
  ) {
    this.unsubscribe = events.on(ATELIER_SIDEBAR_CHANNEL, (data) => {
      if (!isDiscoveryEvent(data)) {
        return;
      }

      const discovery = options.onDiscover?.(data.requestId);
      if (discovery instanceof Promise) {
        // Async discovery (e.g. deferred measurement): replay the panel
        // only after the callback settles.
        void this.replayAfterDiscovery(discovery, data.requestId);
      } else {
        this.emitRegister(data.requestId);
      }
    });
  }

  /** Replay the panel once an async discovery callback settles. */
  private async replayAfterDiscovery(discovery: Promise<void>, requestId: string): Promise<void> {
    try {
      await discovery;
    } catch {
      // Discovery measurement failed; no panel to replay. Swallowed
      // because console is disallowed by the project lint config.
      return;
    }
    this.emitRegister(requestId);
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
    this.disposed = true;
    this.unsubscribe();
  }

  private emitRegister(requestId?: string): void {
    if (this.disposed || this.currentPanel === null) {
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
