import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';

import { buildToolDefinitionsSection, parseSystemPrompt, toolEnvelopeForModel } from './parser.js';
import type { ParsedPrompt } from './types.js';
import { isRecord } from './utils.js';

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
  details?: boolean;
}

/** Measure the model-facing prompt and tool schemas into Budget Sections. */
export function measureTokenBudget({
  prompt,
  allTools,
  activeToolNames,
  modelApi,
  modelProvider,
  details = true,
}: MeasureTokenBudgetInput): ParsedPrompt {
  const parsed = details ? parseSystemPrompt(prompt) : parseSystemPrompt(prompt, { details: false });
  const countedEnvelope = toolEnvelopeForModel(modelApi, modelProvider);
  const toolSection = details
    ? buildToolDefinitionsSection(allTools, activeToolNames, countedEnvelope)
    : buildToolDefinitionsSection(allTools, activeToolNames, countedEnvelope, { details: false });

  if (toolSection) {
    parsed.sections.push(toolSection);
    parsed.totalTokens += toolSection.tokens;
    parsed.totalChars += toolSection.chars;
  }

  return parsed;
}

/** Measure the model-facing prompt and tool schemas for a live session context. */
export function measureForContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
): ParsedPrompt {
  const rawModel: unknown = ctx.model;
  const model = isRecord(rawModel) ? rawModel : {};
  return measureTokenBudget({
    prompt,
    allTools: pi.getAllTools(),
    activeToolNames: pi.getActiveTools(),
    modelApi: typeof model.api === 'string' ? model.api : undefined,
    modelProvider: typeof model.provider === 'string' ? model.provider : undefined,
  });
}
