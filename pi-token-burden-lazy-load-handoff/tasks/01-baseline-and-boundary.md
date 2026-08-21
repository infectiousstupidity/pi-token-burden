# Task 01: Baseline startup cost and lock the boundary

## Objective

Measure the current startup penalty before changing code and identify exactly what the startup path is allowed to do.

Do not implement lazy loading yet.

## Read

```text
AGENTS.md
CONTEXT.md
architecture/Token Budget Pipeline.md
src/index.ts
src/parser.ts
src/report-view.ts
src/skills.ts
src/index.test.ts
package.json
scripts/check.sh
```

Also read upstream issue:

```text
Whamp/pi-token-burden#33
```

## Work

1. Create `perf/lazy-load` from the intended clean base.
2. Install dependencies if needed.
3. Run the existing focused tests so the branch starts green.
4. Measure Pi startup with Token Burden in its current eager-loading state.
5. Record the import graph that is pulled in by `src/index.ts`.
6. Confirm that `parser.ts` loads `gpt-tokenizer` at module evaluation time.
7. Confirm no product behavior requires parsing, skill discovery, Source Trace, or report UI during mere extension registration.

Use:

```bash
PI_TIMING=1 pi
```

Run at least 10 fresh processes when practical. Keep the environment constant.

Record:

```text
baseline median:
baseline min:
baseline max:
Token Burden timing line(s):
machine/runtime notes:
```

If automating the runs requires a Pi flag, check `pi --help` first. Do not guess a flag.

## Deliverable

Add a short temporary implementation note to your working log or task output. Do not add benchmark noise to product docs unless there is already a suitable engineering document.

The note must state:

```text
Current startup boundary:
src/index.ts evaluates heavy feature modules before /token-burden is used.

Required new boundary:
src/index.ts registers the command only.
Heavy feature modules load on first command invocation.
```

## Acceptance

- baseline is captured;
- current tests are green;
- root cause is confirmed from code, not assumed;
- no production behavior has been changed.

## Stop condition

If startup timing does not show a meaningful Token Burden cost on this machine, do not abandon the task. Continue only after documenting the discrepancy and verifying whether Pi's timing output or extension loading has changed since issue #33.
