import { buildToolDefinitionsSection, parseSystemPrompt, toolEnvelopeForModel } from './parser.js';
import type { ParsedPrompt } from './types.js';

interface ToolDefinitionInput {
  name: string;
  description: string;
  parameters: unknown;
}

interface MeasureTokenBudgetInput {
  prompt: string;
  allTools: ToolDefinitionInput[];
  activeToolNames: string[];
  modelApi?: string;
  modelProvider?: string;
}

/** Measure the model-facing prompt and tool schemas into Budget Sections. */
export function measureTokenBudget({
  prompt,
  allTools,
  activeToolNames,
  modelApi,
  modelProvider,
}: MeasureTokenBudgetInput): ParsedPrompt {
  const parsed = parseSystemPrompt(prompt);
  const toolSection = buildToolDefinitionsSection(
    allTools,
    activeToolNames,
    toolEnvelopeForModel(modelApi, modelProvider),
  );

  if (toolSection) {
    parsed.sections.push(toolSection);
    parsed.totalTokens += toolSection.tokens;
    parsed.totalChars += toolSection.chars;
  }

  return parsed;
}
