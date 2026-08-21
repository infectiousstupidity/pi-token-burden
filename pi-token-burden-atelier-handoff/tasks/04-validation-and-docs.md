# Task 04: Validate in Pi and document the optional integration

## Objective

Prove the feature works in the real TUI, keep the package clean, and document the optional Pi Atelier integration.

Do not begin the lazy-loading performance work here.

## Full automated verification

Run the repository's required gate:

```bash
pnpm run check
```

Per `AGENTS.md`, this is required before committing user-visible extension changes.

If tmux is available, also run:

```bash
pnpm run test:e2e
```

Do not hide unrelated failures. If a baseline failure exists, record the exact command/output and distinguish it from feature failures.

## Manual TUI verification

Test with Pi Atelier available.

If Atelier is already installed in Pi, from the Token Burden checkout run:

```bash
pi -e ./src/index.ts
```

If you instead have a sibling local Pi Atelier checkout, load both local extensions using Pi's normal `-e` package/path mechanism.

Verify:

1. Pi starts normally.
2. `/token-burden` still opens the full overlay.
3. Open `/atelier` → display/sidebar settings.
4. Confirm `Token burden` appears as a contributed panel.
5. Enable it and place it where desired.
6. Confirm the sidebar shows the total and section rows.
7. Send a prompt and confirm the panel refreshes without flicker/error.
8. Change model and confirm context percentage/tool-envelope-dependent values refresh.
9. Start/reload a session and confirm the panel returns.
10. Run Pi without Atelier and confirm Token Burden still behaves normally.

Capture one representative panel output in the implementation handoff.

## Load-order check

Explicitly test both practical orders if possible:

```text
Atelier loaded first → Token Burden still appears
Token Burden loaded first → Atelier discovery still finds it
```

This is the main reason for implementing discovery replay.

## README

Add a short optional-integration section. Keep it factual and brief.

Suggested content:

```markdown
### Pi Atelier sidebar

If [Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier) is installed, Token Burden can publish a compact read-only budget summary to its sidebar. Enable and position the `Token burden` panel from Atelier's display settings.

The `/token-burden` command remains the full interactive view. Pi Atelier is optional and is not a dependency of this package.
```

Adjust wording to match the final implementation.

Do not add a dependency or installation requirement for Atelier.

## Package sanity

Confirm package tests still pass and any new production source file is included by the existing `src/` package files rule.

No new generated artifacts should be committed.

## Performance sanity for this branch

This branch is not expected to solve upstream issue #33.

Verify only that the feature does not do Token Budget measurement when no Atelier discovery has occurred. This should be covered by unit tests.

Do not make performance claims without measurement.

## Final output to reviewer

Provide:

```text
Branch: feature/atelier-sidebar
Base: 46146112e275fe0d71c8eb1bef76f68c27e68ac8
Final SHA: <sha>

Automated:
- <focused tests>: PASS
- pnpm run check: PASS
- pnpm run test:e2e: PASS / not run + reason

Manual:
- /token-burden overlay: PASS
- Atelier panel discovery: PASS
- panel refresh after prompt: PASS
- model switch refresh: PASS
- no-Atelier behavior: PASS
- both load orders: PASS

Observed panel:
<copy representative rows>

Known limitations:
<none or concise list>

Deferred:
- startup/lazy-loading issue #33 remains for separate perf branch
```

## Completion condition

Do not call the feature done until `pnpm run check` passes and the panel has been exercised in a real Pi TUI with Atelier.

Suggested final docs commit if needed:

```text
docs: document Atelier sidebar integration
```
