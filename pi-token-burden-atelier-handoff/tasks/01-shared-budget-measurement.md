# Task 01: Share the Token Budget measurement path

## Objective

Extract only the small amount of logic needed so `/token-burden` and the future sidebar use the same Token Budget Pipeline result.

Do not change visible behavior in this slice.

## Why

`src/index.ts` currently does the complete measurement inside the `/token-burden` command handler:

```text
ctx.getSystemPrompt()
  → parseSystemPrompt()
  → pi.getAllTools()
  → pi.getActiveTools()
  → toolEnvelopeForModel()
  → buildToolDefinitionsSection()
  → final ParsedPrompt
```

The sidebar must reuse this exact path. Duplicating it would eventually make the overlay and sidebar disagree.

This extraction should also leave a clean seam for the later lazy-loading work, but do not implement dynamic imports in this branch.

## Work

1. Create a small shared module, preferably `src/token-budget.ts`, or use an equally small existing module if there is a better fit.
2. Move the prompt + tool-definition measurement into one function.
3. Make the function accept the data it actually needs instead of a large application object when practical.
4. Keep `ParsedPrompt` as the returned domain result unless a new type is genuinely necessary.
5. Change the `/token-burden` command handler to call this function.
6. Preserve the existing context-window lookup in the command handler or expose it separately. Context-window display is not part of the Token Budget Pipeline itself.

A reasonable API is roughly:

```ts
measureTokenBudget({
  prompt,
  allTools,
  activeToolNames,
  modelApi,
  modelProvider,
}): ParsedPrompt
```

The exact name and argument structure are not mandatory. Prefer the smallest clear API.

## Do not

- change tokenization;
- change section labels;
- change sorting;
- change tool-envelope rules;
- touch skill persistence;
- touch Source Trace;
- add dependencies;
- implement lazy loading yet.

## Tests

Add focused tests for the shared helper or adjust `src/index.test.ts` so it proves:

- active tool names are still passed into tool-definition accounting;
- provider/API envelope selection is unchanged;
- the tool section is added to `ParsedPrompt.totalTokens` and `totalChars` exactly as before;
- a null tool section leaves totals unchanged.

Run:

```bash
pnpm vitest run src/index.test.ts
```

Add the new test file to the command if you create one.

Then run:

```bash
pnpm run test
```

## Completion condition

This slice is complete only when `/token-burden` behavior is unchanged and the full unit test suite passes.

Suggested commit:

```text
refactor: share token budget measurement
```
