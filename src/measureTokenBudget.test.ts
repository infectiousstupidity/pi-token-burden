import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { fromPartial } from '@total-typescript/shoehorn';

import type { ParsedPrompt, PromptSection } from './types.js';

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
  toolEnvelopeForModel(api?: string, provider?: string): string;
}

const PARSE_SYSTEM_PROMPT_MOCK = vi.fn<ParserModule['parseSystemPrompt']>();
const BUILD_TOOL_DEFINITIONS_SECTION_MOCK = vi.fn<ParserModule['buildToolDefinitionsSection']>();
const TOOL_ENVELOPE_FOR_MODEL_MOCK = vi.fn<ParserModule['toolEnvelopeForModel']>();

vi.mock<ParserModule>(import('./parser.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  parseSystemPrompt: PARSE_SYSTEM_PROMPT_MOCK,
  buildToolDefinitionsSection: BUILD_TOOL_DEFINITIONS_SECTION_MOCK,
  toolEnvelopeForModel: TOOL_ENVELOPE_FOR_MODEL_MOCK,
}));

const tools = [
  { name: 'read', description: 'Read files', parameters: {} },
  { name: 'bash', description: 'Run commands', parameters: {} },
];

describe('Token Budget Pipeline measurement', () => {
  it('accounts for active tools using the provider/API envelope', async () => {
    const promptSection: PromptSection = {
      label: 'Combined System Prompt',
      chars: 6,
      tokens: 2,
    };
    const toolSection: PromptSection = {
      label: 'Combined Tool Definitions',
      chars: 120,
      tokens: 30,
    };
    PARSE_SYSTEM_PROMPT_MOCK.mockReturnValue({
      sections: [promptSection],
      totalChars: 6,
      totalTokens: 2,
      skills: [],
    });
    TOOL_ENVELOPE_FOR_MODEL_MOCK.mockReturnValue('anthropic');
    BUILD_TOOL_DEFINITIONS_SECTION_MOCK.mockReturnValue(toolSection);

    const { measureTokenBudget } = await import('./measureTokenBudget.js');
    const measured = measureTokenBudget({
      prompt: 'prompt',
      allTools: tools,
      activeToolNames: ['read'],
      modelApi: 'anthropic-messages',
      modelProvider: 'openrouter',
    });

    expect(TOOL_ENVELOPE_FOR_MODEL_MOCK).toHaveBeenCalledWith('anthropic-messages', 'openrouter');
    expect(BUILD_TOOL_DEFINITIONS_SECTION_MOCK).toHaveBeenCalledWith(tools, ['read'], 'anthropic');
    expect(measured).toStrictEqual({
      sections: [promptSection, toolSection],
      totalChars: 126,
      totalTokens: 32,
      skills: [],
    });
  });

  it('leaves prompt totals unchanged when there is no tool section', async () => {
    const parsed = {
      sections: [],
      totalChars: 6,
      totalTokens: 2,
      skills: [],
    };
    PARSE_SYSTEM_PROMPT_MOCK.mockReturnValue(parsed);
    TOOL_ENVELOPE_FOR_MODEL_MOCK.mockReturnValue('openai-responses');
    BUILD_TOOL_DEFINITIONS_SECTION_MOCK.mockReturnValue(null);

    const { measureTokenBudget } = await import('./measureTokenBudget.js');
    const measured = measureTokenBudget({
      prompt: 'prompt',
      allTools: [],
      activeToolNames: [],
    });

    expect(measured).toStrictEqual(parsed);
    expect(measured.totalChars).toBe(6);
    expect(measured.totalTokens).toBe(2);
  });

  it('measures a live session context with its model api/provider', async () => {
    PARSE_SYSTEM_PROMPT_MOCK.mockReturnValue({
      sections: [],
      totalChars: 6,
      totalTokens: 2,
      skills: [],
    });
    TOOL_ENVELOPE_FOR_MODEL_MOCK.mockReturnValue('anthropic');
    BUILD_TOOL_DEFINITIONS_SECTION_MOCK.mockReturnValue(null);

    const { measureForContext } = await import('./measureTokenBudget.js');
    const pi = fromPartial<ExtensionAPI>({
      getAllTools: () => tools,
      getActiveTools: () => ['read'],
    });
    const ctx = fromPartial<ExtensionContext>({
      model: { api: 'anthropic-messages', provider: 'openrouter' },
    });

    measureForContext(pi, ctx, 'prompt');

    expect(TOOL_ENVELOPE_FOR_MODEL_MOCK).toHaveBeenCalledWith('anthropic-messages', 'openrouter');
    expect(BUILD_TOOL_DEFINITIONS_SECTION_MOCK).toHaveBeenCalledWith(tools, ['read'], 'anthropic');
  });

  it('omits model api/provider from a live session context when the model is absent', async () => {
    PARSE_SYSTEM_PROMPT_MOCK.mockReturnValue({
      sections: [],
      totalChars: 6,
      totalTokens: 2,
      skills: [],
    });
    TOOL_ENVELOPE_FOR_MODEL_MOCK.mockReturnValue('openai-responses');
    BUILD_TOOL_DEFINITIONS_SECTION_MOCK.mockReturnValue(null);

    const { measureForContext } = await import('./measureTokenBudget.js');
    const pi = fromPartial<ExtensionAPI>({
      getAllTools: () => [],
      getActiveTools: () => [],
    });
    const ctx = fromPartial<ExtensionContext>({});

    measureForContext(pi, ctx, 'prompt');

    expect(TOOL_ENVELOPE_FOR_MODEL_MOCK).toHaveBeenCalledWith(undefined, undefined);
    expect(BUILD_TOOL_DEFINITIONS_SECTION_MOCK).toHaveBeenCalledWith([], [], 'openai-responses');
  });
});
