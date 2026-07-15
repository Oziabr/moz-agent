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
