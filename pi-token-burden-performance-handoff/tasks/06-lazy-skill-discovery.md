# Task 06: Defer full skill inventory discovery

## Outcome

Opening the main `/token-burden` report must not recursively rediscover every skill from disk. The full editable Skill Management inventory should load only when the user enters the feature that needs it.

Where current Pi public resource/skill APIs can replace duplicated discovery logic with proven behavior parity, prefer them. Do not delete custom logic merely for fewer lines if it changes Skill Visibility State semantics.

Create exactly one commit:

```text
perf: defer skill inventory discovery
```

## Read first

```text
AGENTS.md
CONTEXT.md
docs/agents/domain.md
src/runTokenBurden.ts
src/runTokenBurden.test.ts
src/report-view.ts
src/report-view.test.ts
src/skills.ts
src/skills.test.ts
src/skill-management-session.ts
src/skill-management-session.test.ts
src/skill-visibility-store.ts
```

Also inspect the current installed Pi exports/implementation for skill and resource discovery, including `loadSkills`, `loadSkillsFromDir`, `DefaultResourceLoader`, `SettingsManager`, and any current structured resource data exposed through extension contexts. Use current source as authority.

## Problem to verify

The initial command path has called `loadAllSkills()` before the overlay opens. That path can synchronously:

- recurse through several filesystem roots;
- read ignore files and `SKILL.md` files;
- resolve symlinks/stat paths;
- parse YAML/frontmatter;
- inspect package configuration;
- run `npm root -g` for npm package sources;
- tokenize every discovered skill entry.

Most of that work is needed for Skill Management, not for showing the current model-facing budget already parsed from the assembled prompt.

Verify current behavior after slice 05.

## Required behavior

### Initial report

The main report should render from the already-measured `ParsedPrompt` and other cheap current-session state without calling the full filesystem skill inventory loader.

Visible skill burden already present in the assembled prompt must still appear correctly in the report.

### Skill Management on demand

Introduce the smallest lazy seam needed for Skill Management to request the full inventory on first entry. Examples include an async provider/callback passed to the report or a small lazy cache owned by the command session.

Requirements:

- first entry loads the inventory exactly once for that report/session unless an explicit refresh/save requires reloading;
- repeated navigation does not rescan unchanged filesystem state unnecessarily;
- skill toggle preview/save behavior remains unchanged;
- disabled/hidden/duplicate skill semantics remain unchanged;
- load failure is surfaced in the existing UI style and does not corrupt the base report.

Do not start background discovery immediately after opening the report. "Lazy" means demand-driven.

### Reuse Pi APIs where safe

Compare the custom `src/skills.ts` discovery behavior with current Pi public APIs.

Replace duplicated discovery code only when tests prove parity for the behaviors Token Burden depends on, especially:

- source precedence/deduplication;
- explicit/configured skill paths;
- package-provided skills;
- ignore files;
- `disable-model-invocation` / hidden skills;
- Skill Visibility State patterns and disabled entries;
- duplicate paths/names needed by management UI.

If Pi's public API does not expose enough information to preserve one of those behaviors, keep the narrow custom code for that behavior. State the limitation in the subagent completion report; do not invent a parallel resource-loader abstraction.

## Scope boundary

Do not:

- change Skill Management UX or persistence format;
- change which skills are model-visible;
- change skill token accounting;
- rewrite all of `skills.ts` unless parity is both clear and covered;
- add file watchers, persistent caches, workers, or a database;
- change tool accounting; slice 07 owns tools;
- add dependencies.

## Required tests

Add tests proving demand-driven behavior.

At minimum:

1. Opening the base `/token-burden` report does not call `loadAllSkills`/equivalent full discovery.
2. Entering Skill Management triggers discovery once.
3. Leaving and re-entering reuses the loaded inventory when nothing requires refresh.
4. Existing enabled/hidden/disabled/duplicate handling remains correct.
5. Skill toggle preview and save still use the complete inventory.
6. Discovery failure leaves the base report usable and gives an actionable error.
7. If Pi APIs replace any custom discovery path, parity tests cover the replaced semantics rather than only happy-path loading.

Add a structural spy around discovery and, where useful, `spawnSync` so tests can prove the initial report no longer reaches the `npm root -g` path.

## Validation

Run focused skill/command/report tests, then:

```bash
pnpm run check
```

Also run when available:

```bash
pnpm run test:e2e
pi -e ./src/index.ts
```

Manual check:

1. open `/token-burden` and confirm immediate overview behavior;
2. enter Skill Management and wait for/load the inventory;
3. inspect enabled/hidden/disabled entries;
4. exercise a non-destructive preview/toggle flow;
5. leave and re-enter Skill Management without an unnecessary rescan.

## Performance evidence

Provide structural proof that the initial report performs no recursive skill inventory discovery and no `npm root -g` subprocess.

If practical, compare cold-open time with a synthetic/real environment containing many skills, e.g. roughly 10, 100, and several hundred skill files. Do not commit flaky timing assertions.

## Acceptance

- main report opens without full skill filesystem discovery;
- full inventory loads only when Skill Management needs it;
- repeated navigation avoids redundant rescans;
- Skill Visibility State semantics and persistence are preserved;
- Pi public APIs are reused only where parity is demonstrated;
- focused tests, `pnpm run check`, and relevant e2e/manual checks pass;
- one clean commit with the required subject exists.
