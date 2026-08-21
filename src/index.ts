import type { ExtensionContext, ExtensionFactory } from '@mariozechner/pi-coding-agent';

import { AtelierSidebar, buildAtelierSidebarRows } from './atelier-sidebar.js';

const EXTENSION: ExtensionFactory = (pi) => {
  let atelierDiscovered = false;
  let sessionContext: ExtensionContext | undefined;
  let latestPrompt: string | undefined;

  const publishSidebar = async (ctx: ExtensionContext, prompt: string): Promise<void> => {
    // Heavy tokenizer graph: evaluate only when a real measurement trigger
    // fires (Atelier discovery or a session lifecycle event).
    const { measureForContext } = await import('./measureTokenBudget.js');
    const parsed = measureForContext(pi, ctx, prompt);
    const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;

    sidebar.update(buildAtelierSidebarRows({ parsed, contextWindow }));
  };

  const sidebar = new AtelierSidebar(pi.events, {
    onDiscover: async () => {
      atelierDiscovered = true;
      if (sessionContext) {
        const prompt = latestPrompt ?? sessionContext.getSystemPrompt();
        latestPrompt = prompt;
        await publishSidebar(sessionContext, prompt);
      }
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    sessionContext = ctx;
    latestPrompt = undefined;
    if (atelierDiscovered) {
      const prompt = ctx.getSystemPrompt();
      latestPrompt = prompt;
      await publishSidebar(ctx, prompt);
    }
  });

  pi.on('before_agent_start', async (event, ctx) => {
    sessionContext = ctx;
    latestPrompt = event.systemPrompt;
    if (atelierDiscovered) {
      await publishSidebar(ctx, event.systemPrompt);
    }
  });

  pi.on('model_select', async (_event, ctx) => {
    sessionContext = ctx;
    if (atelierDiscovered) {
      const prompt = latestPrompt ?? ctx.getSystemPrompt();
      latestPrompt = prompt;
      await publishSidebar(ctx, prompt);
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
