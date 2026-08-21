---
tags:
  - architecture
  - pi-token-burden
---

# Token Budget Pipeline

## Purpose

`pi-token-burden` shows a token-budget breakdown of the assembled pi system prompt so users can see where context-window capacity is spent.

## Architecture

The entrypoint is startup-safe: it registers the command and the Atelier sidebar listener without loading any heavy module. Everything measurement- and UI-related is dynamically imported on first real use.

```text
Startup-safe (evaluated at pi startup)
index.ts
└──→ atelier-sidebar.ts ──→ utils.ts ──→ types.ts

Heavy (dynamic import on first use)
runTokenBurden.ts
├──→ measureTokenBudget.ts ──→ parser.ts ──→ types.ts
├──→ report-view.ts ──→ utils.ts, source-trace-report-cache.ts
├──→ skills.ts, skill-visibility-store.ts, saveSkillToggleResult.ts
└──→ base-trace/ ──→ attribution.ts, extractBaseLines.ts, extractContributions.ts
```

## Data flow

1. `src/index.ts` registers `/token-burden` and subscribes the Atelier sidebar listener. It performs no measurement and no filesystem scanning.
2. On the first `/token-burden` invocation, `src/runTokenBurden.ts` is dynamically imported (ES module caching makes later invocations free).
3. `src/runTokenBurden.ts` asks pi for the assembled prompt with `ctx.getSystemPrompt()` and delegates to `src/measureTokenBudget.ts`.
4. `src/measureTokenBudget.ts` parses the prompt into sections (`src/parser.ts`, `gpt-tokenizer` with `o200k_base`) and augments the result with Combined Tool Definitions from `pi.getAllTools()` / `pi.getActiveTools()`.
5. `src/report-view.ts` renders the parsed data in `BudgetOverlay` using a TUI custom overlay.
6. `src/utils.ts` supports fuzzy filtering and proportional bar segments.

## Atelier sidebar flow

`src/atelier-sidebar.ts` (startup-safe) listens for `discover` events on the `pi-atelier:sidebar-panels` channel. When Atelier requests panels — or on `session_start` / `before_agent_start` / `model_select` after discovery — `src/index.ts` dynamically imports `src/measureTokenBudget.ts`, measures the current session, and publishes a compact read-only panel. The heavy measurement therefore loads only after Atelier has actually requested data, never at pi startup. An async `onDiscover` defers the `register` event until the deferred measurement settles, and no `register` event is emitted after disposal.

## Source tracing flow

1. `discoverAndLoadExtensions()` loads extension metadata.
2. `extractContributions()` reads prompt snippets and guidelines from loaded extensions.
3. `extractBaseLines()` extracts attributable base-prompt lines.
4. `attributeBasePrompt()` normalizes and matches evidence into buckets.
5. The report is memoized per session in `src/source-trace-report-cache.ts` (explicit refresh supported); the result carries a fingerprint of the loaded extension paths.

Tracing is user-triggered with `t` on the Base prompt so the default overlay stays fast.

## Key modules

- `src/index.ts` — startup-safe extension entry point: command registration and Atelier sidebar listener only; heavy modules load via dynamic import.
- `src/runTokenBurden.ts` — `/token-burden` command implementation, dynamically imported on first use.
- `src/measureTokenBudget.ts` — shared measurement: prompt parsing plus Combined Tool Definitions; used by both the command and the Atelier sidebar.
- `src/atelier-sidebar.ts` — startup-safe Atelier sidebar publisher (discover/register events, compact panel rows).
- `src/parser.ts` — prompt section parser and token estimation.
- `src/parser.ts` — prompt section parser and token estimation.
- `src/report-view.ts` — stateful TUI overlay, keyboard handling, drill-downs, editor handoff, trace mode.
- `src/types.ts` — shared types such as `ParsedPrompt`, `PromptSection`, and `TableItem`.
- `src/enums.ts` — `DisableMode` enum for skill states.
- `src/skills.ts` — filesystem skill discovery matching pi scan order.
- `src/skills-persistence.ts` — settings/frontmatter persistence for skill toggles.
- `src/base-trace/` — attribution subsystem for base-prompt source tracing.
- `src/source-trace-report-cache.ts` — per-session memoization of the Source Trace Report.
- `src/e2e/tmux-harness.ts` — tmux automation for e2e TUI tests.

## Verification

- Unit tests: `pnpm run test`.
- E2e TUI tests: `pnpm run test:e2e`.
- Full gate: `pnpm run check`.
- Manual extension test: `pi -e ./src/index.ts`, then run `/token-burden`.
