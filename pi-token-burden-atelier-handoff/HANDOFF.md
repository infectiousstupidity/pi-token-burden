# Handoff: Pi Atelier sidebar integration

## Goal

Add an optional Pi Atelier sidebar panel to `pi-token-burden` so the normal token-budget summary is visible at a glance without opening `/token-burden`.

Target branch: `feature/atelier-sidebar`

Repository: `infectiousstupidity/pi-token-burden`

Base commit at handoff: `46146112e275fe0d71c8eb1bef76f68c27e68ac8`

Pi Atelier target: v0.8.2 / sidebar protocol v1 as implemented at `michaelmjhhhh/pi-atelier@159f34cf440c18cba847999a191b252b4574b57d`.

## Read first

Follow the repository instructions before editing:

1. `AGENTS.md`
2. `docs/agents/domain.md`
3. `CONTEXT.md`
4. `architecture/Token Budget Pipeline.md`
5. Relevant tests beside the code you change.

Do not rename existing product/domain concepts as part of this feature. Keep the change focused.

## Desired result

With both extensions installed:

```text
Pi Token Burden
      │
      │ publishes summary through Pi's event bus
      ▼
Pi Atelier
      │
      ▼
╭─ TOKEN BURDEN ─────────────╮
│ 12.4k / 131k (9.5%)        │
│ Base prompt 5.1k           │
│ Context files 3.0k         │
│ Skills 2.1k                │
│ Tool definitions 1.9k      │
│ Metadata 0.3k              │
╰────────────────────────────╯
```

The exact numbers and existing section labels must come from Token Burden's existing Token Budget Pipeline. Do not implement a second token-counting path.

`/token-burden` remains the detailed interactive inspector. The sidebar is only a compact read-only summary.

## Integration contract

Pi Atelier already exposes a versioned public event-bus protocol for third-party sidebar panels.

Use these protocol values:

```ts
const CHANNEL = "pi-atelier:sidebar-panels";
const VERSION = 1;
const SOURCE = "pi-token-burden";
const PANEL_ID = "token-burden:budget";
```

A registration event has this shape:

```ts
{
  version: 1,
  type: "register",
  source: "pi-token-burden",
  revision: 1,
  panel: {
    id: "token-burden:budget",
    title: "Token burden",
    rows: [
      { text: "12.4k / 131k (9.5%)", role: "context" },
      { text: "Base prompt 5.1k" },
    ],
  },
  requestId?: "...",
}
```

Atelier sends a `discover` event on the same channel. Token Burden must replay its current registration when it receives discovery so load order does not matter.

Do not add `pi-atelier` as a dependency. The event protocol is the compatibility seam. Token Burden must continue to work normally when Atelier is absent.

## Important performance boundary

Do not fix the existing startup-time issue in this branch. That is a separate follow-up for upstream issue #33.

However, do not make the problem worse:

- Do not run sidebar token measurement if Atelier has not been detected.
- Detect Atelier by receiving its `discover` event.
- Do not add another eager heavyweight import just for sidebar support.
- Structure shared budget measurement so the later lazy-loading work can move it behind `import()` without rewriting this feature.

The current eager imports may remain in this branch. The later `perf/lazy-load` branch will address them.

## Refresh behavior

The panel should be refreshed only when it can become stale:

- when an Atelier discovery request proves Atelier is present;
- on `session_start` once Atelier is known to be present;
- on `before_agent_start`, using `event.systemPrompt` as the exact current prompt;
- on `model_select`, because the provider/model can change tool-envelope accounting and the context window.

Do not refresh on every streamed token, message update, or tool execution.

If implementation details show that one of the events above is redundant, prefer fewer refreshes and prove correctness with tests.

## Sidebar contents

Keep the panel compact. Target 6-8 rows maximum even though Atelier accepts up to 24.

Recommended rows:

1. Total Token Burden tokens, context window, and percentage when a context window is known.
2. Top-level Budget Sections, sorted by token count descending.
3. If there are more sections than fit, combine the remainder into one `Other` row rather than overflowing the sidebar.

Examples:

```text
12.4k / 131k (9.5%)
Base prompt 5.1k
Context files 3.0k
Skills 2.1k
Tool definitions 1.9k
Metadata 0.3k
```

If the context window is unavailable:

```text
12.4k tokens
```

Formatting must be deterministic and unit tested. Avoid terminal ANSI sequences; Atelier handles presentation and sanitization.

## Constraints

- No new runtime dependency.
- No network access.
- No writes to user/project files for the sidebar feature.
- No changes to skill toggling behavior.
- No changes to Source Trace behavior.
- No changes to `/token-burden` interaction or keyboard behavior.
- No Pi Atelier source changes in this branch.
- No startup-performance refactor in this branch.
- Keep TypeScript free of `any` in new code, per `AGENTS.md`.

## Acceptance criteria

The feature is done when all of these are true:

- Token Burden works exactly as before when Atelier is not installed.
- With Atelier installed, a `token-burden:budget` panel is discovered regardless of extension load order.
- The panel can be enabled/reordered from Atelier's sidebar settings.
- The panel shows the same total and section counts used by `/token-burden`.
- The panel updates after session changes and before a new agent run when the effective prompt changes.
- Model changes update context-window/provider-envelope-dependent values.
- No sidebar measurement runs before Atelier is detected.
- Existing `/token-burden` tests remain green.
- New unit tests cover protocol discovery, revisions, formatting, no-Atelier behavior, and refresh wiring.
- `pnpm run check` passes.
- Manual TUI test with both extensions passes.

## Suggested implementation shape

Keep this small. A reasonable shape is:

```text
src/
├─ index.ts                    existing entrypoint
├─ token-budget.ts             small shared measurement helper
├─ atelier-sidebar.ts          protocol publisher + row formatting
├─ atelier-sidebar.test.ts
└─ index.test.ts               lifecycle/integration coverage
```

Names can differ if the existing code suggests something simpler. Do not create extra abstraction layers.

The key dependency direction should stay simple:

```text
index.ts
  ├─ Token Budget Pipeline helper
  ├─ /token-burden overlay
  └─ Atelier sidebar publisher

atelier-sidebar.ts
  └─ Pi event bus only
```

`atelier-sidebar.ts` should not import Pi Atelier itself.

## Work order

Execute the task slices in order:

1. `tasks/01-shared-budget-measurement.md`
2. `tasks/02-atelier-protocol-publisher.md`
3. `tasks/03-wire-live-sidebar.md`
4. `tasks/04-validation-and-docs.md`

Each slice should leave the repository green before moving to the next one.

## Final handoff from implementing agent

Return:

- branch name and final commit SHA;
- files changed;
- focused test commands and results;
- `pnpm run check` result;
- manual Pi/Atelier test steps and observed panel output;
- any known limitation;
- confirmation that issue #33/lazy loading was not mixed into this branch.
