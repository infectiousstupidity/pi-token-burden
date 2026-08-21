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

  const flushPendingRefresh = (): void => {
    if (!pendingRefresh || refreshTimer !== undefined) {
      return;
    }

    const refresh = pendingRefresh;
    pendingRefresh = undefined;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void publishSidebar(refresh.ctx, refresh.prompt).catch(() => undefined);
    }, 0);
  };

  const sidebar = new AtelierSidebar(pi.events, {
    onDiscover: () => {
      if (atelierDiscovered) {
        return;
      }
      atelierDiscovered = true;
      sidebar.update([{ text: 'Updates after first turn', role: 'context' }]);
    },
  });

  pi.on('session_start', () => {
    measurementCache = undefined;
    pendingRefresh = undefined;
  });

  pi.on('before_agent_start', (event, ctx) => {
    if (atelierDiscovered) {
      pendingRefresh = { ctx, prompt: event.systemPrompt };
    }
  });

  // Wait until the provider has started returning the assistant response before
  // spending CPU on a display-only measurement. message_update happens after the
  // request is already in flight; message_end covers empty/error responses.
  pi.on('message_update', () => {
    flushPendingRefresh();
  });

  pi.on('message_end', (event) => {
    if (event.message.role === 'assistant') {
      flushPendingRefresh();
    }
  });

  pi.on('model_select', () => {
    measurementCache = undefined;
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
