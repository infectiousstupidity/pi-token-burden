# Task 03: Reduce repeated system-prompt tokenization

## Outcome

A single system-prompt parse must stop repeatedly BPE-tokenizing large overlapping prefixes of the same prompt.

Keep the full-prompt token total authoritative and preserve auditable section accounting. Optimize the accounting algorithm, not the tokenizer choice.

Create exactly one commit:

```text
perf: reduce repeated prompt tokenization
```

## Read first

```text
AGENTS.md
CONTEXT.md
docs/agents/domain.md
architecture/Token Budget Pipeline.md
src/parser.ts
src/parser.test.ts
src/parser-summary.test.ts
src/measureTokenBudget.ts
```

Also inspect the installed `gpt-tokenizer` API/source before choosing an implementation. Confirm whether the current version exposes a reliable way to attribute one encoding pass to source-character spans. Do not assume an offset API exists.

Read upstream `Whamp/pi-token-burden#32` only for the established accounting concept of explicit prompt-boundary reconciliation. Do not implement that issue's full taxonomy in this slice.

## Problem to verify

The current parser has used prefix accounting equivalent to:

```text
section tokens = tokens(prompt[0:end]) - tokens(prompt[0:start])
```

with a cache for repeated boundary positions. This preserves whole-prompt BPE behavior but still tokenizes multiple increasingly large prefixes. As prompt size grows, total tokenizer input can become several times the prompt size.

Measure/inspect the current implementation before changing it.

## Required behavior

Choose the smallest correct algorithm that materially reduces overlapping-prefix work.

Preferred order:

1. If the installed tokenizer provides a reliable, testable single-pass span/offset mechanism, use it.
2. Otherwise measure disjoint prompt spans independently and reconcile their sum to the authoritative full-prompt count with an explicit, narrowly scoped boundary-overhead value **only if the current data model/report can represent that honestly without a broad UI/taxonomy rewrite**.
3. If neither is possible without changing accounting semantics or implementing a large part of issue #32, use repository 1-3-1 and stop. Do not hide the difference by silently assigning boundary tokens to an unrelated section.

Hard requirements:

- `totalTokens` remains the token count of the exact full assembled prompt;
- section accounting remains deterministic and testable;
- no token difference is silently discarded;
- do not claim independently tokenized spans are exactly additive when BPE boundaries make them non-additive;
- existing detailed child reconciliation remains correct;
- the summary and full parser agree on top-level counted totals.

A signed reconciliation value is acceptable only if existing rendering/math handles it correctly or is narrowly adapted and tested. Do not introduce misleading negative bars/percentages.

## Scope boundary

Do not:

- change `o200k_base` to another tokenizer/encoding;
- add a tokenizer dependency, native binding, worker, or subprocess;
- change tool-schema token accounting;
- optimize pretty JSON or summary allocations; slice 04 owns that;
- implement semantic kinds, recursive surfaces, or the full Combined Token Burden taxonomy;
- change Source Trace attribution.

## Tests and evidence

Keep all existing token-accounting tests green and add coverage that proves:

1. Full-prompt `totalTokens` exactly matches direct tokenizer count of the same prompt.
2. Top-level accounted sections plus any explicit reconciliation equal `totalTokens`.
3. Prompts with Base + custom system + context + skills + metadata reconcile.
4. Prompts with missing optional regions reconcile.
5. Boundary-sensitive text is covered so the test would catch naive `sum(countTokens(section))` assumptions.
6. `details: false` and full detail return the same top-level total.

Add a focused performance/structural test or local benchmark that records how many total input characters are passed through the tokenizer for representative large prompts. The new path should remove the previous repeated large-prefix pattern.

Do not make a fragile wall-clock test part of the normal suite. Prefer instrumentation around the token-count function or a small benchmark run reported in the task result.

Suggested representative sizes:

```text
10k chars
50k chars
100k chars
200k chars
```

Report before/after tokenizer-input work or median timing on the same machine. Treat timing as supporting evidence; accounting correctness is mandatory.

## Validation

Run focused parser tests, then:

```bash
pnpm run check
```

Run `/token-burden` manually if the visible accounting rows change in any way.

## Acceptance

- repeated large overlapping-prefix encoding is materially reduced or eliminated;
- exact full-prompt total remains authoritative;
- all boundary differences are explicitly reconciled rather than hidden;
- no full taxonomy redesign or new dependency was introduced;
- focused tests and `pnpm run check` pass;
- performance evidence demonstrates less tokenizer work;
- one clean commit with the required subject exists.
