import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { fromPartial } from '@total-typescript/shoehorn';

import type { BasePromptTraceResult } from './base-trace/index.js';
import { DisableMode } from './enums.js';
import { runTokenBurden } from './runTokenBurden.js';
import type {
  ParsedPrompt,
  PromptSection,
  Settings,
  SkillInfo,
  SkillSaveOutcome,
  SkillToggleResult,
} from './types.js';

interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

interface ParserModule {
  parseSystemPrompt(prompt: string): ParsedPrompt;
  buildToolDefinitionsSection(
    tools: ToolDefinition[],
    activeToolNames?: string[],
    countedEnvelope?: string,
  ): PromptSection | null;
  estimateTokens(text: string): number;
  toolEnvelopeForModel(api?: string, provider?: string): string;
}

/** Options the command handler passes to showReport. */
interface ShowReportOptions {
  contextWindow?: number;
  discoveredSkills?: SkillInfo[];
  onToggleResult: (result: SkillToggleResult) => boolean;
  onRunTrace: () => Promise<BasePromptTraceResult>;
}

const {
  mockParseSystemPrompt,
  mockBuildToolDefinitionsSection,
  mockEstimateTokens,
  mockToolEnvelopeForModel,
  mockShowReport,
  mockLoadAllSkills,
  mockLoadSettings,
  mockSaveSkillToggleResult,
  mockSkillVisibilityStore,
} = vi.hoisted(() => ({
  mockParseSystemPrompt: vi.fn<ParserModule['parseSystemPrompt']>(),
  mockBuildToolDefinitionsSection: vi.fn<ParserModule['buildToolDefinitionsSection']>(),
  mockEstimateTokens: vi.fn<ParserModule['estimateTokens']>(),
  mockToolEnvelopeForModel: vi.fn<ParserModule['toolEnvelopeForModel']>(),
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

vi.mock('./parser.js', () => ({
  parseSystemPrompt: mockParseSystemPrompt,
  buildToolDefinitionsSection: mockBuildToolDefinitionsSection,
  estimateTokens: mockEstimateTokens,
  toolEnvelopeForModel: mockToolEnvelopeForModel,
}));

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
    mockParseSystemPrompt.mockReturnValue({
      sections: [],
      totalChars: 0,
      totalTokens: 0,
      skills: [],
    });
    mockBuildToolDefinitionsSection.mockReturnValue(null);
    mockToolEnvelopeForModel.mockReturnValue('anthropic');
    mockLoadSettings.mockReturnValue({});
    mockLoadAllSkills.mockReturnValue({ skills: [], byName: new Map() });
  });

  it('passes active tool names when building the tools section', async () => {
    const tools: ToolDefinition[] = [
      { name: 'read', description: 'Read files', parameters: {} },
      { name: 'bash', description: 'Run commands', parameters: {} },
    ];
    const pi = fromPartial<ExtensionAPI>({
      getAllTools: () => tools,
      getActiveTools: () => ['read'],
    });
    const ctx = makeContext({
      hasUI: false,
      model: { api: 'anthropic-messages', provider: 'openrouter' },
    });

    await runTokenBurden(pi, '', ctx);

    expect(mockToolEnvelopeForModel).toHaveBeenCalledWith('anthropic-messages', 'openrouter');
    expect(mockBuildToolDefinitionsSection).toHaveBeenCalledWith(tools, ['read'], 'anthropic');
  });

  it('does not open the report or load skills without UI', async () => {
    const ctx = makeContext({ hasUI: false });

    await runTokenBurden(makePi(), '', ctx);

    expect(mockShowReport).not.toHaveBeenCalled();
    expect(mockLoadSettings).not.toHaveBeenCalled();
    expect(mockSkillVisibilityStore).not.toHaveBeenCalled();
    expect(mockLoadAllSkills).not.toHaveBeenCalled();
  });

  it('opens the report with context window, discovered skills, and callbacks', async () => {
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
    expect(options.discoveredSkills).toEqual([demoSkill]);
    expect(options.onToggleResult).toBeTypeOf('function');
    expect(options.onRunTrace).toBeTypeOf('function');
  });

  it('falls back to the model context window when context usage is unavailable', async () => {
    const ctx = makeContext({
      getContextUsage: () => undefined,
      model: { contextWindow: 128000 },
    });

    const options = await openReport(ctx);

    expect(options.contextWindow).toBe(128000);
  });

  it('notifies when a skill toggle result is saved', async () => {
    const notify = vi.fn();
    mockSaveSkillToggleResult.mockReturnValue({
      ok: true,
      saved: true,
      summary: '1 skill enabled',
    });

    const options = await openReport(makeContext({ ui: { notify } }));

    const result = options.onToggleResult({
      applied: true,
      changes: new Map([['demo', DisableMode.ENABLED]]),
    });

    expect(result).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      'Skills updated: 1 skill enabled. Use /reload or restart for changes to take effect.',
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
