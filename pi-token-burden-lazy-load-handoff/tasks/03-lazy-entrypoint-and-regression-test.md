# Task 03: Make the entrypoint truly lazy

## Objective

Make Pi startup evaluate only a tiny Token Burden entrypoint.

## Change `src/index.ts`

Remove runtime imports for Token Burden implementation code.

The intended shape is:

```ts
import type { ExtensionFactory } from '@mariozechner/pi-coding-agent';

const EXTENSION: ExtensionFactory = (pi) => {
  pi.registerCommand('token-burden', {
    description: 'Show token budget breakdown and manage skills',
    handler: async (args, ctx) => {
      const { runTokenBurden } = await import('./token-burden-command.js');
      await runTokenBurden(pi, args, ctx);
    },
  });
};

export default EXTENSION;
```

Use the actual command argument/context types exposed by the current Pi version.

## Important

Do not add an eager preload such as:

```ts
const commandPromise = import('./token-burden-command.js');
```

at module scope. That defeats the change.

Do not dynamically import every downstream file individually. There should be one obvious lazy boundary:

```text
index.ts → dynamic import → token-burden-command.ts
```

Normal ESM module caching is sufficient. Do not implement a custom cache.

## Regression test

Add an entrypoint test that proves the command implementation is not evaluated during extension import/registration.

The test must distinguish these two states:

```text
import/register extension
→ command module NOT evaluated

invoke /token-burden handler
→ command module evaluated
→ runTokenBurden called
```

Use a module-evaluation sentinel or equivalent Vitest technique.

The test must fail if a future developer replaces the dynamic import with a static import.

Also keep a basic assertion that the command is registered under:

```text
token-burden
```

## Error behavior

Do not swallow dynamic-import or command errors.

If loading fails, let Pi's normal command error path see the failure unless the existing code already has a specific user-facing error contract.

## First-use behavior

The first `/token-burden` invocation may take roughly the amount of time that was previously paid at startup. That is expected.

Do not hide this by preloading in the background immediately after startup.

## Future Atelier integration constraint

If `feature/atelier-sidebar` is already present after a rebase, do not reintroduce tokenizer loading just because the sidebar publisher exists.

A tiny event listener/protocol publisher may remain eager. Actual budget measurement must stay behind a real demand signal.

If resolving this requires non-trivial changes to the sidebar branch, stop and report the conflict rather than silently combining both feature scopes.

## Verification

Run:

```bash
pnpm run test
pnpm run typecheck
```

Then start Pi without invoking `/token-burden` and confirm normal startup.

Invoke `/token-burden` twice and confirm both invocations work.

## Acceptance

- entrypoint has no eager heavy imports;
- regression test proves laziness;
- first invocation works;
- second invocation works;
- no explicit preload/cache machinery was added.
