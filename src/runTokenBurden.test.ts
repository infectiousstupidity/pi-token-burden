import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { fromPartial } from '@total-typescript/shoehorn';

import type { BasePromptTraceResult } from './base-trace/index.js';
import { DisableMode } from './enums.js';
import { runTokenBurden } from './runTokenBurden.js';
import type {
  ParsedPrompt,
  Settings,
  SkillInfo,
  SkillSaveOutcome,
  SkillToggleResult,
} from './types.js';

interface MeasureForContextModule {
  measureForContext(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): ParsedPrompt;
}

/** Options the command handler passes to showReport. */
interface ShowReportOptions {
  contextWindow?: number;
  onLoadSkills: () => Promise<SkillInfo[]>;
  onToggleResult: (result: SkillToggleResult) => boolean;
  onRunTrace: () => Promise<BasePromptTraceResult>;
}

const {
  evaluations,
  mockAttributeBasePrompt,
  mockDiscoverAndLoadExtensions,
  mockExtractBaseLines,
  mockExtractContributions,
  mockGetExtensionPaths,
  mockMeasureForContext,
  mockEstimateTokens,
  mockShowReport,
  mockLoadAllSkills,
  mockLoadSettings,
  mockSaveSkillToggleResult,
  mockSkillVisibilityStore,
} = vi.hoisted(() => ({
  evaluations: { baseTrace: 0, parser: 0, piExtensionDiscovery: 0 },
  mockAttributeBasePrompt: vi.fn(),
  mockDiscoverAndLoadExtensions: vi.fn(),
  mockExtractBaseLines: vi.fn(),
  mockExtractContributions: vi.fn(),
  mockGetExtensionPaths: vi.fn(),
  mockMeasureForContext: vi.fn<MeasureForContextModule['measureForContext']>(),
  mockEstimateTokens: vi.fn<(text: string) => number>(),
  mockShowReport:
    vi.fn<
      (
        parsed: ParsedPrompt,
        ctx: ExtensionCommandContext,
        options: ShowReportOptions,
      ) => Promise<void>
    >(),
  mockLoadAllSkills: vi.fn<
    (
      settings: Settings,
      overrideDirs?: string[],
      settingsBaseDir?: string,
    ) => {
      skills: SkillInfo[];
      byName: Map<string, SkillInfo>;
    }
  >(),
  mockLoadSettings: vi.fn<(settingsPath: string) => Settings>(),
  mockSaveSkillToggleResult:
    vi.fn<
      (
        result: SkillToggleResult,
        persist: (changes: Map<string, DisableMode>) => void,
      ) => SkillSaveOutcome
    >(),
  mockSkillVisibilityStore: vi.fn(),
}));

vi.mock('@mariozechner/pi-coding-agent', () => {
  evaluations.piExtensionDiscovery += 1;
  return {
    discoverAndLoadExtensions: mockDiscoverAndLoadExtensions,
    SettingsManager: {
      create: () => ({ getExtensionPaths: mockGetExtensionPaths }),
    },
  };
});

vi.mock('./base-trace/index.js', () => {
  evaluations.baseTrace += 1;
  return {
    attributeBasePrompt: mockAttributeBasePrompt,
    extractBaseLines: mockExtractBaseLines,
    extractContributions: mockExtractContributions,
  };
});

vi.mock('./measureTokenBudget.js', () => ({
  measureForContext: mockMeasureForContext,
}));

vi.mock('./parser.js', () => {
  evaluations.parser += 1;
  return { estimateTokens: mockEstimateTokens };
});

vi.mock('./report-view.js', () => ({
  showReport: mockShowReport,
}));

vi.mock('./skills.js', () => ({
  loadAllSkills: mockLoadAllSkills,
}));

vi.mock('./skill-visibility-store.js', () => ({
  SkillVisibilityStore: mockSkillVisibilityStore,
  loadSettings: mockLoadSettings,
}));

vi.mock('./saveSkillToggleResult.js', () => ({
  saveSkillToggleResult: mockSaveSkillToggleResult,
}));

function makeContext(
  overrides: {
    hasUI?: boolean;
    getContextUsage?: () =>
      | { tokens: number | null; contextWindow: number; percent: number | null }
      | undefined;
    model?: { api?: string; provider?: string; contextWindow?: number };
    ui?: { notify: (message: string, type?: 'info' | 'warning' | 'error') => void };
  } = {},
): ExtensionCommandContext {
  return fromPartial<ExtensionCommandContext>({
    getSystemPrompt: () => 'prompt',
    getContextUsage:
      overrides.getContextUsage ?? (() => ({ tokens: 100, contextWindow: 200000, percent: 0.05 })),
    hasUI: overrides.hasUI ?? true,
    model: overrides.model,
    ui: overrides.ui ?? { notify: vi.fn() },
  });
}

function makePi(): ExtensionAPI {
  return fromPartial<ExtensionAPI>({
    getAllTools: () => [],
    getActiveTools: () => [],
  });
}

function requireReportOptions(): ShowReportOptions {
  const call = mockShowReport.mock.calls[0];
  if (call === undefined) {
    throw new Error('showReport not called');
  }

  return call[2];
}

async function openReport(ctx: ExtensionCommandContext): Promise<ShowReportOptions> {
  await runTokenBurden(makePi(), '', ctx);
  expect(mockShowReport).toHaveBeenCalledTimes(1);
  return requireReportOptions();
}

describe('runTokenBurden', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    evaluations.baseTrace = 0;
    evaluations.parser = 0;
    evaluations.piExtensionDiscovery = 0;
    mockMeasureForContext.mockReturnValue({
      sections: [],
      totalChars: 0,
      totalTokens: 0,
      skills: [],
    });
    mockLoadSettings.mockReturnValue({});
    mockLoadAllSkills.mockReturnValue({ skills: [], byName: new Map() });
    mockSkillVisibilityStore.mockImplementation(function () {
      return { applyChanges: vi.fn() };
    });
    mockGetExtensionPaths.mockReturnValue(['/extensions/demo.ts']);
    mockDiscoverAndLoadExtensions.mockResolvedValue({
      extensions: [{ path: '/extensions/demo.ts', tools: new Map() }],
      errors: [],
    });
    mockExtractContributions.mockReturnValue([]);
    mockExtractBaseLines.mockReturnValue({ toolLines: [], guidelineLines: [] });
    mockEstimateTokens.mockReturnValue(4);
    mockAttributeBasePrompt.mockReturnValue({ buckets: [], evidence: [] });
  });

  it('defensively exits before measurement without UI', async () => {
    const pi = fromPartial<ExtensionAPI>({
      getAllTools: () => [],
      getActiveTools: () => ['read'],
    });
    const ctx = makeContext({
      hasUI: false,
      model: { api: 'anthropic-messages', provider: 'openrouter' },
    });

    await runTokenBurden(pi, '', ctx);

    expect(mockMeasureForContext).not.toHaveBeenCalled();
  });

  it('does not open the report or load skills without UI', async () => {
    const ctx = makeContext({ hasUI: false });

    await runTokenBurden(makePi(), '', ctx);

    expect(mockShowReport).not.toHaveBeenCalled();
    expect(mockLoadSettings).not.toHaveBeenCalled();
    expect(mockSkillVisibilityStore).not.toHaveBeenCalled();
    expect(mockLoadAllSkills).not.toHaveBeenCalled();
  });

  it('opens the report without discovering skills and provides lazy callbacks', async () => {
    const demoSkill: SkillInfo = {
      name: 'demo',
      description: 'Demo skill',
      filePath: '/tmp/skills/demo/SKILL.md',
      allPaths: ['/tmp/skills/demo/SKILL.md'],
      mode: DisableMode.ENABLED,
      tokens: 10,
      hasDuplicates: false,
    };
    mockLoadAllSkills.mockReturnValue({
      skills: [demoSkill],
      byName: new Map([['demo', demoSkill]]),
    });

    const options = await openReport(makeContext());

    expect(options.contextWindow).toBe(200000);
    expect(mockLoadSettings).not.toHaveBeenCalled();
    expect(mockLoadAllSkills).not.toHaveBeenCalled();
    expect(options.onLoadSkills).toBeTypeOf('function');
    expect(options.onToggleResult).toBeTypeOf('function');
    expect(options.onRunTrace).toBeTypeOf('function');
    expect(evaluations.baseTrace).toBe(0);
    expect(evaluations.parser).toBe(0);
    expect(evaluations.piExtensionDiscovery).toBe(0);

    await expect(options.onLoadSkills()).resolves.toEqual([demoSkill]);
    await expect(options.onLoadSkills()).resolves.toEqual([demoSkill]);
    expect(mockLoadSettings).toHaveBeenCalledTimes(1);
    expect(mockLoadAllSkills).toHaveBeenCalledTimes(1);
  });

  it('allows skill discovery to retry after a failure', async () => {
    mockLoadAllSkills.mockImplementationOnce(() => {
      throw new Error('skill scan failed');
    });
    const options = await openReport(makeContext());

    await expect(options.onLoadSkills()).rejects.toThrow('skill scan failed');
    await expect(options.onLoadSkills()).resolves.toEqual([]);

    expect(mockLoadAllSkills).toHaveBeenCalledTimes(2);
    expect(mockShowReport).toHaveBeenCalledTimes(1);
  });

  it('loads optional Source Trace analysis only when requested', async () => {
    mockMeasureForContext.mockReturnValue({
      sections: [{ label: 'Base prompt', chars: 11, tokens: 4, content: 'base prompt' }],
      totalChars: 11,
      totalTokens: 4,
      skills: [],
    });
    const options = await openReport(makeContext());

    const result = await options.onRunTrace();
    await options.onRunTrace();

    expect(result).toMatchObject({ fingerprint: '/extensions/demo.ts', baseTokens: 4 });
    expect(evaluations.baseTrace).toBe(1);
    expect(evaluations.parser).toBe(1);
    expect(evaluations.piExtensionDiscovery).toBe(1);
    expect(mockDiscoverAndLoadExtensions).toHaveBeenCalledTimes(2);
  });

  it('rejects Source Trace failures without affecting the open report', async () => {
    mockDiscoverAndLoadExtensions.mockRejectedValueOnce(new Error('extension load failed'));
    const options = await openReport(makeContext());

    await expect(options.onRunTrace()).rejects.toThrow('extension load failed');
    expect(mockShowReport).toHaveBeenCalledTimes(1);
  });

  it('falls back to the model context window when context usage is unavailable', async () => {
    const ctx = makeContext({
      getContextUsage: () => undefined,
      model: { contextWindow: 128000 },
    });

    const options = await openReport(ctx);

    expect(options.contextWindow).toBe(128000);
  });

  it('saves a skill toggle against the complete lazy-loaded inventory', async () => {
    const notify = vi.fn();
    const duplicateSkill: SkillInfo = {
      name: 'demo',
      description: 'Demo skill',
      filePath: '/skills/demo/SKILL.md',
      allPaths: ['/skills/demo/SKILL.md', '/other/demo/SKILL.md'],
      mode: DisableMode.ENABLED,
      tokens: 10,
      hasDuplicates: true,
    };
    const byName = new Map([['demo', duplicateSkill]]);
    const applyChanges = vi.fn();
    mockLoadAllSkills.mockReturnValue({ skills: [duplicateSkill], byName });
    mockSkillVisibilityStore.mockImplementation(function () {
      return { applyChanges };
    });
    mockSaveSkillToggleResult.mockImplementation((_result, persist) => {
      persist(new Map([['demo', DisableMode.HIDDEN]]));
      return {
        ok: true,
        saved: true,
        summary: '1 skill hidden',
      };
    });

    const options = await openReport(makeContext({ ui: { notify } }));
    await options.onLoadSkills();

    const result = options.onToggleResult({
      applied: true,
      changes: new Map([['demo', DisableMode.HIDDEN]]),
    });

    expect(result).toBe(true);
    expect(applyChanges).toHaveBeenCalledWith(new Map([['demo', DisableMode.HIDDEN]]), byName);
    expect(notify).toHaveBeenCalledWith(
      'Skills updated: 1 skill hidden. Use /reload or restart for changes to take effect.',
      'info',
    );
  });

  it('notifies an error when saving a skill toggle result fails', async () => {
    const notify = vi.fn();
    mockSaveSkillToggleResult.mockReturnValue({
      ok: false,
      saved: false,
      errorMessage: 'disk full',
    });

    const options = await openReport(makeContext({ ui: { notify } }));

    const result = options.onToggleResult({
      applied: true,
      changes: new Map([['demo', DisableMode.HIDDEN]]),
    });

    expect(result).toBe(false);
    expect(notify).toHaveBeenCalledWith('Failed to save settings: disk full', 'error');
  });
});
