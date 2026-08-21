# Task 03: Wire the live Token Burden sidebar

## Objective

Connect the shared Token Budget Pipeline to the Atelier publisher and produce a compact read-only sidebar summary.

## Performance rule

Do not measure sidebar token burden until Atelier has actually been detected through a valid `discover` event.

This is required. Token Burden already has an open startup-time problem. The sidebar feature must not add measurement work for users who do not use Atelier.

```text
No Atelier discovery
      ↓
No sidebar measurement

Atelier discovery seen
      ↓
Measure + publish
      ↓
Refresh only on relevant lifecycle events
```

## Sidebar row builder

Add a pure formatter, ideally in `src/atelier-sidebar.ts` unless a separate module is clearly simpler.

Input should be approximately:

```ts
{
  parsed: ParsedPrompt,
  contextWindow?: number,
}
```

Output should be Atelier row data.

Target output:

```text
12.4k / 131k (9.5%)
Base prompt 5.1k
Context files 3.0k
Skills 2.1k
Tool definitions 1.9k
Metadata 0.3k
```

Requirements:

- first row is the total;
- include context-window percentage when known and positive;
- otherwise use `<total> tokens`;
- top-level Budget Sections are sorted by tokens descending;
- keep the complete panel to 6-8 rows maximum;
- combine overflow sections into `Other` if needed;
- use compact deterministic token formatting (`950`, `1.2k`, `12.4k`, etc.);
- no ANSI escape sequences;
- no width-dependent padding that assumes a particular terminal width.

Do not invent new token categories. Use existing top-level sections.

## Lifecycle wiring

Wire the publisher from `src/index.ts`.

Maintain only the minimum state required:

- current session context if needed;
- whether Atelier has been discovered;
- latest exact prompt when available.

Refresh on these events:

### `session_start`

Store the new session context. If Atelier is already known to be present, publish a fresh snapshot using `ctx.getSystemPrompt()`.

If Atelier is not known, do not run Token Budget measurement.

### Atelier `discover`

Mark Atelier as present. If a session context is available, calculate and publish the current snapshot. The publisher then responds/replays registration.

Be careful about ordering. The implementation must work whether Token Burden or Atelier receives `session_start` first.

### `before_agent_start`

If Atelier is present, refresh from `event.systemPrompt`. This event gives the exact assembled prompt for the run and should be preferred over a stale cached prompt.

### `model_select`

If Atelier is present and a session context is available, refresh. A model/provider change can alter:

- context window;
- provider-specific tool-envelope accounting.

Do not refresh on `message_update`, `tool_execution_update`, or every token.

## Context window

Use the same fallback order as the existing command where possible:

```text
ctx.getContextUsage()?.contextWindow
        ↓ fallback
ctx.model?.contextWindow
```

Treat missing/zero context window as unknown rather than producing an invalid percentage.

## Existing command

`/token-burden` must continue to work without Atelier and must still open the full report overlay.

Do not route the command through the sidebar. They are separate presentation surfaces over the same measurement result.

## Tests

Extend `src/index.test.ts` and `src/atelier-sidebar.test.ts` as appropriate.

Required cases:

1. No Atelier discovery: session/lifecycle events do not run sidebar measurement.
2. Discovery causes the current session to publish a panel.
3. Discovery works regardless of load/event order.
4. `before_agent_start` uses `event.systemPrompt` for refresh.
5. `model_select` triggers a refresh only after Atelier has been detected.
6. Existing `/token-burden` command behavior remains intact.
7. Formatting tests cover known and unknown context windows.
8. Formatting tests cover section sorting and overflow into `Other`.

Run focused tests first, then:

```bash
pnpm run test
```

## Completion condition

The integration is fully wired, no-Atelier operation does no sidebar measurement, and unit tests pass.

Suggested commit:

```text
feat: show token burden in Atelier sidebar
```
