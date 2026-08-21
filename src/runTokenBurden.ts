import * as os from 'node:os';
import * as path from 'node:path';

import { discoverAndLoadExtensions, SettingsManager } from '@mariozechner/pi-coding-agent';
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';

import { attributeBasePrompt, extractBaseLines, extractContributions } from './base-trace/index.js';
import type { BasePromptTraceResult } from './base-trace/index.js';
import { measureForContext } from './measureTokenBudget.js';
import { estimateTokens } from './parser.js';
import { showReport } from './report-view.js';
import { saveSkillToggleResult } from './saveSkillToggleResult.js';
import { SkillVisibilityStore, loadSettings } from './skill-visibility-store.js';
import { loadAllSkills } from './skills.js';

/**
 * Resolve the agent directory, matching pi's own resolution logic:
 * 1. Check PI_CODING_AGENT_DIR environment variable
 * 2. Fall back to ~/.pi/agent
 */
function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir === '~') {
      return os.homedir();
    }
    if (envDir.startsWith('~/')) {
      return path.join(os.homedir(), envDir.slice(2));
    }
    return envDir;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

/**
 * Run the /token-burden command: execute the Token Budget Pipeline and open
 * the report. Loaded dynamically by the extension entrypoint so the heavy
 * tokenizer/report graph only evaluates when the command is actually invoked.
 */
export async function runTokenBurden(
  pi: ExtensionAPI,
  _args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = measureForContext(pi, ctx, ctx.getSystemPrompt());

  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;

  if (!ctx.hasUI) {
    return;
  }

  const agentDir = getAgentDir();
  const settingsPath = path.join(agentDir, 'settings.json');
  const visibilityStore = new SkillVisibilityStore(settingsPath, agentDir);
  const settings = loadSettings(settingsPath);
  const { skills, byName } = loadAllSkills(settings, undefined, agentDir);

  const onRunTrace = async (): Promise<BasePromptTraceResult> => {
    const sm = SettingsManager.create(process.cwd(), agentDir);
    const configuredPaths = sm.getExtensionPaths();
    const { extensions, errors: loadErrors } = await discoverAndLoadExtensions(
      configuredPaths,
      process.cwd(),
      agentDir,
    );

    const contributions = extractContributions(extensions);

    const baseSection = parsed.sections.find((s) => s.label.startsWith('Base'));
    const baseText = baseSection?.content ?? '';
    const { toolLines, guidelineLines } = extractBaseLines(baseText);
    const baseTokens = estimateTokens(baseText);

    const { buckets, evidence } = attributeBasePrompt(
      toolLines,
      guidelineLines,
      contributions,
      baseTokens,
      estimateTokens,
    );

    const traceErrors = loadErrors.map((e) => ({
      source: e.path,
      message: e.error,
    }));

    return {
      fingerprint: extensions
        .map((e) => e.path)
        .toSorted()
        .join('|'),
      generatedAt: new Date().toISOString(),
      baseTokens,
      buckets,
      evidence,
      errors: traceErrors,
    };
  };

  await showReport(parsed, ctx, {
    contextWindow,
    discoveredSkills: skills,
    onToggleResult: (result) => {
      const outcome = saveSkillToggleResult(result, (changes) => {
        visibilityStore.applyChanges(changes, byName);
      });

      if (!outcome.ok) {
        ctx.ui.notify(`Failed to save settings: ${outcome.errorMessage}`, 'error');
        return false;
      }

      if (outcome.saved) {
        ctx.ui.notify(
          `Skills updated: ${outcome.summary}. Use /reload or restart for changes to take effect.`,
          'info',
        );
      }

      return true;
    },
    onRunTrace,
  });
}
