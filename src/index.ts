import type { ExtensionContext, ExtensionFactory } from '@mariozechner/pi-coding-agent';

import { AtelierSidebar, buildAtelierSidebarRows } from './atelier-sidebar.js';
import { applyDeferredToolDefaults, registerDeferredToolSearch } from './tool-deferred-loading.js';
import type { ParsedPrompt } from './types.js';
import { isRecord } from './utils.js';
import { WorkbenchContributionPublisher } from './workbench-contribution.js';

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

function sessionId(ctx: ExtensionContext): string | undefined {
  const getter = ctx.sessionManager?.getSessionId;
  if (typeof getter !== 'function') return undefined;
  const value = getter.call(ctx.sessionManager);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const EXTENSION: ExtensionFactory = (pi) => {
  let agentActive = false;
  let atelierDiscovered = false;
  let workbenchDiscoveredSession: string | undefined;
  let sessionContext: ExtensionContext | undefined;
  let measurementCache: SidebarMeasurementCache | undefined;
  let pendingRefresh: PendingSidebarRefresh | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  registerDeferredToolSearch(pi);

  const workbench = new WorkbenchContributionPublisher(pi.events, {
    onDiscover: (event) => {
      workbenchDiscoveredSession = event.sessionId;
      const ctx = sessionContext;
      if (!ctx || sessionId(ctx) !== event.sessionId) return;
      if (pendingRefresh) flushPendingRefresh();
      else scheduleCurrentPrompt(ctx);
    },
  });

  const publishMeasurement = async (ctx: ExtensionContext, prompt: string): Promise<void> => {
    if (agentActive || !ctx.isIdle()) {
      pendingRefresh ??= { ctx, prompt };
      return;
    }

    const allTools = pi.getAllTools();
    const activeToolNames = pi.getActiveTools();
    const model: unknown = ctx.model;
    const modelApi = isRecord(model) && typeof model.api === 'string' ? model.api : undefined;
    const modelProvider = isRecord(model) && typeof model.provider === 'string' ? model.provider : undefined;
    const { buildSidebarMeasurementKey, measureTokenBudget } = await import('./measureTokenBudget.js');
    if (agentActive || !ctx.isIdle()) {
      pendingRefresh ??= { ctx, prompt };
      return;
    }

    const key = buildSidebarMeasurementKey({ prompt, allTools, activeToolNames, modelApi, modelProvider });
    const cached = measurementCache;
    let parsed: ParsedPrompt;
    if (cached?.key === key) parsed = cached.parsed;
    else {
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

    const modelContextWindow = isRecord(model) && typeof model.contextWindow === 'number' ? model.contextWindow : undefined;
    const contextWindow = ctx.getContextUsage()?.contextWindow ?? modelContextWindow;

    if (atelierDiscovered) sidebar.update(buildAtelierSidebarRows({ parsed, contextWindow }));

    const currentSession = sessionId(ctx);
    if (currentSession && currentSession === workbenchDiscoveredSession) {
      workbench.update({
        sessionId: currentSession,
        parsed,
        contextWindow,
        activeTools: activeToolNames.length,
        totalTools: allTools.length,
        modelApi,
        modelProvider,
      });
    }
  };

  const cancelRefresh = (): void => {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  };

  function flushPendingRefresh(): void {
    if (agentActive || !pendingRefresh || refreshTimer !== undefined || !pendingRefresh.ctx.isIdle()) return;
    const refresh = pendingRefresh;
    pendingRefresh = undefined;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (agentActive || !refresh.ctx.isIdle()) {
        pendingRefresh ??= refresh;
        return;
      }
      const prompt = refresh.prompt ?? refresh.ctx.getSystemPrompt();
      void publishMeasurement(refresh.ctx, prompt).catch(() => undefined);
    }, 0);
  }

  function scheduleCurrentPrompt(ctx: ExtensionContext): void {
    pendingRefresh = { ctx };
    flushPendingRefresh();
  }

  const sidebar = new AtelierSidebar(pi.events, {
    onDiscover: () => {
      if (atelierDiscovered) return;
      atelierDiscovered = true;
      sidebar.update([{ text: 'Measuring…', role: 'context' }]);
      if (pendingRefresh) flushPendingRefresh();
      else if (sessionContext) scheduleCurrentPrompt(sessionContext);
    },
  });

  pi.on('session_start', (_event, ctx) => {
    agentActive = false;
    sessionContext = ctx;
    measurementCache = undefined;
    pendingRefresh = undefined;
    cancelRefresh();
    workbench.clear();
    applyDeferredToolDefaults(pi);
    const currentSession = sessionId(ctx);
    if (atelierDiscovered || (currentSession && currentSession === workbenchDiscoveredSession)) scheduleCurrentPrompt(ctx);
  });

  pi.on('before_agent_start', (event, ctx) => {
    agentActive = true;
    cancelRefresh();
    pendingRefresh = { ctx, prompt: event.systemPrompt };
  });

  pi.on('agent_settled', () => {
    agentActive = false;
    const currentSession = sessionContext ? sessionId(sessionContext) : undefined;
    if (atelierDiscovered || (currentSession && currentSession === workbenchDiscoveredSession)) flushPendingRefresh();
  });

  pi.on('model_select', (_event, ctx) => {
    const currentSession = sessionId(ctx);
    if ((atelierDiscovered || (currentSession && currentSession === workbenchDiscoveredSession)) && !pendingRefresh) {
      cancelRefresh();
      scheduleCurrentPrompt(ctx);
    }
  });

  pi.on('session_shutdown', () => {
    cancelRefresh();
    pendingRefresh = undefined;
    sessionContext = undefined;
    measurementCache = undefined;
    workbench.clear();
  });

  pi.registerCommand('token-burden', {
    description: 'Show token budget breakdown and manage skills/tools',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (args.trim() === 'tools') {
        const { runToolDefaults } = await import('./runToolDefaults.js');
        await runToolDefaults(pi, ctx);
        return;
      }
      const { runTokenBurden } = await import('./runTokenBurden.js');
      await runTokenBurden(pi, args, ctx);
    },
  });
};

/** Pi extension entrypoint required by the extension loader. */
export default EXTENSION;
