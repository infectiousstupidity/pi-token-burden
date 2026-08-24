# Task 07: Defer optional tool drilldown accounting

## Outcome

Opening the main `/token-burden` report should compute only the current active tool burden for the current provider envelope. It must not eagerly serialize/tokenize inactive tool counterfactuals or every alternative provider envelope merely because those drilldowns are available.

Create exactly one commit:

```text
perf: defer tool drilldown accounting
```

## Read first

```text
AGENTS.md
CONTEXT.md
docs/agents/domain.md
architecture/Token Budget Pipeline.md
src/parser.ts
src/parser.test.ts
src/measureTokenBudget.ts
src/runTokenBurden.ts
src/report-view.ts
src/report-view.test.ts
src/types.ts
```

Inspect the current tool-detail interaction before choosing a lazy seam. Read upstream `Whamp/pi-token-burden#32` only to preserve its distinction between counted active burden and non-counted inactive/counterfactual information. Do not implement its full taxonomy in this slice.

## Problem to verify

The full command path has historically built and tokenized all of these before the user opens tool detail:

- active tool entries;
- inactive tool entries;
- current provider envelope;
- compact envelope;
- OpenAI Responses envelope;
- OpenAI Chat envelope;
- Anthropic envelope;
- Bedrock envelope;
- Google envelope;
- Mistral envelope.

Only the active tools serialized for the current model/provider contribute to current burden. The rest are informational/counterfactual views.

Verify current code after slices 01–06.

## Required behavior

### Initial report

Before first render, compute only what is required for the current counted tool section:

- active tool membership;
- current model/provider envelope;
- exact current-envelope token total;
- any active-tool detail already required by the initial visible report.

Do not build inactive schema detail or alternate-envelope variants before a user action needs them.

### Lazy detail

Create a small demand-driven seam for optional tool detail. Depending on the current UI, this may be one or two lazy providers, for example:

```text
load inactive tool counterfactuals
load provider envelope variants
```

Do not expose a generalized plugin/data-loader framework.

Requirements:

- optional detail computes at most once per unchanged report/session state;
- active current-envelope total remains available immediately;
- inactive tools remain non-counted;
- alternate envelopes remain informational and do not change `totalTokens`;
- provider-specific serialization remains exactly the same as before;
- schema content shown to the user is unchanged;
- changing model/provider/tool state before a new report produces fresh detail rather than stale cached variants.

If the current report opens directly into a tool section that visibly needs some per-active-tool rows, keep those rows eager. The target is to defer **optional** work, not to make navigation awkward or introduce loading states for trivial data.

## Scope boundary

Do not:

- change which tools are active;
- change provider-envelope formats;
- change current-burden token totals;
- fold inactive tools into counted totals;
- implement source grouping/semantic kinds/recursive taxonomy from issue #32;
- redesign the report UI beyond a minimal loading/error state if one is required;
- change skill handling or Source Trace;
- add dependencies.

## Required tests

Add tests that observe when serialization/tokenization work occurs.

At minimum prove:

1. Initial `/token-burden` report computes current active-envelope burden.
2. Initial report does not build inactive tool entries.
3. Initial report does not build/tokenize alternative envelope variants.
4. Opening inactive-tool detail computes the inactive counterfactual once.
5. Opening envelope comparison computes variants once.
6. Reopening the same detail reuses unchanged detail.
7. Current total is identical before and after optional detail is loaded.
8. Inactive tools never affect current counted total.
9. All provider envelope variants still match existing expected serialization/token counts.
10. Empty/no-inactive-tool cases remain simple and correct.

Prefer instrumenting a narrow pure builder/provider seam rather than globally spying on `JSON.stringify`.

## Validation

Run focused parser/report/tool tests, then:

```bash
pnpm run check
```

Also run when available:

```bash
pnpm run test:e2e
pi -e ./src/index.ts
```

Manual check:

1. open `/token-burden` and inspect current tool total;
2. open active tool schema detail;
3. open inactive-tool detail;
4. open provider-envelope comparison;
5. return to overview and confirm totals did not change;
6. repeat detail navigation to confirm no visible regression.

## Performance evidence

Use structural counters or a local benchmark with representative catalogs such as:

```text
25 active / 25 inactive tools
25 active / 100 inactive tools
100 active / 150 inactive tools
```

Show that first report render no longer pays for inactive schema tokenization or all alternate envelopes. Do not count deferred work as eliminated; report clearly that it moved to the user action that requests it.

## Acceptance

- initial report computes only current counted tool burden plus immediately visible active detail;
- inactive and alternate-envelope work is demand-driven;
- current totals and schema serialization are unchanged;
- optional detail is cached only for the lifetime/state where it remains valid;
- no taxonomy/UI redesign or new dependency was introduced;
- focused tests, `pnpm run check`, and relevant e2e/manual checks pass;
- one clean commit with the required subject exists.
