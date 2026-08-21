# Task 02: Add the Pi Atelier sidebar publisher

## Objective

Add a tiny optional publisher for Pi Atelier's public sidebar event protocol. This slice is protocol plumbing only. Do not wire live token measurement yet.

## Protocol

Use:

```ts
const CHANNEL = "pi-atelier:sidebar-panels";
const VERSION = 1;
const SOURCE = "pi-token-burden";
const PANEL_ID = "token-burden:budget";
```

Pi Atelier expects contributed panel IDs to be namespaced, so `token-burden:budget` is valid.

A publisher must support both directions:

```text
Token Burden ── register/update ──► Atelier
Token Burden ◄──── discover ─────── Atelier
```

When Atelier sends `discover`, replay the current panel with the request's `requestId`. This is what makes extension load order irrelevant.

## Work

Create `src/atelier-sidebar.ts` with a deliberately small API. For example:

```ts
const publisher = createAtelierSidebarPublisher(pi.events);

publisher.update(rows);
publisher.clear();
```

Exact API is flexible, but it needs these properties:

- one stable panel ID for its lifetime;
- monotonically increasing safe-integer revision numbers;
- `register` event on update;
- replay on valid `discover` events;
- optional clear/unregister behavior if useful for session teardown;
- no import from `pi-atelier`;
- no runtime dependency on `pi-atelier`;
- harmless behavior if Atelier is not installed.

The publisher should expose or callback when a valid Atelier `discover` is seen. The next slice will use that signal to avoid doing token work when Atelier is absent.

Do not copy all of Atelier's validation code. We are a trusted publisher, not a registry. Validate only the external discovery payload fields that Token Burden consumes.

## Event shapes

Register:

```ts
{
  version: 1,
  type: "register",
  source: "pi-token-burden",
  revision,
  panel: {
    id: "token-burden:budget",
    title: "Token burden",
    rows,
  },
  requestId?: string,
}
```

Optional unregister:

```ts
{
  version: 1,
  type: "unregister",
  source: "pi-token-burden",
  revision,
  id: "token-burden:budget",
}
```

Discovery input:

```ts
{
  version: 1,
  type: "discover",
  requestId: string,
}
```

## Tests

Create `src/atelier-sidebar.test.ts` with an in-memory fake event bus.

Cover at least:

1. `update()` emits one valid register event.
2. Subsequent updates increment revision.
3. Discovery replays the current panel and includes the same `requestId`.
4. Discovery before any current panel does not emit bogus data.
5. Malformed discovery payloads are ignored.
6. Revisions remain monotonic across update + discovery replay.
7. If `clear()`/unregister exists, it emits the expected unregister event and does not replay stale content afterward.

Run:

```bash
pnpm vitest run src/atelier-sidebar.test.ts
pnpm run test
```

## Completion condition

The publisher works in isolation, has no dependency on Pi Atelier, and all tests pass.

Suggested commit:

```text
feat: add Atelier sidebar publisher
```
