import type { ExtensionContext, ExtensionFactory } from '@mariozechner/pi-coding-agent';

import { AtelierSidebar, buildAtelierSidebarRows } from './atelier-sidebar.js';
import type { ParsedPrompt } from './types.js';
import { isRecord } from './utils.js';

interface SidebarMeasurementCache {
  key: string;
  parsed: ParsedPrompt;
}

interface PendingSidebarRefresh {
  ctx: ExtensionContext;
  prompt?: string;
}

interface AgentSettledEvent {
  type: 'agent_settled';
}

type AgentSettledHandler = (
  event: AgentSettledEvent,
  ctx: ExtensionContext,
) => void | Promise<void>;

declare module '@mariozechner/pi-coding-agent' {
  interface ExtensionAPI {
    on(event: 'agent_settled', handler: AgentSettledHandler): void;
  }
}

const EXTENSION: ExtensionFactory = (pi) => {
  let agentActive = false;
  let atelierDiscovered = false;
  let sessionContext: ExtensionContext | undefined;
  let measurementCache: SidebarMeasurementCache | undefined;
  let pendingRefresh: PendingSidebarRefresh | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const publishSidebar = async (ctx: ExtensionContext, prompt: string): Promise<void> => {
    if (agentActive || !ctx.isIdle()) {
      pendingRefresh ??= { ctx, prompt };
      return;
    }

    const allTools = pi.getAllTools();
    const activeToolNames = pi.getActiveTools();
    const model: unknown = ctx.model;
    const modelApi = isRecord(model) && typeof model.api === 'string' ? model.api : undefined;
    const modelProvider =
      isRecord(model) && typeof model.provider === 'string' ? model.provider : undefined;
    const { buildSidebarMeasurementKey, measureTokenBudget } =
      await import('./measureTokenBudget.js');
    if (agentActive || !ctx.isIdle()) {
      pendingRefresh ??= { ctx, prompt };
      return;
    }
    const key = buildSidebarMeasurementKey({
      prompt,
      allTools,
      activeToolNames,
      modelApi,
      modelProvider,
    });
    const cached = measurementCache;

    let parsed: ParsedPrompt;
    if (cached?.key === key) {
      parsed = cached.parsed;
    } else {
      parsed = measureTokenBudget({
        prompt,
        allTools,
        activeToolNames,
        modelApi,
        modelProvider,
        details: false,
      });
      measurementCache = { key, parsed };
    }

    const modelContextWindow =
      isRecord(model) && typeof model.contextWindow === 'number' ? model.contextWindow : undefined;
    const contextWindow = ctx.getContextUsage()?.contextWindow ?? modelContextWindow;
    sidebar.update(buildAtelierSidebarRows({ parsed, contextWindow }));
  };

  const cancelRefresh = (): void => {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  };

  const flushPendingRefresh = (): void => {
    if (
      agentActive ||
      !pendingRefresh ||
      refreshTimer !== undefined ||
      !pendingRefresh.ctx.isIdle()
    ) {
      return;
    }

    const refresh = pendingRefresh;
    pendingRefresh = undefined;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (agentActive || !refresh.ctx.isIdle()) {
        pendingRefresh ??= refresh;
        return;
      }
      const prompt = refresh.prompt ?? refresh.ctx.getSystemPrompt();
      void publishSidebar(refresh.ctx, prompt).catch(() => undefined);
    }, 0);
  };

  const scheduleCurrentPrompt = (ctx: ExtensionContext): void => {
    pendingRefresh = { ctx };
    flushPendingRefresh();
  };

  const sidebar = new AtelierSidebar(pi.events, {
    onDiscover: () => {
      if (atelierDiscovered) {
        return;
      }
      atelierDiscovered = true;
      sidebar.update([{ text: 'Measuring…', role: 'context' }]);
      if (pendingRefresh) {
        flushPendingRefresh();
      } else if (sessionContext) {
        scheduleCurrentPrompt(sessionContext);
      }
    },
  });

  pi.on('session_start', (_event, ctx) => {
    agentActive = false;
    sessionContext = ctx;
    measurementCache = undefined;
    pendingRefresh = undefined;
    cancelRefresh();
    if (atelierDiscovered) {
      scheduleCurrentPrompt(ctx);
    }
  });

  pi.on('before_agent_start', (event, ctx) => {
    agentActive = true;
    // If the startup refresh has not started yet, let the model go first.
    cancelRefresh();
    pendingRefresh = { ctx, prompt: event.systemPrompt };
  });

  // The installed Pi CLI exposes this post-retry/compaction event, while the
  // peer package's older declaration does not yet include it.
  pi.on('agent_settled', () => {
    agentActive = false;
    if (atelierDiscovered) {
      flushPendingRefresh();
    }
  });

  pi.on('model_select', (_event, ctx) => {
    if (atelierDiscovered && !pendingRefresh) {
      cancelRefresh();
      scheduleCurrentPrompt(ctx);
    }
  });

  pi.registerCommand('token-burden', {
    description: 'Show token budget breakdown and manage skills',
    handler: async (args, ctx) => {
      const { runTokenBurden } = await import('./runTokenBurden.js');
      await runTokenBurden(pi, args, ctx);
    },
  });
};

/** Pi extension entrypoint required by the extension loader. */
export default EXTENSION;
