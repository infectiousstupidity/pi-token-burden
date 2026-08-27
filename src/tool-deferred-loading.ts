import * as os from 'node:os';
import * as path from 'node:path';

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';

import { loadSettings, saveSettings } from './skill-visibility-store.js';
import type { Settings } from './types.js';

export const TOOL_SEARCH_NAME = 'search_tools';
export const DEFAULT_ALWAYS_ACTIVE_TOOLS = ['read', 'bash', 'edit', 'write'] as const;
export const DEFERRED_TOOLS_ENV = 'PI_TOKEN_BURDEN_DEFERRED_TOOLS';
export const ALWAYS_ACTIVE_TOOLS_ENV = 'PI_TOKEN_BURDEN_ALWAYS_ACTIVE';

const SETTINGS_KEY = 'pi-token-burden';
const SEARCH_LIMIT = 5;

interface DeferredToolsSettings {
  enabled?: boolean;
  alwaysActive?: string[];
}

interface TokenBurdenSettings {
  deferredTools?: DeferredToolsSettings;
}

interface ToolLike {
  name: string;
  description?: string;
}

export interface ResolvedDeferredToolsSettings {
  enabled: boolean;
  alwaysActive: string[];
}

// Some Pi package releases expose this at runtime before their published type
// declarations catch up. Keep the extension source compatible with both.
declare module '@mariozechner/pi-coding-agent' {
  interface ExtensionAPI {
    setActiveTools(toolNames: string[]): void;
  }
}

function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir === '~') {
      return os.homedir();
    }
    if (envDir.startsWith('~/')) {
      return path.join(os.homedir(), envDir.slice(2));
    }
    return envDir;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

export function getPiSettingsPath(): string {
  return path.join(getAgentDir(), 'settings.json');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function decodeTokenBurdenSettings(settings: Settings): TokenBurdenSettings {
  const raw = asRecord(settings[SETTINGS_KEY]);
  const deferredRaw = asRecord(raw.deferredTools);

  const enabled = deferredRaw.enabled;
  const alwaysActive = deferredRaw.alwaysActive;

  return {
    deferredTools: {
      enabled: typeof enabled === 'boolean' ? enabled : undefined,
      alwaysActive:
        Array.isArray(alwaysActive) && alwaysActive.every((name) => typeof name === 'string')
          ? [...new Set(alwaysActive)]
          : undefined,
    },
  };
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseAlwaysActiveEnv(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return [...new Set(value.split(',').map((name) => name.trim()).filter(Boolean))];
}

export function loadDeferredToolsSettings(
  settingsPath = getPiSettingsPath(),
): ResolvedDeferredToolsSettings {
  const settings = decodeTokenBurdenSettings(loadSettings(settingsPath));
  const envEnabled = parseBooleanEnv(process.env[DEFERRED_TOOLS_ENV]);
  const envAlwaysActive = parseAlwaysActiveEnv(process.env[ALWAYS_ACTIVE_TOOLS_ENV]);

  return {
    enabled: envEnabled ?? settings.deferredTools?.enabled ?? true,
    alwaysActive:
      envAlwaysActive ?? settings.deferredTools?.alwaysActive ?? [...DEFAULT_ALWAYS_ACTIVE_TOOLS],
  };
}

export function saveDeferredToolsSettings(
  value: ResolvedDeferredToolsSettings,
  settingsPath = getPiSettingsPath(),
): void {
  const settings = loadSettings(settingsPath);
  const existing = asRecord(settings[SETTINGS_KEY]);
  settings[SETTINGS_KEY] = {
    ...existing,
    deferredTools: {
      ...asRecord(existing.deferredTools),
      enabled: value.enabled,
      alwaysActive: [...new Set(value.alwaysActive)].toSorted(),
    },
  };
  saveSettings(settings, settingsPath);
}

export function saveDefaultActiveTools(
  toolNames: Iterable<string>,
  settingsPath = getPiSettingsPath(),
): ResolvedDeferredToolsSettings {
  const current = loadDeferredToolsSettings(settingsPath);
  const next = {
    ...current,
    alwaysActive: [...new Set(toolNames)].filter((name) => name !== TOOL_SEARCH_NAME).toSorted(),
  };
  saveDeferredToolsSettings(next, settingsPath);
  return next;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, ' ').trim();
}

function rankTool(tool: ToolLike, query: string): number {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return 0;
  }

  const name = normalizeText(tool.name);
  const description = normalizeText(tool.description ?? '');
  if (name === normalizedQuery) {
    return 1000;
  }

  let score = 0;
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  for (const term of terms) {
    if (name === term) {
      score += 100;
    } else if (name.startsWith(term)) {
      score += 60;
    } else if (name.includes(term)) {
      score += 40;
    }
    if (description.includes(term)) {
      score += 10;
    }
  }

  if (name.includes(normalizedQuery)) {
    score += 80;
  }
  if (description.includes(normalizedQuery)) {
    score += 20;
  }
  return score;
}

export function applyDeferredToolDefaults(
  pi: ExtensionAPI,
  settings = loadDeferredToolsSettings(),
): string[] {
  if (typeof pi.setActiveTools !== 'function') {
    return pi.getActiveTools();
  }

  const available = pi.getAllTools().map((tool) => tool.name);
  if (!settings.enabled) {
    const active = available.filter((name) => name !== TOOL_SEARCH_NAME);
    pi.setActiveTools(active);
    return active;
  }

  const availableSet = new Set(available);
  const active = [
    TOOL_SEARCH_NAME,
    ...settings.alwaysActive.filter((name) => availableSet.has(name)),
  ];
  const uniqueActive = [...new Set(active)].filter((name) => availableSet.has(name));
  pi.setActiveTools(uniqueActive);
  return uniqueActive;
}

export function registerDeferredToolSearch(pi: ExtensionAPI): void {
  if (typeof pi.registerTool !== 'function' || typeof pi.setActiveTools !== 'function') {
    return;
  }

  pi.registerTool({
    name: TOOL_SEARCH_NAME,
    label: 'Search Tools',
    description: 'Find and activate deferred tools when a needed capability is unavailable.',
    parameters: Type.Object({
      query: Type.String({ description: 'Capability to find.' }),
    }),
    execute: async (_toolCallId, params) => {
      const activeNames = new Set(pi.getActiveTools());
      const candidates = pi
        .getAllTools()
        .filter((tool) => tool.name !== TOOL_SEARCH_NAME && !activeNames.has(tool.name))
        .map((tool) => ({
          tool,
          score: rankTool(tool, params.query),
        }))
        .filter((entry) => entry.score > 0)
        .toSorted((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

      const selected = candidates.slice(0, SEARCH_LIMIT).map((entry) => entry.tool);

      if (selected.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No deferred tools matched "${params.query}". Try a broader query.`,
            },
          ],
          details: { query: params.query, activated: [] },
        };
      }

      const activated = selected.map((tool) => tool.name);
      pi.setActiveTools([...pi.getActiveTools(), ...activated]);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Activated: ${activated.join(', ')}`,
          },
        ],
        details: { query: params.query, activated },
      };
    },
  });
}
