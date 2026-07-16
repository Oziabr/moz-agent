# moz-agent

Firefox extension. Goal: an agentic tool that connects to a user's browser
session and lets an external agent observe/act on it.

## Status

Domain-gated stub: per-domain enable/write toggles, badge indication, auth
handoff from a project page, and a dispatch queue in the DB. No job
execution (content-script dispatch) wired up yet.

## Structure

- `extension/manifest.json` - MV3 manifest, background is a native ES module
- `extension/background.js` - domain state, permission handling, badge,
  auth, polling
- `extension/supabase-client.js` - thin `fetch` wrapper over Supabase's
  REST (PostgREST) and Auth (GoTrue) HTTP APIs. No SDK, no build step.
- `extension/config.example.js` - template for Supabase URL/key and project
  page origin; copy to `extension/config.js` (gitignored) and fill in real
  values, see [Dev](#dev)
- `extension/auth-bridge.js` - content script that relays a session from
  the project page (see [Auth](#auth))
- `extension/test-bridge.js` - content script used only by the test suite
- `extension/popup/` - toggle UI
- `supabase/migrations/0001_init.sql` - schema, all objects prefixed `moz_agent_`

## Why no bundler

Earlier versions of this depended on `@supabase/supabase-js`, which pulls in
GoTrue, PostgREST, and a full Phoenix-channel Realtime client for maybe 5%
of that surface actually used here - and needed `esbuild` just to make an
npm package importable from a raw WebExtension background script. That's
gone. `extension/supabase-client.js` reimplements only what's needed
(query/insert/update over `fetch`, session refresh over `fetch`) as plain
ES modules, which Firefox loads natively (`"type": "module"` in the
manifest's `background` key, `type="module"` on the popup's script tag).
Load the extension as-is, no build step.

The one thing `fetch` can't do is Supabase Realtime (it's a WebSocket/Phoenix
protocol, not request/response). Rather than hand-roll that too, domain and
job state are polled on a `browser.alarms` timer instead of pushed - see
[Auth](#auth) and the polling note below. Trade-off: changes take up to a
minute to be noticed instead of arriving instantly. Worth revisiting if job
dispatch latency ends up mattering; not worth the protocol-reimplementation
cost yet.

## DB

Two tables, both RLS-scoped to `auth.uid()`:

- `moz_agent_enabled_domains` - per-user allow list. `enabled` gates parse/crawl
  (GET only). `allow_write` is a separate opt-in required for `submit` jobs.
- `moz_agent_jobs` - the dispatch queue. `type` is `parse` / `crawl` / `submit`,
  `status` walks `pending` -> `claimed` -> `done` / `failed`.

`extension/background.js` polls both on a 1-minute `browser.alarms` timer
(the practical floor for that API) plus immediately after auth changes,
rather than subscribing to Realtime.

## Dev

```
npm install
cp extension/config.example.js extension/config.js
```

Then fill in `extension/config.js` with your real values:

- `SUPABASE_URL` / `SUPABASE_ANON_KEY` - Supabase dashboard -> your project ->
  **Project Settings -> API** -> "Project URL" and "anon public" key. The
  anon key is meant to be exposed client-side (RLS is the actual security
  boundary, not key secrecy) - safe to ship inside the extension - but
  `config.js` is still gitignored so your specific project isn't published
  in this repo's history.
- `PROJECT_PAGE_ORIGIN` - see [Auth](#auth) below; must also match the
  `host_permissions` / `content_scripts` entry in `extension/manifest.json`.

`extension/config.js` is required at runtime - `supabase-client.js` and
`popup.js` import it directly, no build step substitutes it in. If it's
missing, the background script fails to load entirely once it actually
imports `supabase-client.js`. The e2e test suite doesn't need it (it swaps
`supabase-client.js` for an in-memory stub that never touches Supabase), but
`npm run run` / `npm run build` do.

```
npm run lint
npm run run
```

`npm run run` uses `web-ext run` to load the extension into a temporary
Firefox profile directly from `extension/` - nothing to build first.

## Examples

DB usage examples (`fetch` calls paired with raw SQL equivalents) live
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
   its own `supabase-js` client (or its own `fetch` calls), same as any web app.
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
3. `extension/auth-bridge.js`, a content script scoped only to
   `PROJECT_PAGE_ORIGIN` (a required host permission, distinct from the
   optional per-target-domain grants), relays that event to the background
   script.
4. Background adopts the session via `setSession(...)` in
   `supabase-client.js`, or signs out if the event carried `null`. Either
   way it resets the domain cache, active job counts, and polling before
   reloading - stale rows from a previous identity must never linger.

Session persistence uses `browser.storage.local` rather than `localStorage`,
since Firefox can tear down and respawn MV3 event pages when idle and a
plain `localStorage` session wouldn't reliably survive that. Token refresh
is handled in `supabase-client.js`'s `getSession()`, which transparently
calls GoTrue's `/auth/v1/token?grant_type=refresh_token` when the cached
session is near expiry.

Before this works you need to fill in `PROJECT_PAGE_ORIGIN` in
`extension/config.js` and the matching `host_permissions` /
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

No build step needed, but the Supabase client still gets swapped for tests:
`tests/prepare-test-extension.js` copies `extension/` into `.test-extension/`
and overwrites `supabase-client.js` with `tests/fixtures/supabase-client.stub.js`,
an in-memory fake exposing the same function names. Plain `fs.cpSync`, no
bundler involved. That gives deterministic test runs with no real Supabase
project needed. The test then installs `.test-extension/` as a temporary
add-on in headless Firefox and drives the background script's message
handlers through a `localhost`-only test-bridge content script
(`extension/test-bridge.js`) that a test fixture page
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
