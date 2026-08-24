import { encode } from 'gpt-tokenizer/encoding/o200k_base';

import { ToolEnvelope } from './enums.js';
import { buildToolDefinitionsSection, estimateTokens, parseSystemPrompt } from './parser.js';

describe('lightweight token budget measurement', () => {
  it('keeps top-level prompt totals without building drill-down data', () => {
    const basePrompt = [
      'You are an expert coding assistant operating inside pi.',
      '',
      'Pi documentation:',
      '- Always read pi .md files completely',
    ].join('\n');
    const projectContext = [
      '',
      '',
      '# Project Context',
      '',
      '## /tmp/AGENTS.md',
      'Keep it simple.',
    ].join('\n');
    const skills = [
      '',
      '',
      'The following skills provide specialized instructions for specific tasks.',
      '<available_skills>',
      '  <skill>',
      '    <name>testing</name>',
      '    <description>Test changes.</description>',
      '    <location>/tmp/testing/SKILL.md</location>',
      '  </skill>',
      '</available_skills>',
    ].join('\n');
    const metadata = '\nCurrent date: 2026-08-21\nCurrent working directory: /tmp';
    const prompt = basePrompt + projectContext + skills + metadata;

    const detailed = parseSystemPrompt(prompt);
    const summary = parseSystemPrompt(prompt, { details: false });

    expect(summary.totalChars).toBe(detailed.totalChars);
    expect(summary.totalTokens).toBe(detailed.totalTokens);
    expect(summary.sections.map(({ chars, tokens }) => ({ chars, tokens }))).toEqual(
      detailed.sections.map(({ chars, tokens }) => ({ chars, tokens })),
    );
    expect(summary.sections.reduce((total, section) => total + section.tokens, 0)).toBe(
      summary.totalTokens,
    );
    expect(summary.skills).toEqual([]);
    expect(summary.sections.every((section) => section.content === undefined)).toBeTruthy();
    expect(summary.sections.every((section) => section.children === undefined)).toBeTruthy();
  });

  it('counts only the compact selected tool envelope in summary mode', () => {
    const tools = [
      {
        name: 'read',
        description: 'Read files with JSON-like text: {"quoted": true}',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
      {
        name: 'bash',
        description: 'Run commands',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ];
    const serializedPayloads: string[] = [];
    const indentationLevels: (number | undefined)[] = [];
    const countedTexts: string[] = [];
    const serializeJson = (value: unknown, indentation?: number): string => {
      indentationLevels.push(indentation);
      const serialized = JSON.stringify(value, null, indentation);
      if (serialized === undefined) {
        throw new TypeError('Expected serializable test payload');
      }
      serializedPayloads.push(serialized);
      return serialized;
    };
    const countTokens = (text: string): number => {
      countedTexts.push(text);
      return estimateTokens(text);
    };

    const detailed = buildToolDefinitionsSection(tools, ['read'], ToolEnvelope.ANTHROPIC);
    const summary = buildToolDefinitionsSection(tools, ['read'], ToolEnvelope.ANTHROPIC, {
      details: false,
      countTokens,
      serializeJson,
    });
    const expectedPayload = JSON.stringify([
      {
        name: tools[0]?.name,
        description: tools[0]?.description,
        input_schema: {
          type: 'object',
          properties: tools[0]?.parameters.properties,
          required: [],
        },
      },
    ]);

    expect(summary?.label).toBe(detailed?.label);
    expect(summary?.chars).toBe(detailed?.chars);
    expect(summary?.tokens).toBe(detailed?.tokens);
    expect(summary?.tools).toBeUndefined();
    expect(summary?.children).toBeUndefined();
    expect(serializedPayloads).toStrictEqual([expectedPayload]);
    expect(indentationLevels).toStrictEqual([undefined]);
    expect(countedTexts).toStrictEqual([expectedPayload]);
  });

  it('preserves summary character counts for every provider envelope', () => {
    const tools = [
      {
        name: 'lookup',
        description: 'Lookup nested data with punctuation [one, two] and \\ escapes',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
          },
          required: ['query'],
        },
      },
    ];

    for (const envelope of Object.values(ToolEnvelope)) {
      const detailed = buildToolDefinitionsSection(tools, undefined, envelope);
      const summary = buildToolDefinitionsSection(tools, undefined, envelope, { details: false });

      expect(summary?.chars).toBe(detailed?.chars);
      expect(summary?.tokens).toBe(detailed?.tokens);
    }
  });

  it('preserves empty and inactive tool summary behavior', () => {
    const tools = [{ name: 'read', description: 'Read files', parameters: {} }];
    const detailed = buildToolDefinitionsSection(tools, [], ToolEnvelope.COMPACT);
    const summary = buildToolDefinitionsSection(tools, [], ToolEnvelope.COMPACT, {
      details: false,
    });

    expect(
      buildToolDefinitionsSection([], [], ToolEnvelope.COMPACT, { details: false }),
    ).toBeNull();
    expect(summary).toStrictEqual({
      label: 'Tool definitions (0 active, 1 total)',
      chars: detailed?.chars,
      tokens: detailed?.tokens,
    });
  });
});

describe('allocation-light token counting', () => {
  it('matches encode length for representative text', () => {
    const samples = [
      '',
      'Read files before editing.',
      'Unicode: café λ 你好 👩🏽‍💻',
      'const result = items.map(({ id }) => ({ id, ok: true }));',
      JSON.stringify({ nested: ['value', 42, true], escaped: 'line\\nquote"' }),
    ];

    for (const sample of samples) {
      expect(estimateTokens(sample)).toBe(encode(sample).length);
    }
  });
});
