import * as os from 'node:os';
import * as path from 'node:path';

import { discoverAndLoadExtensions, SettingsManager } from '@mariozechner/pi-coding-agent';
import type { ExtensionContext, ExtensionFactory } from '@mariozechner/pi-coding-agent';

import { AtelierSidebar, buildAtelierSidebarRows } from './atelier-sidebar.js';
import { attributeBasePrompt, extractBaseLines, extractContributions } from './base-trace/index.js';
import type { BasePromptTraceResult } from './base-trace/index.js';
import { measureTokenBudget } from './measureTokenBudget.js';
import { estimateTokens } from './parser.js';
import { showReport } from './report-view.js';
import { saveSkillToggleResult } from './saveSkillToggleResult.js';
import { SkillVisibilityStore, loadSettings } from './skill-visibility-store.js';
import { loadAllSkills } from './skills.js';
import { isRecord } from './utils.js';

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

const EXTENSION: ExtensionFactory = (pi) => {
  let atelierDiscovered = false;
  let sessionContext: ExtensionContext | undefined;
  let latestPrompt: string | undefined;

  const measureForContext = (ctx: ExtensionContext, prompt: string) => {
    const rawModel: unknown = ctx.model;
    const model = isRecord(rawModel) ? rawModel : {};
    return measureTokenBudget({
      prompt,
      allTools: pi.getAllTools(),
      activeToolNames: pi.getActiveTools(),
      modelApi: typeof model.api === 'string' ? model.api : undefined,
      modelProvider: typeof model.provider === 'string' ? model.provider : undefined,
    });
  };

  const publishSidebar = (ctx: ExtensionContext, prompt: string): void => {
    const parsed = measureForContext(ctx, prompt);
    const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;

    sidebar.update(buildAtelierSidebarRows({ parsed, contextWindow }));
  };

  const sidebar = new AtelierSidebar(pi.events, {
    onDiscover: () => {
      atelierDiscovered = true;
      if (sessionContext) {
        const prompt = latestPrompt ?? sessionContext.getSystemPrompt();
        latestPrompt = prompt;
        publishSidebar(sessionContext, prompt);
      }
    },
  });

  pi.on('session_start', (_event, ctx) => {
    sessionContext = ctx;
    latestPrompt = undefined;
    if (atelierDiscovered) {
      const prompt = ctx.getSystemPrompt();
      latestPrompt = prompt;
      publishSidebar(ctx, prompt);
    }
  });

  pi.on('before_agent_start', (event, ctx) => {
    sessionContext = ctx;
    latestPrompt = event.systemPrompt;
    if (atelierDiscovered) {
      publishSidebar(ctx, event.systemPrompt);
    }
  });

  pi.on('model_select', (_event, ctx) => {
    sessionContext = ctx;
    if (atelierDiscovered) {
      const prompt = latestPrompt ?? ctx.getSystemPrompt();
      latestPrompt = prompt;
      publishSidebar(ctx, prompt);
    }
  });

  pi.registerCommand('token-burden', {
    description: 'Show token budget breakdown and manage skills',
    handler: async (_args, ctx) => {
      const parsed = measureForContext(ctx, ctx.getSystemPrompt());

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
    },
  });
};

/** Pi extension entrypoint required by the extension loader. */
export default EXTENSION;
