import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from '@mariozechner/pi-coding-agent';

import { AtelierSidebar, buildAtelierSidebarRows } from './atelier-sidebar.js';
import type { ParsedPrompt } from './types.js';

type ToolDefinitions = ReturnType<ExtensionAPI['getAllTools']>;

interface SidebarMeasurementCache {
  prompt: string;
  modelApi?: string;
  modelProvider?: string;
  allTools: ToolDefinitions;
  activeToolNames: string[];
  parsed: ParsedPrompt;
}

interface PendingSidebarRefresh {
  ctx: ExtensionContext;
  prompt?: string;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameToolDefinitions(left: ToolDefinitions, right: ToolDefinitions): boolean {
  return (
    left.length === right.length &&
    left.every((tool, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        tool.name === other.name &&
        tool.description === other.description &&
        tool.parameters === other.parameters
      );
    })
  );
}

const EXTENSION: ExtensionFactory = (pi) => {
  let atelierDiscovered = false;
  let sessionContext: ExtensionContext | undefined;
  let measurementCache: SidebarMeasurementCache | undefined;
  let pendingRefresh: PendingSidebarRefresh | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const publishSidebar = async (ctx: ExtensionContext, prompt: string): Promise<void> => {
    const allTools = pi.getAllTools();
    const activeToolNames = pi.getActiveTools();
    const modelApi = ctx.model?.api;
    const modelProvider = ctx.model?.provider;
    const cached = measurementCache;

    let parsed: ParsedPrompt;
    if (
      cached &&
      cached.prompt === prompt &&
      cached.modelApi === modelApi &&
      cached.modelProvider === modelProvider &&
      sameStrings(cached.activeToolNames, activeToolNames) &&
      sameToolDefinitions(cached.allTools, allTools)
    ) {
      parsed = cached.parsed;
    } else {
      const { measureTokenBudget } = await import('./measureTokenBudget.js');
      parsed = measureTokenBudget({
        prompt,
        allTools,
        activeToolNames,
        modelApi,
        modelProvider,
        details: false,
      });
      measurementCache = {
        prompt,
        modelApi,
        modelProvider,
        allTools: [...allTools],
        activeToolNames: [...activeToolNames],
        parsed,
      };
    }

    const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
    sidebar.update(buildAtelierSidebarRows({ parsed, contextWindow }));
  };

  const cancelRefresh = (): void => {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  };

  const flushPendingRefresh = (): void => {
    if (!pendingRefresh || refreshTimer !== undefined) {
      return;
    }

    const refresh = pendingRefresh;
    pendingRefresh = undefined;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
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
      if (sessionContext) {
        scheduleCurrentPrompt(sessionContext);
      }
    },
  });

  pi.on('session_start', (_event, ctx) => {
    sessionContext = ctx;
    measurementCache = undefined;
    pendingRefresh = undefined;
    cancelRefresh();
    if (atelierDiscovered) {
      scheduleCurrentPrompt(ctx);
    }
  });

  pi.on('before_agent_start', (event, ctx) => {
    if (!atelierDiscovered) {
      return;
    }

    // If the startup refresh has not started yet, let the model go first.
    cancelRefresh();
    pendingRefresh = { ctx, prompt: event.systemPrompt };
  });

  pi.on('message_start', (event) => {
    if (event.message.role === 'assistant') {
      flushPendingRefresh();
    }
  });

  pi.on('message_end', (event) => {
    if (event.message.role === 'assistant') {
      flushPendingRefresh();
    }
  });

  pi.on('model_select', (_event, ctx) => {
    measurementCache = undefined;
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
