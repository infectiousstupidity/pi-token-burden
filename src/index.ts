import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@mariozechner/pi-coding-agent';

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
  prompt: string;
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
  let latestPrompt: string | undefined;
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
      // Heavy tokenizer graph: evaluate only after Atelier has requested data.
      const { measureTokenBudget } = await import('./measureTokenBudget.js');
      parsed = measureTokenBudget({
        prompt,
        allTools,
        activeToolNames,
        modelApi,
        modelProvider,
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

  const scheduleSidebarRefresh = (ctx: ExtensionContext, prompt: string): void => {
    pendingRefresh = { ctx, prompt };
    if (refreshTimer !== undefined) {
      return;
    }

    // Token Burden is display-only. Run after the current Pi lifecycle hook returns
    // so tokenization can never hold up the model request. Replacing pendingRefresh
    // also coalesces multiple lifecycle events into one update.
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const refresh = pendingRefresh;
      pendingRefresh = undefined;
      if (!refresh || !atelierDiscovered) {
        return;
      }
      void publishSidebar(refresh.ctx, refresh.prompt).catch(() => undefined);
    }, 0);
  };

  const sidebar = new AtelierSidebar(pi.events, {
    onDiscover: () => {
      atelierDiscovered = true;
      if (sessionContext) {
        const prompt = latestPrompt ?? sessionContext.getSystemPrompt();
        latestPrompt = prompt;
        scheduleSidebarRefresh(sessionContext, prompt);
      }
    },
  });

  pi.on('session_start', (_event, ctx) => {
    sessionContext = ctx;
    latestPrompt = undefined;
    measurementCache = undefined;
    if (atelierDiscovered) {
      const prompt = ctx.getSystemPrompt();
      latestPrompt = prompt;
      scheduleSidebarRefresh(ctx, prompt);
    }
  });

  pi.on('before_agent_start', (event, ctx) => {
    sessionContext = ctx;
    latestPrompt = event.systemPrompt;
    if (atelierDiscovered) {
      scheduleSidebarRefresh(ctx, event.systemPrompt);
    }
  });

  pi.on('model_select', (_event, ctx) => {
    sessionContext = ctx;
    measurementCache = undefined;
    if (atelierDiscovered) {
      const prompt = latestPrompt ?? ctx.getSystemPrompt();
      latestPrompt = prompt;
      scheduleSidebarRefresh(ctx, prompt);
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
