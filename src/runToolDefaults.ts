import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';

import {
  applyDeferredToolDefaults,
  loadDeferredToolsSettings,
  saveDeferredToolsSettings,
  TOOL_SEARCH_NAME,
} from './tool-deferred-loading.js';

const SAVE = '✓ Save and apply';
const CANCEL = '← Cancel';
const TOGGLE_ENABLED = 'Deferred loading';

function toolLabel(name: string, active: boolean): string {
  return `${active ? '●' : '○'} ${name}`;
}

/** Interactive editor for the tools that stay model-visible at session start. */
export async function runToolDefaults(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const initial = loadDeferredToolsSettings();
  let enabled = initial.enabled;
  const alwaysActive = new Set(initial.alwaysActive);

  const allToolNames = pi
    .getAllTools()
    .map((tool) => tool.name)
    .filter((name) => name !== TOOL_SEARCH_NAME)
    .toSorted();

  while (true) {
    const enabledLabel = `${enabled ? '●' : '○'} ${TOGGLE_ENABLED}`;
    const toolItems = allToolNames.map((name) => toolLabel(name, alwaysActive.has(name)));
    const selected = await ctx.ui.select('Default tool loading', [
      enabledLabel,
      SAVE,
      CANCEL,
      ...toolItems,
    ]);

    if (!selected || selected === CANCEL) {
      return;
    }

    if (selected === enabledLabel) {
      enabled = !enabled;
      continue;
    }

    if (selected === SAVE) {
      const settings = {
        enabled,
        alwaysActive: [...alwaysActive].toSorted(),
      };
      saveDeferredToolsSettings(settings);

      if (enabled) {
        applyDeferredToolDefaults(pi, settings);
      } else if (typeof pi.setActiveTools === 'function') {
        pi.setActiveTools(allToolNames);
      }

      ctx.ui.notify(
        enabled
          ? `Deferred tools enabled: ${String(settings.alwaysActive.length)} default active + ${TOOL_SEARCH_NAME}.`
          : 'Deferred tools disabled: all registered non-loader tools are active.',
        'info',
      );
      return;
    }

    const toolName = selected.slice(2);
    if (!allToolNames.includes(toolName)) {
      continue;
    }

    if (alwaysActive.has(toolName)) {
      alwaysActive.delete(toolName);
    } else {
      alwaysActive.add(toolName);
    }
  }
}
