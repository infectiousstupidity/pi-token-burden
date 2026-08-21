# Task 02: Extract the command implementation

## Objective

Move the current `/token-burden` implementation out of `src/index.ts` without changing behavior.

This task creates the lazy-load boundary but does not yet rely on timing improvements as proof.

## Target

Create:

```text
src/token-burden-command.ts
```

Expose one narrow function, for example:

```ts
export async function runTokenBurden(pi, args, ctx): Promise<void>
```

Use precise Pi types from the existing peer dependency. Do not introduce `any`.

## Move, do not redesign

Move the current handler work into this module:

```text
ctx.getSystemPrompt()
parseSystemPrompt()
pi.getAllTools()
pi.getActiveTools()
toolEnvelopeForModel()
buildToolDefinitionsSection()
ctx.getContextUsage()
skill/settings loading
Source Trace callback construction
showReport()
Skill Visibility Store save handling
```

Keep existing ordering and behavior unless the extraction itself requires a tiny mechanical change.

## Keep these modules behind the new boundary

The command module may statically import them because the command module itself will be lazy:

```text
parser.ts
report-view.ts
base-trace/*
skills.ts
skill-visibility-store.ts
saveSkillToggleResult.ts
```

That includes their transitive dependencies such as:

```text
gpt-tokenizer
yaml
```

## Tests

Move/adapt existing handler behavior tests from `src/index.test.ts` into a focused command-module test where that makes the test clearer.

Preserve coverage for at least:

```text
active tool names are passed to tool-definition measurement
model API/provider select the correct tool envelope
no-UI execution does not open a report
report receives the same measured data/options as before
```

Keep `src/index.test.ts` focused on entrypoint behavior after Task 03.

## Constraints

Do not:

- alter token labels or counts;
- rename domain concepts;
- change report rendering;
- change skill scanning;
- change Source Trace;
- add a service/container/class abstraction;
- create a generic plugin loader;
- add dependencies.

One function in one command module is enough.

## Verification

Run focused tests after extraction.

Then:

```bash
pnpm run typecheck
pnpm run test
```

At this point `/token-burden` behavior should be unchanged even if `src/index.ts` still temporarily imports the new function statically.

## Acceptance

- current handler logic has one clear home;
- behavior tests pass;
- no product behavior was intentionally changed;
- heavy dependencies are reachable through the command module rather than being mixed into entrypoint registration code.
