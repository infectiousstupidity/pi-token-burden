# Task 02: Harden sidebar measurement cache identity

## Outcome

The sidebar cache must reuse a measurement when the model-facing measurement inputs are semantically unchanged, and must invalidate whenever those inputs actually change.

Do not use JS object identity or active-tool array ordering as part of correctness.

Create exactly one commit:

```text
perf: harden sidebar measurement cache key
```

## Read first

```text
AGENTS.md
CONTEXT.md
docs/agents/domain.md
src/index.ts
src/index.test.ts
src/measureTokenBudget.ts
src/parser.ts
```

Inspect the cache implementation and `buildToolDefinitionsSection()` before designing the key. Identify exactly which inputs affect the lightweight sidebar result.

## Problem to verify

The current cache comparison has used shallow tool-array copies and `tool.parameters === other.parameters`. That can:

- miss the cache when an equivalent schema is reconstructed as a new object;
- falsely hit if a schema object is mutated in place after the cached shallow copy;
- miss the cache when the same active tool names arrive in a different order even though measurement treats them as a set.

Verify what remains true in current code before editing.

## Required behavior

Replace ad hoc identity comparisons with one deterministic measurement signature/key for the sidebar summary.

The signature must represent only semantic inputs that can affect the sidebar's measured current burden, including:

- exact system-prompt text;
- effective model API/provider envelope selection;
- active tool membership as a set, not incidental array order;
- the model-facing fields of each active tool that affect serialization/token count: name, description, and parameters/schema.

Do not invalidate because an inactive tool's schema changed unless the current lightweight result genuinely exposes/counts that change. If current UI still exposes an inventory count that must change, account for that narrow value without hashing every inactive schema.

The representation must be stable for structurally equal plain objects regardless of object identity. Preserve array order where array order is semantically meaningful. Do not add a hashing/stringify dependency.

Choose the smallest implementation that is easy to audit. A canonical deterministic serialization is acceptable. A custom cache framework is not.

## Scope boundary

Do not:

- alter when lifecycle refreshes happen; slice 01 owns scheduling;
- change token accounting or provider envelope serialization;
- optimize tokenizer allocations;
- introduce a process-wide or persisted cache;
- add cryptographic machinery unless the repository already has a clear need for it;
- cache full `ParsedPrompt` details outside the existing sidebar use case.

## Required tests

Add regression cases for all of these:

1. Same prompt/model/tools with the same schema object -> cache hit.
2. Same semantic schema reconstructed as a new object -> cache hit.
3. Cached schema object mutated in place -> cache miss and remeasurement.
4. Active tool names reordered with identical membership -> cache hit.
5. Active tool membership changed -> cache miss.
6. Active tool description changed -> cache miss.
7. Active tool parameters changed -> cache miss.
8. Provider/API envelope selection changed -> cache miss.
9. Prompt changed -> cache miss.

Prefer tests at the entrypoint/cache seam so they prove whether `measureTokenBudget` is invoked, not merely whether a helper returns a string.

If you extract a pure signature helper, give it focused tests only where they add coverage not already proven at the cache seam.

## Validation

Run focused cache/lifecycle tests, then:

```bash
pnpm run check
```

No manual TUI change is expected, but a quick local sidebar smoke is useful if available.

## Performance evidence

Demonstrate that semantically unchanged replacement schemas and active-tool permutations no longer trigger `measureTokenBudget`, while real schema mutations do.

Do not claim the key is faster merely because it is deterministic. The goal is to avoid expensive false misses without allowing false hits.

## Acceptance

- no cache correctness depends on `parameters` object identity;
- active tool ordering alone cannot invalidate the cache;
- real model-facing tool changes always invalidate;
- no dependency or generalized cache layer was added;
- focused tests and `pnpm run check` pass;
- one clean commit with the required subject exists.
