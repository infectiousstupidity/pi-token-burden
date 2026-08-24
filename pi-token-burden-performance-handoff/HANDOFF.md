# Handoff: runtime optimization slices 1–7

## Goal

Make Token Burden a passive observer: when Pi is running normally, Token Burden should add effectively no work to the active agent path; when the sidebar or `/token-burden` needs data, perform only the minimum work required for the view the user actually opened.

Implement the seven slices in `tasks/` strictly in order. **Each slice is exactly one commit.** Do not combine slices, create cleanup commits, or start the next slice while the current slice is failing validation.

This handoff was prepared against fork `main` at `b533f4f927688e31425cc4e7b10f8d46bb9cbc7d`. The working branch may start from a newer `main`; always inspect current code before editing and adapt to the live repository rather than assuming line numbers or exact shapes in these docs are unchanged.

## Prompting model

These instructions follow the GPT-5.6 prompting guidance:

https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6#prompting-best-practices

The important rules for this workflow are:

- keep instructions lean and state each rule once;
- define the outcome, hard constraints, evidence, and success criteria;
- allow safe local autonomy instead of asking for approval for normal inspection, edits, and tests;
- stop before external writes, destructive actions, dependency additions, lint-rule changes, or material scope expansion;
- judge optimization by measured behavior and preserved correctness, not by fewer lines or fewer calls alone.

## Orchestrator contract

The orchestrator owns sequence, isolation, and verification. It should not implement the slices itself unless no subagent mechanism is available.

### Start

1. Read `AGENTS.md`, `CONTEXT.md`, `docs/agents/domain.md`, this file, and the current task document.
2. Create one working branch from current fork `main`, suggested name:

```text
perf/passive-token-burden
```

3. Confirm the branch starts clean and the repository's existing test gate is green enough to distinguish new failures from baseline failures.

Do not load all seven task documents into every subagent. Give each fresh subagent this handoff plus **only its current task document**. The current git tree and commit history are the handoff between slices.

### For each slice

For slice `NN`:

1. Record `git rev-parse HEAD` before delegation.
2. Spawn a fresh implementation subagent with:
   - this `HANDOFF.md`;
   - `tasks/NN-*.md`;
   - permission to inspect and modify in-scope local files, run non-destructive commands/tests, and create the one required commit;
   - no permission for GitHub writes, dependency additions, lint-rule changes, destructive actions, or unrelated refactors.
3. Tell the subagent to inspect current code and nearest tests before choosing the smallest implementation.
4. Require focused tests during implementation and `pnpm run check` before committing. Run `pnpm run test:e2e` and/or manual `pi -e ./src/index.ts` when the task document requires it.
5. The subagent must leave a clean working tree and create exactly one commit with the task's required subject.
6. Verify after delegation:

```bash
git status --short
git log --oneline <old-head>..HEAD
```

There must be exactly one new commit and no uncommitted changes.
7. Review the diff against the task's scope and acceptance criteria. If the slice is incomplete, send the same slice back for repair **before** moving on. Amend the slice commit rather than adding a follow-up commit.
8. Only after the slice is green, proceed to the next task.

### Blocking rule

Follow repository `AGENTS.md` 1-3-1 when there is a genuine architectural or requirements blocker: state one problem, three bounded options, and one recommendation, then stop for user input.

Do **not** treat ordinary implementation choices as blockers. The subagent should decide locally when the choice stays within the task's stated outcome and constraints.

## Global constraints

These apply to all seven slices.

- Preserve model-facing token accounting unless a task explicitly changes how reconciliation is represented.
- Preserve the existing lazy startup boundary. Do not reintroduce unconditional tokenizer, YAML, report, skill-scan, or Source Trace loading during extension registration.
- Do not add dependencies.
- Do not change lint rules.
- Do not register new shell-executing tools.
- Do not redesign the TUI or implement the Combined Token Burden taxonomy from upstream issue `Whamp/pi-token-burden#32` unless a task explicitly needs a narrow compatibility seam.
- Do not mix Atelier feature work into generic optimization code. Atelier may consume optimized measurement APIs, but performance primitives must remain usable without Atelier.
- Prefer deleting duplicated work over adding caches, workers, schedulers, abstractions, or background machinery.
- Keep APIs boring and local. Add an abstraction only when it removes repeated work or establishes a testable boundary needed by the slice.
- No new benchmark framework. Use existing tests and small local instrumentation/Node timing when evidence is needed.

## Slice order

| Slice | Outcome | Required commit |
| --- | --- | --- |
| 01 | Sidebar measurement runs only while the agent is settled/idle | `perf: defer sidebar measurement until agent settles` |
| 02 | Cache identity reflects semantic measurement inputs, not object identity/order accidents | `perf: harden sidebar measurement cache key` |
| 03 | System-prompt accounting stops repeatedly tokenizing large overlapping prefixes | `perf: reduce repeated prompt tokenization` |
| 04 | Summary measurement avoids unnecessary strings, arrays, slices, and pretty JSON | `perf: reduce summary measurement allocations` |
| 05 | `/token-burden` defers Source Trace and exits headless before heavy imports/work | `perf: lazy-load optional command analysis` |
| 06 | Main report opens without recursive skill discovery; full skill inventory loads only on demand | `perf: defer skill inventory discovery` |
| 07 | Main report does not eagerly build inactive/counterfactual and alternate-envelope tool drilldowns | `perf: defer tool drilldown accounting` |

## Cross-slice invariants

After every commit:

1. Extension registration remains cheap and does not eagerly evaluate heavy measurement/report modules.
2. Sidebar totals remain correct for the current system prompt, active tools, and provider envelope.
3. `/token-burden` continues to open and show the same current-burden totals.
4. Inactive tools never contribute to current counted burden.
5. Optional detail work happens only after the corresponding user action needs it.
6. No optimization runs synchronous tokenizer or filesystem work in the active agent-generation path unless Pi itself explicitly requires it for the current request.

## Evidence expected from each subagent

Return a compact completion report containing:

```text
commit: <sha> <subject>
changed: <files>
behavior: <what work moved/was removed>
tests: <focused tests + pnpm run check + task-specific checks>
performance evidence: <measurement or structural proof relevant to this slice>
remaining caveat: <only if material>
```

Do not write this report into the repository unless the task explicitly asks for a durable document.

## Final verification after slice 07

The orchestrator performs validation only; do not create an eighth implementation commit.

Run:

```bash
pnpm run check
pnpm run test:e2e
```

When a local interactive Pi environment is available, also run:

```bash
pi -e ./src/index.ts
```

Exercise:

- startup before any Token Burden use;
- Atelier sidebar discovery/base-session display if Atelier is installed;
- a normal prompt and tool loop;
- `/token-burden` first open;
- tool drilldown and alternate-envelope/inactive-tool detail;
- Skill Management entry;
- Source Trace entry;
- second `/token-burden` open in the same process.

The final history should contain the seven ordered slice commits, one per task, on top of the chosen branch base.

## Definition of done

The optimization series is complete when all seven task acceptance criteria pass, the final validation is green, and the resulting architecture has this behavior:

```text
Pi startup                -> tiny registration/bootstrap only
active agent generation   -> no Token Burden measurement work
agent settled / idle      -> cached lightweight sidebar refresh when needed
/token-burden overview    -> current budget with no optional deep work
user opens optional view  -> only that view's additional work is loaded/computed
```
