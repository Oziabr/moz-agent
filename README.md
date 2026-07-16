# moz-agent

Firefox extension stub. Goal: an agentic tool that connects to a user's browser
session and lets an external agent observe/act on it.

## Status

Bare stub. Background script and popup log to console only, no real connection yet.

## Structure

- `extension/manifest.json` - MV3 manifest, Firefox gecko id set
- `extension/background.js` - background script, will hold the connection to the agent server
- `extension/popup/` - toolbar popup UI
- `extension/icons/` - not populated yet
- `supabase/migrations/0001_init.sql` - schema, all objects prefixed `moz_agent_`

## DB

Two tables, both RLS-scoped to `auth.uid()`:

- `moz_agent_enabled_domains` - per-user allow list. `enabled` gates parse/crawl
  (GET only). `allow_write` is a separate opt-in required for `submit` jobs.
- `moz_agent_jobs` - the dispatch queue. `type` is `parse` / `crawl` / `submit`,
  `status` walks `pending` -> `claimed` -> `done` / `failed`. Realtime is on for
  this table so the extension gets pushed new jobs.

## Dev

```
npm install
npm run lint
npm run run
```

`npm run run` uses `web-ext run` to load the extension into a temporary Firefox profile.

## Examples

DB usage examples (supabase-js calls paired with raw SQL equivalents) live
in [`docs/db-examples.md`](docs/db-examples.md).

## Auth

The extension and the project page (your web dashboard) need to resolve to
the same Supabase user, since RLS scopes every row in
`moz_agent_enabled_domains` and `moz_agent_jobs` to `auth.uid()`. There's no
anonymous fallback - an anonymous extension session would be invisible to
the dashboard and vice versa, so the extension sits unauthenticated until
it's explicitly connected.

Flow:

1. The project page handles real login (magic link / OAuth / password) with
   its own `supabase-js` client, same as any web app.
2. The project page cooperates by dispatching a DOM event from its own
   `onAuthStateChange` listener:
   ```js
   supabase.auth.onAuthStateChange((event, session) => {
     window.dispatchEvent(new CustomEvent('moz-agent-session', { detail: { session } }))
   })
   ```
   `onAuthStateChange` fires once on load with the current session (or
   `null`), so this covers "already logged in" too, no storage-format
   sniffing required.
3. `extension/src/auth-bridge.js`, a content script scoped only to
   `PROJECT_PAGE_ORIGIN` (a required host permission, distinct from the
   optional per-target-domain grants), relays that event to the background
   script.
4. Background adopts the session via `supabase.auth.setSession(...)`, or
   signs out if the event carried `null`. Either way it resets the domain
   cache, active job counts, and realtime subscriptions before reloading -
   stale rows from a previous identity must never linger.

Session persistence uses a `browser.storage.local`-backed storage adapter
rather than the default `localStorage`, since Firefox can tear down and
respawn MV3 event pages when idle and a plain `localStorage` session
wouldn't reliably survive that.

Before this works you need to fill in `PROJECT_PAGE_ORIGIN` in
`extension/src/config.js` and the matching `host_permissions` /
`content_scripts` entries in `extension/manifest.json` with your real
project page domain (both currently point at the `app.moz-agent.example`
placeholder).

Passing the session through a content script rather than exchanging a
short-lived code is the simpler of two reasonable designs - it's safe
specifically because the bridge is scoped to your own trusted origin
(Firefox content scripts run in an isolated JS world, page script can't read
them back out), but it does mean tokens transit the page's DOM event system.
If that tradeoff stops being comfortable later, swapping to a
server-exchanged linking code is a contained change to `auth-bridge.js`
and `handleAuthHandoff`, not a schema change.

## Testing

E2E tests drive a real Firefox via Selenium + geckodriver (`driver.installAddon`,
Mozilla's documented approach — Playwright's Firefox is a patched fork that
doesn't support loading unpacked WebExtensions, so it's not used here).

```
npm run test:e2e
```

This builds the extension against an in-memory Supabase stub
(`extension/src/supabase-stub.js`, swapped in via `esbuild`'s `alias` option
for deterministic runs with no real project needed), launches headless
Firefox, installs the extension as a temporary add-on, and drives the
background script's message handlers through a `localhost`-only test-bridge
content script (`extension/src/test-bridge.js`) that a test fixture page
(`tests/fixtures/index.html`) talks to over DOM events.

**What's covered**: message routing, the enable/write gating logic, and that
a failed permission request never reaches the DB. **What isn't**: actually
granting a new optional permission. `browser.permissions.request()` requires
a real user gesture and shows a native prompt Selenium can't drive (by
design, this is a security boundary Firefox enforces) — so that path is a
manual smoke test via `npm run run`, not part of the automated suite.

Requires a real Firefox install on the machine running the tests. Set
`FIREFOX_BIN` to point at a specific binary if it's not on `PATH`.

## Next steps

- pick a transport for the agent connection (websocket vs native messaging)
- add the agent server (node), with HURL tests against its HTTP/WS endpoints
- content script for page-level actions
- auth/session handoff between extension and agent server
