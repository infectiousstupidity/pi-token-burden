# Task 05: Lazy-load optional `/token-burden` analysis

## Outcome

Invoking `/token-burden` should load only what the initial report needs. Source Trace and other optional analysis must stay unloaded until the user requests them. A headless command invocation should exit before importing or running the heavy command graph.

Create exactly one commit:

```text
perf: lazy-load optional command analysis
```

## Read first

```text
AGENTS.md
CONTEXT.md
docs/agents/domain.md
src/index.ts
src/index.test.ts
src/runTokenBurden.ts
src/runTokenBurden.test.ts
src/report-view.ts
src/source-trace-report-cache.ts
src/base-trace/*
```

Trace runtime imports, not just type imports. Identify which imports are required for the first report render and which exist only for Source Trace or another optional action.

## Problems to verify

The fork already lazy-loads the command implementation from the extension entrypoint. The second layer still has two avoidable costs to check:

1. the entrypoint may dynamically import `runTokenBurden` before knowing `ctx.hasUI` is false;
2. `runTokenBurden.ts` may statically import Source Trace/base-trace and extension-discovery machinery that is only used after the user explicitly enters Source Trace.

Verify current code before editing.

## Required behavior

### Headless fast exit

If `/token-burden` cannot render because `ctx.hasUI` is false, return from the smallest safe boundary before:

- dynamically importing the heavy command implementation;
- tokenizing the prompt;
- scanning skills;
- loading report UI;
- loading Source Trace/base-trace.

Keep a defensive no-UI guard inside the command implementation as appropriate, but do not rely on a late guard as the only protection.

### Source Trace on demand

Move runtime-only Source Trace/base-trace imports behind the callback/action that actually runs Source Trace. This includes Pi extension discovery APIs if they are used only for trace attribution.

The first report render must not evaluate `src/base-trace/*` merely because Source Trace is available as a future action.

Use native dynamic `import()` and normal ESM module caching. Do not add a custom loader/cache.

### Error behavior

Preserve current non-fatal Source Trace behavior. A failure to load/compute Source Trace must not break the already-open Token Burden report.

## Scope boundary

Do not:

- defer initial skill discovery here; slice 06 owns it;
- redesign report navigation or Source Trace semantics;
- change Source Trace attribution/counts;
- change tokenizer/parser behavior;
- alter sidebar measurement;
- add dependencies.

## Required tests

Use module-evaluation sentinels/mocks similar to the existing lazy-entrypoint tests.

At minimum prove:

1. importing/registering `src/index.ts` still does not evaluate the command implementation.
2. invoking `/token-burden` with `ctx.hasUI === false` does not evaluate `runTokenBurden` and does not measure.
3. invoking `/token-burden` with UI loads the command implementation and opens the report.
4. first report render does not evaluate base-trace/Source Trace implementation modules.
5. triggering Source Trace evaluates the optional modules once and produces the existing result.
6. a second Source Trace use respects existing cache behavior.
7. a Source Trace load/analysis failure remains contained and does not crash the report.

Avoid tests that accidentally pass because Vitest hoists a static mock. Reset modules and use explicit evaluation counters so a future static import regression fails the test.

## Validation

Run focused entrypoint/command/report tests, then:

```bash
pnpm run check
```

Because this changes command loading/navigation, also run when available:

```bash
pnpm run test:e2e
pi -e ./src/index.ts
```

Manual check:

1. open `/token-burden` and confirm the report appears normally;
2. enter Source Trace and confirm it still works;
3. close/reopen `/token-burden` and Source Trace in the same process.

## Performance evidence

Provide structural module-evaluation evidence:

```text
extension registration -> command module not evaluated
headless command        -> command module not evaluated
first UI report open    -> base-trace not evaluated
Source Trace requested  -> base-trace evaluated
```

Wall-clock timing is optional supporting evidence.

## Acceptance

- headless invocation exits before heavy import/measurement;
- optional Source Trace graph is not evaluated for the initial report;
- Source Trace behavior and cache still work on demand;
- existing command lazy-loading remains intact;
- focused tests, `pnpm run check`, and relevant UI/e2e checks pass;
- one clean commit with the required subject exists.
