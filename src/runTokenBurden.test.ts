import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { fromPartial } from '@total-typescript/shoehorn';

import { runTokenBurden } from './runTokenBurden.js';

const {
  mockParseSystemPrompt,
  mockBuildToolDefinitionsSection,
  mockEstimateTokens,
  mockToolEnvelopeForModel,
} = vi.hoisted(() => ({
  mockParseSystemPrompt: vi.fn(),
  mockBuildToolDefinitionsSection: vi.fn(),
  mockEstimateTokens: vi.fn(),
  mockToolEnvelopeForModel: vi.fn(),
}));

vi.mock('./parser.js', () => ({
  parseSystemPrompt: mockParseSystemPrompt,
  buildToolDefinitionsSection: mockBuildToolDefinitionsSection,
  estimateTokens: mockEstimateTokens,
  toolEnvelopeForModel: mockToolEnvelopeForModel,
}));

describe('runTokenBurden', () => {
  it('passes active tool names when building the tools section', async () => {
    mockParseSystemPrompt.mockReturnValue({
      sections: [],
      totalChars: 0,
      totalTokens: 0,
      skills: [],
    });
    mockBuildToolDefinitionsSection.mockReturnValue(null);
    mockToolEnvelopeForModel.mockReturnValue('anthropic');

    const tools = [
      { name: 'read', description: 'Read files', parameters: {} },
      { name: 'bash', description: 'Run commands', parameters: {} },
    ];
    const pi = fromPartial<ExtensionAPI>({
      getAllTools: () => tools,
      getActiveTools: () => ['read'],
    });
    const ctx = fromPartial<ExtensionCommandContext>({
      getSystemPrompt: () => 'prompt',
      getContextUsage: () => null,
      hasUI: false,
      model: { api: 'anthropic-messages', provider: 'openrouter' },
    });

    await runTokenBurden(pi, ctx);

    expect(mockToolEnvelopeForModel).toHaveBeenCalledWith('anthropic-messages', 'openrouter');
    expect(mockBuildToolDefinitionsSection).toHaveBeenCalledWith(tools, ['read'], 'anthropic');
  });
});
