# Task 04: Make summary measurement allocation-light

## Outcome

The lightweight sidebar path should compute only the values it displays. It must avoid constructing content strings, pretty-printed JSON, token arrays, or other detail-only data that is immediately discarded.

Create exactly one commit:

```text
perf: reduce summary measurement allocations
```

## Read first

```text
AGENTS.md
CONTEXT.md
docs/agents/domain.md
src/parser.ts
src/parser-summary.test.ts
src/measureTokenBudget.ts
src/measureTokenBudget.test.ts
src/atelier-sidebar.ts
```

Inspect the installed `gpt-tokenizer` API. If `countTokens()` is available for the same encoding and returns identical counts to `encode(text).length`, prefer the counting primitive where the caller only needs a number.

## Problems to verify

The lightweight path has historically still performed work such as:

- slicing a prompt span only to read its `.length`;
- calling `encode(text)` and allocating a token array only to read `.length`;
- serializing an active tool envelope twice, once compact and once pretty-printed, even when detail content is not requested;
- building detail-only structures before dropping them.

Verify current code after slice 03 before editing.

## Required behavior

For `details: false`:

- use `end - start` for span character counts when content is not needed;
- do not attach/copy section `content`;
- count tokens without retaining token arrays when the tokenizer exposes an equivalent count primitive;
- serialize the counted active tool envelope only in the form actually needed for token counting;
- do not pretty-print JSON unless a detail view needs the pretty content;
- do not build active/inactive tool entry arrays or envelope variants merely to serve the summary;
- preserve all returned summary fields and token totals expected by the sidebar.

Keep the full-detail path unchanged unless sharing a lower-level primitive removes duplication without changing output.

Favor a clear split such as "measure tokens only" versus "build detailed representation" over many boolean branches spread through the parser. Do not create a generalized optimization framework.

## Scope boundary

Do not:

- change parser section semantics established in slice 03;
- change cache keys or scheduling;
- change the tokenizer encoding;
- lazy-load command features; slice 05 owns that;
- redesign tool drilldown hydration; slice 07 owns detail-on-demand behavior;
- add dependencies.

## Required tests

Prove both correctness and absence of detail construction.

At minimum:

1. `details: false` and full detail return identical `totalTokens` for the same prompt/tools/model.
2. Summary sections omit `content`, child detail, inactive entries, and variants as intended by the current summary contract.
3. Tool tokens exactly match the current provider envelope's compact serialized payload.
4. Summary mode does not call pretty JSON serialization/detail builders. Use a narrow test seam or extracted pure function rather than globally monkey-patching unrelated runtime behavior.
5. Character counts are unchanged.
6. Empty/no-tool cases remain unchanged.

If switching from `encode().length` to `countTokens()`, add a focused equivalence test over representative Unicode/code/JSON text and keep existing parser fixtures green.

## Performance evidence

Use a small local benchmark or instrumentation on representative prompts/tool catalogs. Compare the lightweight path before/after for:

```text
100k-char prompt + 25 active tools
100k-char prompt + 100 active tools
```

Report median time and, where practical, heap/allocation observations. Do not commit a flaky wall-clock assertion.

The important structural proof is that summary mode no longer constructs detail-only content or pretty JSON.

## Validation

Run focused parser/measurement/sidebar tests, then:

```bash
pnpm run check
```

No user-visible behavior should change.

## Acceptance

- summary mode performs no unnecessary span slicing or pretty serialization;
- token counts remain identical to the pre-slice behavior;
- full-detail output remains intact;
- no new dependency or broad abstraction was added;
- focused tests and `pnpm run check` pass;
- one clean commit with the required subject exists.
