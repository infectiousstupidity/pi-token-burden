import * as fs from 'node:fs';

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { fromPartial } from '@total-typescript/shoehorn';

import {
  ALWAYS_ACTIVE_TOOLS_ENV,
  applyDeferredToolDefaults,
  DEFERRED_TOOLS_ENV,
  loadDeferredToolsSettings,
  registerDeferredToolSearch,
  saveDefaultActiveTools,
  saveDeferredToolsSettings,
  TOOL_SEARCH_NAME,
} from './tool-deferred-loading.js';

interface TestTool {
  name: string;
  description: string;
  parameters: Record<string, never>;
}

interface RegisteredSearchTool {
  name: string;
  execute(
    toolCallId: string,
    params: { query: string; limit?: number },
  ): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

function createPi(tools: TestTool[], initialActive: string[]) {
  const active = [...initialActive];
  let searchTool: RegisteredSearchTool | undefined;

  const pi = fromPartial<ExtensionAPI>({
    getAllTools: vi.fn(() => tools),
    getActiveTools: vi.fn(() => [...active]),
    setActiveTools: vi.fn((names: string[]) => {
      active.splice(0, active.length, ...names);
    }),
    registerTool: vi.fn((tool: unknown) => {
      const candidate = tool as RegisteredSearchTool;
      if (candidate.name === TOOL_SEARCH_NAME) {
        searchTool = candidate;
      }
    }),
  });

  return {
    pi,
    active,
    getSearchTool: () => {
      if (!searchTool) {
        throw new Error('search tool was not registered');
      }
      return searchTool;
    },
  };
}

const tools: TestTool[] = [
  { name: 'read', description: 'Read files', parameters: {} },
  { name: 'bash', description: 'Run shell commands', parameters: {} },
  { name: 'edit', description: 'Edit files', parameters: {} },
  { name: 'write', description: 'Write files', parameters: {} },
  { name: TOOL_SEARCH_NAME, description: 'Search deferred tools', parameters: {} },
  { name: 'lens_diagnostics', description: 'TypeScript diagnostics and compiler errors', parameters: {} },
  { name: 'web_search', description: 'Search the web', parameters: {} },
];

afterEach(() => {
  delete process.env[DEFERRED_TOOLS_ENV];
  delete process.env[ALWAYS_ACTIVE_TOOLS_ENV];
});

describe('deferred tool loading', () => {
  it('starts with core tools plus the loader only', () => {
    const { pi, active } = createPi(tools, tools.map((tool) => tool.name));

    applyDeferredToolDefaults(pi, {
      enabled: true,
      alwaysActive: ['read', 'bash', 'edit', 'write'],
    });

    expect(active).toEqual([TOOL_SEARCH_NAME, 'read', 'bash', 'edit', 'write']);
  });

  it('activates matching tools additively when searched', async () => {
    const { pi, active, getSearchTool } = createPi(tools, [
      TOOL_SEARCH_NAME,
      'read',
      'bash',
      'edit',
      'write',
    ]);
    registerDeferredToolSearch(pi);

    const result = await getSearchTool().execute('call-1', { query: 'typescript errors' });

    expect(active).toContain('lens_diagnostics');
    expect(active).not.toContain('web_search');
    expect(result.content[0]?.text).toContain('lens_diagnostics');
  });

  it('persists the chosen always-active defaults', () => {
    const oldDir = process.env.PI_CODING_AGENT_DIR;
    const tempDir = `${process.cwd()}/.tmp-token-burden-${String(process.pid)}`;
    process.env.PI_CODING_AGENT_DIR = tempDir;

    try {
      saveDefaultActiveTools(['read', 'edit', TOOL_SEARCH_NAME]);
      expect(loadDeferredToolsSettings()).toEqual({
        enabled: true,
        alwaysActive: ['edit', 'read'],
      });
    } finally {
      if (oldDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = oldDir;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('lets benchmark env vars override persisted settings without rewriting them', () => {
    const tempDir = `${process.cwd()}/.tmp-token-burden-env-${String(process.pid)}`;
    const settingsPath = `${tempDir}/settings.json`;

    try {
      saveDeferredToolsSettings({ enabled: false, alwaysActive: ['web_search'] }, settingsPath);
      process.env[DEFERRED_TOOLS_ENV] = '1';
      process.env[ALWAYS_ACTIVE_TOOLS_ENV] = 'read,bash,read';

      expect(loadDeferredToolsSettings(settingsPath)).toEqual({
        enabled: true,
        alwaysActive: ['read', 'bash'],
      });

      delete process.env[DEFERRED_TOOLS_ENV];
      delete process.env[ALWAYS_ACTIVE_TOOLS_ENV];
      expect(loadDeferredToolsSettings(settingsPath)).toEqual({
        enabled: false,
        alwaysActive: ['web_search'],
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
