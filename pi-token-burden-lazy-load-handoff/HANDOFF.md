# Handoff: `perf/lazy-load`

## Goal

Remove the startup-time penalty caused by loading `pi-token-burden` when the user never runs `/token-burden`.

The open upstream issue is:

- Whamp/pi-token-burden#33: **“Pi token burden places burden on startup time”**
- Reported cost: roughly **400 ms on every Pi startup**
- Reporter specifically suggested checking with `PI_TIMING=1 pi`

This branch must make extension startup cheap without changing Token Burden behavior once the command is actually used.

## Repository and branch

Repository:

```text
infectiousstupidity/pi-token-burden
```

Base the work on the fork's `main` unless instructed otherwise.

Create:

```bash
git switch main
git pull
git switch -c perf/lazy-load
```

The fork's `main` was at:

```text
46146112e275fe0d71c8eb1bef76f68c27e68ac8
```

when this handoff was prepared.

If `feature/atelier-sidebar` has already been merged into the fork before this work starts, branch from that updated `main` instead. Do not include unrelated sidebar changes in a standalone lazy-load PR.

## Read before changing code

Follow the repository's own instructions first:

```text
AGENTS.md
CONTEXT.md
docs/agents/domain.md
architecture/Token Budget Pipeline.md
```

Relevant repo rule:

- run focused checks while working;
- run `pnpm run check` before committing;
- manually exercise user-visible extension flows with `pi -e ./src/index.ts`.

Do not add a dependency, change lint rules, or introduce shell-executing tools.

## Current problem

`src/index.ts` is the extension entrypoint. Pi has to evaluate it during extension loading.

Today that file eagerly imports the implementation needed only after `/token-burden` is invoked, including:

```text
src/index.ts
├── parser.ts
│   └── gpt-tokenizer/encoding/o200k_base
├── report-view.ts
│   ├── TUI/report code
│   ├── skill-management-session.ts
│   └── source-trace-report-cache.ts
├── base-trace/*
├── skills.ts
│   ├── yaml
│   └── parser.ts
├── skill-visibility-store.ts
└── saveSkillToggleResult.ts
```

The most obvious expensive boundary is `parser.ts`, which imports `gpt-tokenizer` at module scope. `report-view.ts` is also a large implementation module that has no reason to load before the command is used.

The extension therefore pays for Token Burden's feature graph just to register one slash command.

## Target architecture

Keep the Pi extension entrypoint tiny.

```text
Pi startup
   │
   ▼
src/index.ts
   │
   └── register `/token-burden`
             │
             │ user actually invokes command
             ▼
       dynamic import()
             │
             ▼
src/token-burden-command.ts
   ├── parser.ts → gpt-tokenizer
   ├── report-view.ts
   ├── skills.ts
   ├── skill-visibility-store.ts
   └── base-trace/*
```

### `src/index.ts`

It should do almost nothing besides register the command.

Prefer this shape:

```ts
import type { ExtensionFactory } from '@mariozechner/pi-coding-agent';

const EXTENSION: ExtensionFactory = (pi) => {
  pi.registerCommand('token-burden', {
    description: 'Show token budget breakdown and manage skills',
    handler: async (args, ctx) => {
      const { runTokenBurden } = await import('./token-burden-command.js');
      await runTokenBurden(pi, args, ctx);
    },
  });
};

export default EXTENSION;
```

Adapt types to the actual Pi API rather than copying the example blindly.

Important properties:

- no static import of `parser.ts`;
- no static import of `report-view.ts`;
- no static import of `skills.ts`;
- no static import of base tracing;
- no static import of `gpt-tokenizer` or `yaml`;
- no filesystem scanning during extension registration;
- no eager preload “just in case”.

`import type` is fine because it disappears at runtime.

### `src/token-burden-command.ts`

Move the current command implementation here with as little behavioral change as possible.

This module owns the work that currently lives inside the `/token-burden` handler:

- get the assembled system prompt;
- run the Token Budget Pipeline;
- add Combined Tool Definitions;
- get context-window data;
- load skills/settings;
- build Source Trace callbacks;
- open the report;
- save Skill Visibility State changes.

Do not redesign these subsystems as part of this performance fix.

## Why this design

It fixes the actual startup problem at the module boundary rather than trying to make every downstream module slightly faster.

ES module imports are cached after the first successful `import()`, so there is no need to build a custom global cache or module loader. The first `/token-burden` invocation pays the load cost. Later invocations in the same process reuse the loaded module.

That trade is correct:

```text
Never use Token Burden → almost no Token Burden startup cost
Use Token Burden once  → pay the cost when requested
Use it again           → module already loaded
```

## Scope

### In scope

- thin extension entrypoint;
- dynamic import of the command implementation;
- extraction of the current handler into a dedicated module;
- tests proving heavy code is not evaluated at extension registration;
- before/after startup measurements;
- regression testing of `/token-burden`.

### Out of scope

- changing token-counting behavior;
- replacing `gpt-tokenizer`;
- changing the tokenizer;
- changing the overlay;
- changing skill discovery;
- changing Source Trace;
- changing tool-envelope logic;
- adding dependencies;
- general refactoring or cleanup;
- implementing the Atelier sidebar feature.

Do not turn this into an architecture rewrite.

## Atelier sidebar compatibility

A separate `feature/atelier-sidebar` branch is planned/being implemented.

The lazy-load rule must survive when the two branches are eventually combined.

If Atelier integration exists when this branch is rebased, preserve this boundary:

```text
startup-safe code
├── command registration
└── tiny Atelier event/discovery bootstrap

heavy code
├── tokenizer
├── Token Budget Pipeline
├── skill scanning
└── detailed report UI
```

Do not make live sidebar support reintroduce unconditional `gpt-tokenizer` loading at Pi startup.

If the sidebar needs a token calculation, perform the heavy import only after Atelier has actually requested/activated the panel or another real measurement trigger occurs.

Do not solve that integration on this branch unless the sidebar changes are already present in the branch you are explicitly asked to modify.

## Performance acceptance criteria

The primary signal is Pi's own startup timing.

Before making changes, record a baseline using:

```bash
PI_TIMING=1 pi
```

Use the same machine, working directory, Pi configuration, and installed extensions before and after.

Run enough fresh Pi processes to avoid judging the result from one noisy sample. Use at least 10 runs when practical and report:

```text
before: median / min / max
after:  median / min / max
```

Success means:

1. the Token Burden extension-load penalty drops substantially;
2. target at least an **80% reduction** from the local baseline;
3. ideally the remaining incremental load cost is around **50 ms or less** on the machine where the ~400 ms behavior can be reproduced;
4. the first `/token-burden` invocation still works;
5. a second invocation in the same Pi process still works;
6. all existing token counts and user-visible behavior remain unchanged.

The percentage is the important criterion. Do not treat 50 ms as a portable guarantee across machines.

If `PI_TIMING=1 pi` output or current Pi CLI behavior has changed, inspect `pi --help` and the timing output first. Do not invent unsupported CLI flags merely to automate the benchmark.

## Testing strategy

### Structural regression test

Add a test that proves importing/registering `src/index.ts` does not evaluate the heavy command module.

A good test shape is:

```text
mock token-burden-command with a module-evaluation sentinel
↓
import src/index.ts
↓
register extension
↓
assert sentinel has NOT fired
↓
invoke registered /token-burden handler
↓
assert module loads and runTokenBurden is called
```

Use Vitest's module-reset/mock APIs correctly so the assertion genuinely tests dynamic loading rather than mock-hoisting behavior.

The test must fail if someone later changes this back to:

```ts
import { runTokenBurden } from './token-burden-command.js';
```

### Command behavior tests

Move or adapt the current `src/index.test.ts` behavior tests so they test `runTokenBurden()` directly where appropriate.

Keep coverage for:

- active tool names passed into Combined Tool Definitions;
- provider/model envelope selection;
- no-UI behavior;
- existing report invocation behavior.

Do not duplicate the same behavior test at both the entrypoint and command-module layers.

### Full verification

Run:

```bash
pnpm run test
pnpm run check
```

`pnpm run check` currently runs lint, typecheck, Sandcastle typecheck, formatting, dead-code checks, duplicate checks, and unit tests.

If tmux is available, running the existing e2e suite is useful:

```bash
pnpm run test:e2e
```

It is not a replacement for the manual startup benchmark.

### Manual behavior check

Run the local extension:

```bash
pi -e ./src/index.ts
```

Verify:

```text
1. Pi reaches the prompt normally.
2. /token-burden opens.
3. The report contents look unchanged.
4. Drill-down still works.
5. Run /token-burden again in the same process.
6. No duplicate registration/state issue appears.
```

If skill management is already part of the test environment, exercise it without making destructive settings changes.

## Expected changed files

Likely:

```text
src/index.ts
src/index.test.ts
src/token-burden-command.ts
src/token-burden-command.test.ts
```

Possibly one narrowly scoped benchmark or test helper if it clearly improves reproducibility.

Avoid touching parser/report/skill internals unless extraction exposes a real type boundary that cannot be solved cleanly otherwise.

## Commit

Preferred commit:

```text
perf: lazy-load token burden command
```

Do not open an upstream PR yet. This fork is for local testing first.

## Definition of done

The branch is done when all of these are true:

- `src/index.ts` no longer statically pulls in Token Burden's heavy implementation;
- `/token-burden` dynamically loads the implementation on first use;
- a regression test proves the command module is not evaluated during extension registration;
- existing command behavior tests pass;
- `pnpm run check` passes;
- local TUI testing passes;
- before/after `PI_TIMING=1` measurements are recorded;
- the startup penalty is materially reduced;
- no unrelated refactor is mixed into the change.
