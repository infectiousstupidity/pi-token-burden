# Task 04: Prove the performance win and finish validation

## Objective

Show that the structural change fixes issue #33 in practice and has not changed Token Burden behavior.

## Before/after benchmark

Use the baseline captured in Task 01.

Measure the lazy version under the same conditions:

```bash
PI_TIMING=1 pi
```

Use at least 10 fresh Pi starts when practical.

Report:

```text
Before
  median:
  min:
  max:

After
  median:
  min:
  max:

Reduction:
```

Calculate reduction using the same Token Burden/extension-load timing metric in both sets.

## Success target

Target:

```text
>= 80% reduction in Token Burden startup/load penalty
```

Ideally the remaining incremental cost is approximately:

```text
<= 50 ms
```

on the machine reproducing the reported ~400 ms cost.

The percentage reduction matters more than an absolute cross-machine number.

If the result is poor, do not start micro-optimizing random modules. Determine what is still imported from `src/index.ts` and why.

## Functional verification

Run:

```bash
pnpm run check
```

If tmux is available:

```bash
pnpm run test:e2e
```

Then manually:

```bash
pi -e ./src/index.ts
```

Verify:

```text
Pi startup succeeds.
No Token Burden UI appears until requested.
/token-burden opens normally.
Top-level token totals look unchanged.
Tool definitions are still included.
Drill-down works.
Source Trace still starts when requested.
Second /token-burden invocation works.
```

Where practical, compare the same fixture/test prompt before and after so token counts are identical.

## Inspect the final diff

The final diff should mostly be:

```text
src/index.ts
src/index.test.ts
src/token-burden-command.ts
src/token-burden-command.test.ts
```

Question any unrelated change.

There should be no:

```text
new dependency
tokenizer change
UI redesign
skill-discovery rewrite
Source Trace rewrite
background preload
custom module cache
```

## Commit

Use:

```bash
git add -A
git commit -m "perf: lazy-load token burden command"
```

Do not open the upstream PR yet unless explicitly asked.

## Handoff result

Return a compact result containing:

```text
Commit SHA
Files changed
pnpm run check result
Manual /token-burden result
Before/after startup timing
Any known caveat
```

## Acceptance

The task is complete only when the code is green and the startup timing demonstrates a material improvement.
