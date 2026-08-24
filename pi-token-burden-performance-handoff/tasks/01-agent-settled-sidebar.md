# Task 01: Move sidebar measurement to the settled/idle path

## Outcome

The live Atelier sidebar must not tokenize or otherwise perform Token Burden measurement while Pi is actively generating, retrying, compacting, or continuing a tool loop.

`before_agent_start` may capture the exact assembled prompt and cheap metadata. Actual measurement should happen after Pi reaches its settled/idle lifecycle point.

Create exactly one commit:

```text
perf: defer sidebar measurement until agent settles
```

## Read first

```text
AGENTS.md
CONTEXT.md
docs/agents/domain.md
src/index.ts
src/index.test.ts
src/measureTokenBudget.ts
src/atelier-sidebar.ts
```

Also inspect current Pi extension-event documentation/types for `before_agent_start`, `agent_end`, `agent_settled`, `message_start`, and `message_end`. Do not rely on the event behavior described in this task if the installed/current Pi API has changed.

## Current problem to verify

The fork already avoids doing heavy work directly inside `before_agent_start`, but the current sidebar refresh is triggered from assistant message lifecycle events. A deferred `setTimeout(..., 0)` is still synchronous tokenizer work on the same JS event loop once it runs, so it can compete with streaming or automatic continuation.

Confirm the current implementation before changing it.

## Required behavior

Use Pi's current settled/idle lifecycle seam as the normal post-run measurement trigger. On current Pi this is expected to be `agent_settled`.

Preserve these properties:

- `before_agent_start` captures the exact chained `event.systemPrompt` needed for the eventual measurement;
- no tokenizer module is loaded and no measurement is run merely because `before_agent_start`, assistant `message_start`, or assistant `message_end` fired;
- once the agent settles, the most recent pending prompt is measured at most once;
- repeated/automatic runs do not create a queue of stale measurements;
- startup/pre-first-prompt sidebar measurement still works while Pi is idle;
- discovery after session start still works;
- model changes still invalidate/recompute when needed, but not by pushing work into an active generation window;
- lazy loading of `measureTokenBudget` remains intact.

If the repository intentionally supports a Pi version without `agent_settled`, preserve compatibility only with a small fallback that still avoids active-generation measurement. Do not build a version-detection framework.

## Scope boundary

Do not change:

- cache identity rules beyond what is necessary for lifecycle correctness; slice 02 owns cache-key hardening;
- parser/tokenization algorithms;
- summary allocation behavior;
- `/token-burden` command loading;
- skill discovery;
- tool drilldown accounting;
- Atelier protocol/schema.

## Tests

Update/add focused lifecycle tests that prove behavior rather than implementation details.

At minimum cover:

1. `before_agent_start` stores the exact assembled prompt but does not measure.
2. Assistant `message_start` and `message_end` do not cause measurement during the active run.
3. `agent_settled` performs the pending measurement.
4. Multiple prompt/run events before settling coalesce to the latest relevant pending state rather than measuring stale snapshots.
5. Session-start/pre-prompt sidebar display remains functional while idle.
6. Existing unchanged-measurement caching behavior still works.

Use spies/sentinels around the measurement module so the tests can distinguish "no measurement work" from "measurement returned quickly."

## Validation

Run focused tests while working, then:

```bash
pnpm run check
```

Because this changes extension lifecycle behavior, also run when available:

```bash
pnpm run test:e2e
pi -e ./src/index.ts
```

Manual check: submit a prompt that produces a tool loop or multi-step response and confirm the sidebar refresh happens after Pi settles, not at assistant stream start.

## Performance evidence

The strongest evidence is structural: instrumentation/spies should show zero calls into Token Burden measurement between the captured `before_agent_start` state and `agent_settled`.

If convenient, add temporary local timing/log instrumentation while validating, but do not commit debug output.

## Acceptance

- active agent generation performs no Token Burden tokenization/measurement;
- latest sidebar data appears after the run settles;
- pre-first-prompt sidebar behavior is preserved;
- no stale refresh queue is introduced;
- focused tests and `pnpm run check` pass;
- one clean commit with the required subject exists.
