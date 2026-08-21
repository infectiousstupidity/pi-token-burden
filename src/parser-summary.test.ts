import { buildToolDefinitionsSection, parseSystemPrompt } from './parser.js';
import { ToolEnvelope } from './enums.js';

describe('lightweight token budget measurement', () => {
  it('keeps top-level prompt totals without building drill-down data', () => {
    const prompt = [
      'You are an expert coding assistant operating inside pi.',
      '',
      'Pi documentation:',
      '- Always read pi .md files completely',
      '',
      '',
      '# Project Context',
      '',
      '## /tmp/AGENTS.md',
      'Keep it simple.',
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
      'Current date: 2026-08-21',
      'Current working directory: /tmp',
    ].join('\n');

    const detailed = parseSystemPrompt(prompt);
    const summary = parseSystemPrompt(prompt, { details: false });

    expect(summary.totalChars).toBe(detailed.totalChars);
    expect(summary.totalTokens).toBe(detailed.totalTokens);
    expect(summary.sections.reduce((total, section) => total + section.tokens, 0)).toBe(
      summary.totalTokens,
    );
    expect(summary.skills).toEqual([]);
    expect(summary.sections.every((section) => section.content === undefined)).toBeTruthy();
    expect(summary.sections.every((section) => section.children === undefined)).toBeTruthy();
  });

  it('counts only the selected tool envelope when details are disabled', () => {
    const tools = [
      {
        name: 'read',
        description: 'Read files',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
      {
        name: 'bash',
        description: 'Run commands',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ];

    const detailed = buildToolDefinitionsSection(tools, ['read'], ToolEnvelope.ANTHROPIC);
    const summary = buildToolDefinitionsSection(tools, ['read'], ToolEnvelope.ANTHROPIC, {
      details: false,
    });

    expect(summary?.label).toBe(detailed?.label);
    expect(summary?.chars).toBe(detailed?.chars);
    expect(summary?.tokens).toBe(detailed?.tokens);
    expect(summary?.tools).toBeUndefined();
    expect(summary?.children).toBeUndefined();
  });
});
