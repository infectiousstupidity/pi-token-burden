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

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonicalizePlainObjects(value: unknown): CanonicalValue | undefined {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizePlainObjects(item) ?? null);
  }

  if (typeof value !== 'object') {
    return undefined;
  }

  const prototype: unknown = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }

  const result: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(value).toSorted()) {
    const item = canonicalizePlainObjects(Reflect.get(value, key));
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}

/** Build the semantic identity of a lightweight sidebar measurement. */
export function buildSidebarMeasurementKey({
  prompt,
  allTools,
  activeToolNames,
  modelApi,
  modelProvider,
}: MeasureTokenBudgetInput): string {
  const activeNames = [...new Set(activeToolNames)].toSorted();
  const activeSet = new Set(activeNames);
  const activeTools = allTools
    .filter((tool) => activeSet.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: canonicalizePlainObjects(tool.parameters),
    }));

  return JSON.stringify({
    prompt,
    countedEnvelope: toolEnvelopeForModel(modelApi, modelProvider),
    hasTools: allTools.length > 0,
    activeNames,
    activeTools,
  });
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
  const parsed = details
    ? parseSystemPrompt(prompt)
    : parseSystemPrompt(prompt, { details: false });
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
