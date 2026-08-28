import type { ParsedPrompt } from './types.js';
import { isRecord } from './utils.js';

export const WORKBENCH_CONTRIBUTION_CHANNEL = 'herdr-pi-workbench:contributions';
export const WORKBENCH_CONTRIBUTION_VERSION = 1;
const SOURCE = 'pi-token-burden';
const KIND = 'context-burden';

interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface DiscoveryEvent {
  version: typeof WORKBENCH_CONTRIBUTION_VERSION;
  type: 'discover';
  source: string;
  sessionId: string;
  requestId: string;
  kinds?: string[];
}

export interface WorkbenchBurdenInput {
  sessionId: string;
  parsed: ParsedPrompt;
  contextWindow?: number;
  activeTools?: number;
  totalTools?: number;
  modelApi?: string;
  modelProvider?: string;
}

function isDiscoveryEvent(value: unknown): value is DiscoveryEvent {
  return (
    isRecord(value) &&
    value.version === WORKBENCH_CONTRIBUTION_VERSION &&
    value.type === 'discover' &&
    typeof value.sessionId === 'string' &&
    typeof value.requestId === 'string' &&
    (!Array.isArray(value.kinds) || value.kinds.includes(KIND))
  );
}

function stableSectionId(label: string): string {
  const slug = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'section';
}

export class WorkbenchContributionPublisher {
  private revision = 0;
  private current: WorkbenchBurdenInput | undefined;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly events: EventBus,
    options: { onDiscover?(event: DiscoveryEvent): void | Promise<void> } = {},
  ) {
    this.unsubscribe = events.on(WORKBENCH_CONTRIBUTION_CHANNEL, (data) => {
      if (!isDiscoveryEvent(data)) return;
      const result = options.onDiscover?.(data);
      if (result instanceof Promise) {
        void result.then(() => this.replay(data.sessionId)).catch(() => undefined);
      } else {
        this.replay(data.sessionId);
      }
    });
  }

  update(input: WorkbenchBurdenInput): void {
    this.current = input;
    this.emitUpdate(input);
  }

  clear(): void {
    const current = this.current;
    this.current = undefined;
    if (!current || this.disposed) return;
    this.events.emit(WORKBENCH_CONTRIBUTION_CHANNEL, {
      version: WORKBENCH_CONTRIBUTION_VERSION,
      type: 'unregister',
      source: SOURCE,
      kind: KIND,
      sessionId: current.sessionId,
      revision: this.nextRevision(),
    });
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
    this.unsubscribe();
  }

  private replay(sessionId: string): void {
    if (this.disposed || !this.current || this.current.sessionId !== sessionId) return;
    this.emitUpdate(this.current);
  }

  private emitUpdate(input: WorkbenchBurdenInput): void {
    if (this.disposed) return;
    const sections = input.parsed.sections.map((section, index) => ({
      id: `${stableSectionId(section.label)}-${String(index + 1)}`,
      label: section.label,
      tokens: section.tokens,
    }));
    this.events.emit(WORKBENCH_CONTRIBUTION_CHANNEL, {
      version: WORKBENCH_CONTRIBUTION_VERSION,
      type: 'update',
      source: SOURCE,
      kind: KIND,
      sessionId: input.sessionId,
      revision: this.nextRevision(),
      measuredAt: Date.now(),
      totalTokens: input.parsed.totalTokens,
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      sections,
      ...(input.activeTools !== undefined || input.totalTools !== undefined
        ? {
            tools: {
              ...(input.activeTools !== undefined ? { active: input.activeTools } : {}),
              ...(input.totalTools !== undefined ? { total: input.totalTools } : {}),
            },
          }
        : {}),
      measurement: {
        method: 'tokenizer-or-estimate',
        ...(input.modelApi ? { modelApi: input.modelApi } : {}),
        ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      },
    });
  }

  private nextRevision(): number {
    if (this.revision === Number.MAX_SAFE_INTEGER) throw new RangeError('Workbench contribution revision exhausted');
    this.revision += 1;
    return this.revision;
  }
}
