import { fromPartial } from '@total-typescript/shoehorn';

import type { BasePromptTraceResult } from './base-trace/index.js';
import { DisableMode } from './enums.js';
import { getEditor, isReadOnlySection, showReport } from './report-view.js';
import type { ParsedPrompt, SkillInfo } from './types.js';

const { optionalModuleEvaluations } = vi.hoisted(() => ({
  optionalModuleEvaluations: { count: 0 },
}));

vi.mock('./source-trace-report-cache.js', async (importOriginal) => {
  optionalModuleEvaluations.count += 1;
  return importOriginal();
});

describe('report-view', () => {
  it('exports showReport function', () => {
    expectTypeOf(showReport).toBeFunction();
  });
});

interface OverlayComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

interface MockTui {
  requestRender: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

interface MountedOverlay {
  overlay: OverlayComponent;
  tui: MockTui;
}

type OverlayFactory = (
  tui: MockTui,
  theme: unknown,
  kb: unknown,
  done: (value: null) => void,
) => OverlayComponent;

async function mountOverlayWithTui(
  parsed: ParsedPrompt,
  discoveredSkills: SkillInfo[] = [],
  contextWindow?: number,
  onRunTrace?: () => Promise<BasePromptTraceResult>,
): Promise<MountedOverlay> {
  let component: OverlayComponent | undefined;
  let tui: MockTui | undefined;

  const ctx = {
    ui: {
      custom: vi.fn(async (factory: OverlayFactory) => {
        tui = {
          requestRender: vi.fn(),
          stop: vi.fn(),
          start: vi.fn(),
        };
        component = factory(tui, undefined, undefined, vi.fn());
      }),
    },
  };

  await showReport(parsed, fromPartial(ctx), {
    contextWindow,
    onLoadSkills: async () => discoveredSkills,
    onRunTrace,
  });

  if (!component) {
    throw new Error('Overlay component was not created');
  }

  if (!tui) {
    throw new Error('Overlay TUI was not created');
  }

  return { overlay: component, tui };
}

async function mountOverlay(
  parsed: ParsedPrompt,
  discoveredSkills: SkillInfo[] = [],
  contextWindow?: number,
): Promise<OverlayComponent> {
  const { overlay } = await mountOverlayWithTui(parsed, discoveredSkills, contextWindow);
  return overlay;
}

describe('showReport — rendering', () => {
  it('renders over-budget context window usage without crashing', async () => {
    const parsed: ParsedPrompt = {
      sections: [{ label: 'Base prompt', chars: 1000, tokens: 150 }],
      totalChars: 1000,
      totalTokens: 150,
      skills: [],
    };

    const overlay = await mountOverlay(parsed, [], 100);

    expect(() => overlay.render(120)).not.toThrow();
    expect(overlay.render(120).join('\n')).toContain('150 / 100');
  });

  it.each([
    { boundaryTokens: -1, baseTokens: 51, expectedPct: '—', rejectedPct: '-2.0%' },
    { boundaryTokens: 1, baseTokens: 49, expectedPct: '2.0%', rejectedPct: '—' },
  ])(
    'renders $boundaryTokens prompt-boundary reconciliation without a misleading percentage',
    async ({ boundaryTokens, baseTokens, expectedPct, rejectedPct }) => {
      const parsed: ParsedPrompt = {
        sections: [
          { label: 'Base prompt', chars: 100, tokens: baseTokens },
          { label: 'Prompt Boundary Overhead', chars: 0, tokens: boundaryTokens },
        ],
        totalChars: 100,
        totalTokens: 50,
        skills: [],
      };

      const overlay = await mountOverlay(parsed);
      const text = overlay.render(120).join('\n');

      expect(text).toContain('Prompt Boundary Overhead');
      expect(text).toContain(`${String(boundaryTokens)} tokens`);
      expect(text).not.toContain(rejectedPct);
      expect(text).toContain('Prompt Bo');
      expect(text).toContain(`… ${expectedPct}`);
    },
  );

  it('keeps an empty Skills section visible without eagerly loading hidden skills', async () => {
    const parsed: ParsedPrompt = {
      sections: [
        { label: 'Base prompt', chars: 100, tokens: 25 },
        { label: 'Metadata (date/time, cwd)', chars: 30, tokens: 5 },
      ],
      totalChars: 130,
      totalTokens: 30,
      skills: [],
    };
    const hiddenSkill: SkillInfo = {
      name: 'hidden-skill',
      description: 'Hidden skill',
      filePath: '/skills/hidden-skill/SKILL.md',
      allPaths: ['/skills/hidden-skill/SKILL.md'],
      mode: DisableMode.HIDDEN,
      tokens: 10,
      hasDuplicates: false,
    };
    const onLoadSkills = vi.fn(async () => [hiddenSkill]);
    let component: OverlayComponent | undefined;
    const ctx = {
      ui: {
        custom: vi.fn(async (factory: OverlayFactory) => {
          component = factory(
            { requestRender: vi.fn(), stop: vi.fn(), start: vi.fn() },
            undefined,
            undefined,
            vi.fn(),
          );
        }),
      },
    };

    await showReport(parsed, fromPartial(ctx), { onLoadSkills });

    if (!component) {
      throw new Error('Overlay component was not created');
    }
    expect(component.render(120).join('\n')).toContain('Skills (0)');
    expect(onLoadSkills).not.toHaveBeenCalled();
  });
});

describe('showReport — Skill Management', () => {
  const promptSkill = {
    name: 'active-skill',
    description: 'Prompt description',
    location: '/prompt/active-skill/SKILL.md',
    chars: 120,
    tokens: 30,
  };
  const parsed: ParsedPrompt = {
    sections: [
      {
        label: 'Skills (1)',
        chars: 120,
        tokens: 30,
        children: [
          {
            label: 'active-skill',
            chars: 120,
            tokens: 30,
          },
        ],
      },
    ],
    totalChars: 120,
    totalTokens: 30,
    skills: [promptSkill],
  };
  const activeSkill: SkillInfo = {
    name: 'active-skill',
    description: 'Filesystem description',
    filePath: '/filesystem/active-skill/SKILL.md',
    allPaths: ['/filesystem/active-skill/SKILL.md'],
    mode: DisableMode.ENABLED,
    tokens: 10,
    hasDuplicates: false,
  };

  it('loads the complete inventory on first entry and reuses it after navigation', async () => {
    const onLoadSkills = vi.fn(async () => [activeSkill]);
    let component: OverlayComponent | undefined;
    const ctx = {
      ui: {
        custom: vi.fn(async (factory: OverlayFactory) => {
          component = factory(
            { requestRender: vi.fn(), stop: vi.fn(), start: vi.fn() },
            undefined,
            undefined,
            vi.fn(),
          );
        }),
      },
    };

    await showReport(parsed, fromPartial(ctx), { onLoadSkills });

    if (!component) {
      throw new Error('Overlay component was not created');
    }
    expect(onLoadSkills).not.toHaveBeenCalled();

    component.handleInput('\r');
    expect(component.render(120).join('\n')).toContain('Loading skill inventory');
    await vi.waitFor(() => {
      expect(component?.render(120).join('\n')).toContain('active-skill');
    });

    component.handleInput('\u001B');
    component.handleInput('\r');
    await vi.waitFor(() => {
      expect(component?.render(120).join('\n')).toContain('active-skill');
    });
    expect(onLoadSkills).toHaveBeenCalledTimes(1);
  });

  it('preserves visibility, duplicate, preview, and save behavior after lazy loading', async () => {
    const hiddenSkill: SkillInfo = {
      name: 'hidden-skill',
      description: 'Hidden skill',
      filePath: '/skills/hidden-skill/SKILL.md',
      allPaths: ['/skills/hidden-skill/SKILL.md'],
      mode: DisableMode.HIDDEN,
      tokens: 20,
      hasDuplicates: false,
    };
    const disabledDuplicate: SkillInfo = {
      name: 'disabled-duplicate',
      description: 'Disabled duplicate skill',
      filePath: '/skills/disabled-duplicate/SKILL.md',
      allPaths: ['/skills/disabled-duplicate/SKILL.md', '/other/disabled-duplicate/SKILL.md'],
      mode: DisableMode.DISABLED,
      tokens: 15,
      hasDuplicates: true,
    };
    const onToggleResult = vi.fn(() => true);
    let component: OverlayComponent | undefined;
    const ctx = {
      ui: {
        custom: vi.fn(async (factory: OverlayFactory) => {
          component = factory(
            { requestRender: vi.fn(), stop: vi.fn(), start: vi.fn() },
            undefined,
            undefined,
            vi.fn(),
          );
        }),
      },
    };

    await showReport(parsed, fromPartial(ctx), {
      onLoadSkills: async () => [activeSkill, hiddenSkill, disabledDuplicate],
      onToggleResult,
    });

    if (!component) {
      throw new Error('Overlay component was not created');
    }
    component.handleInput('\r');
    await vi.waitFor(() => {
      const text = component?.render(120).join('\n') ?? '';
      expect(text).toContain('active-skill');
      expect(text).toContain('hidden-skill');
      expect(text).toContain('disabled-duplicate');
      expect(text).toContain('duplicates');
    });

    component.handleInput('\r');
    expect(component.render(120).join('\n')).toContain('1 pending change');
    component.handleInput('\u0013');

    expect(onToggleResult).toHaveBeenCalledWith({
      applied: true,
      changes: new Map([['active-skill', DisableMode.HIDDEN]]),
    });
  });

  it('surfaces discovery failure, keeps the base report usable, and retries on re-entry', async () => {
    const onLoadSkills = vi
      .fn<() => Promise<SkillInfo[]>>()
      .mockRejectedValueOnce(new Error('skill scan failed'))
      .mockResolvedValueOnce([activeSkill]);
    let component: OverlayComponent | undefined;
    const ctx = {
      ui: {
        custom: vi.fn(async (factory: OverlayFactory) => {
          component = factory(
            { requestRender: vi.fn(), stop: vi.fn(), start: vi.fn() },
            undefined,
            undefined,
            vi.fn(),
          );
        }),
      },
    };

    await showReport(parsed, fromPartial(ctx), { onLoadSkills });

    if (!component) {
      throw new Error('Overlay component was not created');
    }
    component.handleInput('\r');
    await vi.waitFor(() => {
      expect(component?.render(120).join('\n')).toContain(
        'Failed to load skills: skill scan failed',
      );
    });

    component.handleInput('\u001B');
    expect(component.render(120).join('\n')).toContain('Skills (1)');
    component.handleInput('\r');
    await vi.waitFor(() => {
      expect(component?.render(120).join('\n')).toContain('active-skill');
    });
    expect(onLoadSkills).toHaveBeenCalledTimes(2);
  });
});

describe('showReport — Source Trace', () => {
  const parsed: ParsedPrompt = {
    sections: [{ label: 'Base prompt', chars: 11, tokens: 4, content: 'base prompt' }],
    totalChars: 11,
    totalTokens: 4,
    skills: [],
  };
  const traceResult: BasePromptTraceResult = {
    fingerprint: 'trace-a',
    generatedAt: '2026-01-01T00:00:00.000Z',
    baseTokens: 4,
    buckets: [],
    evidence: [],
    errors: [],
  };

  it('loads optional report modules on demand and reuses the cached trace', async () => {
    const onRunTrace = vi.fn(async () => traceResult);
    const initialEvaluations = optionalModuleEvaluations.count;
    const { overlay } = await mountOverlayWithTui(parsed, [], undefined, onRunTrace);

    overlay.render(120);
    expect(optionalModuleEvaluations.count).toBe(initialEvaluations);

    overlay.handleInput('t');
    await vi.waitFor(() => {
      expect(onRunTrace).toHaveBeenCalledTimes(1);
    });
    expect(optionalModuleEvaluations.count).toBe(initialEvaluations + 1);

    overlay.handleInput('\u001B');
    overlay.handleInput('t');
    await vi.waitFor(() => {
      expect(overlay.render(120).join('\n')).toContain('Trace complete');
    });
    expect(onRunTrace).toHaveBeenCalledTimes(1);
    expect(optionalModuleEvaluations.count).toBe(initialEvaluations + 1);
  });

  it('contains an optional Source Trace failure and returns to the report', async () => {
    const onRunTrace = vi.fn(async (): Promise<BasePromptTraceResult> => {
      throw new Error('trace failed');
    });
    const { overlay } = await mountOverlayWithTui(parsed, [], undefined, onRunTrace);

    overlay.handleInput('t');
    await vi.waitFor(() => {
      expect(onRunTrace).toHaveBeenCalledTimes(1);
      expect(overlay.render(120).join('\n')).toContain('Base prompt');
    });
  });

  it('retries analysis after a failed refresh instead of restoring stale cached data', async () => {
    const refreshedResult = { ...traceResult, fingerprint: 'trace-b' };
    const onRunTrace = vi
      .fn<() => Promise<BasePromptTraceResult>>()
      .mockResolvedValueOnce(traceResult)
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(refreshedResult);
    const { overlay } = await mountOverlayWithTui(parsed, [], undefined, onRunTrace);

    overlay.handleInput('t');
    await vi.waitFor(() => {
      expect(overlay.render(120).join('\n')).toContain('Trace complete');
    });

    overlay.handleInput('r');
    await vi.waitFor(() => {
      expect(onRunTrace).toHaveBeenCalledTimes(2);
      expect(overlay.render(120).join('\n')).toContain('Base prompt');
    });

    overlay.handleInput('t');
    await vi.waitFor(() => {
      expect(onRunTrace).toHaveBeenCalledTimes(3);
      expect(overlay.render(120).join('\n')).toContain('Trace complete');
    });
  });
});

describe('showReport — tools view', () => {
  it('opens a dedicated tools view with Active expanded', async () => {
    const parsed: ParsedPrompt = {
      sections: [
        {
          label: 'Tool definitions (1 active, 2 total)',
          chars: 100,
          tokens: 10,
          children: [{ label: 'read', chars: 40, tokens: 10 }],
          tools: {
            active: [
              {
                name: 'read',
                chars: 40,
                tokens: 10,
                content: '{"name":"read"}',
              },
            ],
            inactive: [
              {
                name: 'bash',
                chars: 50,
                tokens: 12,
                content: '{"name":"bash"}',
              },
            ],
          },
        },
      ],
      totalChars: 100,
      totalTokens: 10,
      skills: [],
    };

    const overlay = await mountOverlay(parsed);
    overlay.handleInput('\r');

    const text = overlay.render(120).join('\n');

    expect(text).toContain('Active');
    expect(text).toContain('read');
    expect(text).toContain('10 tok');
    expect(text).not.toContain('bash');
  });

  it('shows Inactive as a collapsed counterfactual group by default', async () => {
    const parsed: ParsedPrompt = {
      sections: [
        {
          label: 'Tool definitions (1 active, 2 total)',
          chars: 100,
          tokens: 10,
          children: [{ label: 'read', chars: 40, tokens: 10 }],
          tools: {
            active: [
              {
                name: 'read',
                chars: 40,
                tokens: 10,
                content: '{"name":"read"}',
              },
            ],
            inactive: [
              {
                name: 'bash',
                chars: 50,
                tokens: 12,
                content: '{"name":"bash"}',
              },
            ],
          },
        },
      ],
      totalChars: 100,
      totalTokens: 10,
      skills: [],
    };

    const overlay = await mountOverlay(parsed);
    overlay.handleInput('\r');

    const text = overlay.render(120).join('\n');

    expect(text).toContain('Inactive (1, +12 tok if enabled)');
    expect(text).not.toContain('bash');
  });

  it('expands inactive tools after navigating past active tools', async () => {
    const parsed: ParsedPrompt = {
      sections: [
        {
          label: 'Tool definitions (1 active, 2 total)',
          chars: 100,
          tokens: 10,
          children: [{ label: 'read', chars: 40, tokens: 10 }],
          tools: {
            active: [
              {
                name: 'read',
                chars: 40,
                tokens: 10,
                content: '{"name":"read"}',
              },
            ],
            inactive: [
              {
                name: 'bash',
                chars: 50,
                tokens: 12,
                content: '{"name":"bash"}',
              },
            ],
          },
        },
      ],
      totalChars: 100,
      totalTokens: 10,
      skills: [],
    };

    const overlay = await mountOverlay(parsed);
    overlay.handleInput('\r');
    overlay.handleInput('\u001B[B');
    overlay.handleInput('\r');

    const text = overlay.render(120).join('\n');

    expect(text).toContain('bash');
    expect(text).toContain('+12 tok if enabled');
  });

  it('expands Inactive to show per-tool counterfactual rows', async () => {
    const parsed: ParsedPrompt = {
      sections: [
        {
          label: 'Tool definitions (0 active, 1 total)',
          chars: 50,
          tokens: 0,
          children: [],
          tools: {
            active: [],
            inactive: [
              {
                name: 'bash',
                chars: 50,
                tokens: 12,
                content: '{"name":"bash"}',
              },
            ],
          },
        },
      ],
      totalChars: 50,
      totalTokens: 0,
      skills: [],
    };

    const overlay = await mountOverlay(parsed);
    overlay.handleInput('\r');
    overlay.handleInput('\r');

    const text = overlay.render(120).join('\n');

    expect(text).toContain('bash');
    expect(text).toContain('+12 tok if enabled');
  });

  it('allows selecting inactive tools when no active tools are present', async () => {
    const parsed: ParsedPrompt = {
      sections: [
        {
          label: 'Tool definitions (0 active, 1 total)',
          chars: 50,
          tokens: 0,
          children: [],
          tools: {
            active: [],
            inactive: [
              {
                name: 'bash',
                chars: 50,
                tokens: 12,
                content: '{"name":"bash"}',
              },
            ],
          },
        },
      ],
      totalChars: 50,
      totalTokens: 0,
      skills: [],
    };

    const overlay = await mountOverlay(parsed);
    overlay.handleInput('\r');
    overlay.handleInput('\r');
    overlay.handleInput('\u001B[B');

    const selectedLine = overlay.render(120).find((line) => line.includes('▸'));

    expect(selectedLine).toContain('bash');
  });

  it('opens the selected tool definition in the editor', async () => {
    const savedVisual = process.env.VISUAL;
    const savedEditor = process.env.EDITOR;
    process.env.VISUAL = '';
    process.env.EDITOR = 'true';

    try {
      const parsed: ParsedPrompt = {
        sections: [
          {
            label: 'Tool definitions (1 active, 2 total)',
            chars: 100,
            tokens: 10,
            children: [{ label: 'read', chars: 40, tokens: 10 }],
            tools: {
              active: [
                {
                  name: 'read',
                  chars: 40,
                  tokens: 10,
                  content: '{"name":"read"}',
                },
              ],
              inactive: [
                {
                  name: 'bash',
                  chars: 50,
                  tokens: 12,
                  content: '{"name":"bash"}',
                },
              ],
            },
          },
        ],
        totalChars: 100,
        totalTokens: 10,
        skills: [],
      };

      const { overlay, tui } = await mountOverlayWithTui(parsed);
      overlay.handleInput('\r');
      overlay.handleInput('e');

      expect(tui.stop).toHaveBeenCalledWith();
      expect(tui.start).toHaveBeenCalledWith();
      expect(tui.requestRender).toHaveBeenCalledWith(true);
    } finally {
      process.env.VISUAL = savedVisual;
      process.env.EDITOR = savedEditor;
    }
  });

  it('shows a view hint when a tool row is selected', async () => {
    const parsed: ParsedPrompt = {
      sections: [
        {
          label: 'Tool definitions (1 active, 2 total)',
          chars: 100,
          tokens: 10,
          children: [{ label: 'read', chars: 40, tokens: 10 }],
          tools: {
            active: [
              {
                name: 'read',
                chars: 40,
                tokens: 10,
                content: '{"name":"read"}',
              },
            ],
            inactive: [
              {
                name: 'bash',
                chars: 50,
                tokens: 12,
                content: '{"name":"bash"}',
              },
            ],
          },
        },
      ],
      totalChars: 100,
      totalTokens: 10,
      skills: [],
    };

    const overlay = await mountOverlay(parsed);
    overlay.handleInput('\r');

    const text = overlay.render(120).join('\n');

    expect(text).toContain('view');
  });
});

describe('getEditor — editor resolution', () => {
  function withEnv(env: { VISUAL?: string; EDITOR?: string }, fn: () => void): void {
    const savedVisual = process.env.VISUAL;
    const savedEditor = process.env.EDITOR;
    try {
      if ('VISUAL' in env) {
        process.env.VISUAL = env.VISUAL;
      } else {
        delete process.env.VISUAL;
      }
      if ('EDITOR' in env) {
        process.env.EDITOR = env.EDITOR;
      } else {
        delete process.env.EDITOR;
      }
      fn();
    } finally {
      process.env.VISUAL = savedVisual;
      process.env.EDITOR = savedEditor;
    }
  }

  it('should prefer $VISUAL over $EDITOR', () => {
    withEnv({ VISUAL: 'code', EDITOR: 'vim' }, () => {
      expect(getEditor()).toBe('code');
    });
  });

  it('should fall back to $EDITOR when $VISUAL is unset', () => {
    withEnv({ EDITOR: 'nano' }, () => {
      expect(getEditor()).toBe('nano');
    });
  });

  it('should fall back to vi when both are unset', () => {
    withEnv({}, () => {
      expect(getEditor()).toBe('vi');
    });
  });

  it('should skip empty string $VISUAL', () => {
    withEnv({ VISUAL: '', EDITOR: 'nano' }, () => {
      expect(getEditor()).toBe('nano');
    });
  });
});

describe('isReadOnlySection — read-only detection', () => {
  it('returns true for generated sections', () => {
    expect(isReadOnlySection('Base prompt')).toBeTruthy();
    expect(isReadOnlySection('Metadata (date/time, cwd)')).toBeTruthy();
    expect(isReadOnlySection('SYSTEM.md / APPEND_SYSTEM.md')).toBeTruthy();
  });

  it('returns false for file-backed sections', () => {
    expect(isReadOnlySection('AGENTS.md files')).toBeFalsy();
    expect(isReadOnlySection('Skills (3)')).toBeFalsy();
  });
});
