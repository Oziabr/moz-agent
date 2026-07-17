# moz-agent

Firefox extension. Goal: an agentic tool that connects to a user's browser
session and lets an external agent observe/act on it.

## Status

Domain-gated stub: per-domain enable/write toggles, badge indication, auth
handoff from a project page, and a dispatch queue in the DB. Job execution
is wired for six command types (`msg` - an on-page popup; `$` - a single
named element extraction; `$$` - all matching elements; `wait` - a capped
pause between commands; `goto` - navigate the tab mid-job; `screenshot` -
a cropped region capture plus its element inventory) - see
`extension/content.js` and `dispatchPendingJobs` in `background.js`. Other,
more consequential command types (form-submission-shaped actions) aren't
implemented yet.

## Structure

- `extension/manifest.json` - MV3 manifest, background is a native ES module
- `extension/background.js` - domain state, badge, polling, auth
- `extension/supabase-client.js` - thin `fetch` wrapper over Supabase's
  REST (PostgREST) and Auth (GoTrue) HTTP APIs. No SDK, no build step.
- `extension/config.example.js` - template for Supabase URL/key and project
  page origin; copy to `extension/config.js` (gitignored) and fill in real
  values, see [Dev](#dev)
- `extension/auth-bridge.js` - content script that relays a session from
  the project page (see [Auth](#auth))
- `extension/content.js` - content script that executes a job's
  `payload.commands` on the page: `msg` (on-page popup), `$` (single
  element, named), `$$` (all matching elements), `wait` (paused for `ms`,
  capped at 30s). `goto` (navigate mid-job) and `screenshot` (cropped
  region capture + element inventory) are handled in `background.js`'s
  `runJobOnTab` instead - navigation tears down the page's content-script
  context, and pixel capture is a privileged API content scripts can't
  call - though `screenshot` still round-trips to `content.js`'s
  `measureRegion` for the element/rect data. See
  [docs/db-examples.md](docs/db-examples.md) for how both work.
- `extension/test-bridge.js` - content script used only by the test suite
- `extension/popup/` - toggle UI
- `project-page/` - the login + domain list page from [Auth](#auth), served
  locally by `npm run run` (see [Dev](#dev))
- `scripts/dev.js` - starts `project-page/` and `web-ext run` together
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
cp project-page/public/config.example.js project-page/public/config.js
```

Fill in both `config.js` files with the same `SUPABASE_URL` /
`SUPABASE_ANON_KEY` - Supabase dashboard -> your project ->
**Project Settings -> API** -> "Project URL" and "anon public" key. The anon
key is meant to be exposed client-side (RLS is the actual security boundary,
not key secrecy) - safe to ship inside either the extension or the page -
but both files are gitignored so your specific project isn't published in
this repo's history.

`extension/config.js`'s `PROJECT_PAGE_ORIGIN` defaults to
`http://localhost:4590`, matching `scripts/dev.js`'s default port - leave it
as-is for local dev. Before deploying for real, see the note at the bottom
of [Auth](#auth).

If your Supabase project has **Confirm email** enabled under
**Authentication -> Providers -> Email**, signup won't return a session
immediately - the user has to click the confirmation email first, then log
in. Turn it off for local dev if you want signup to log you straight in.

`extension/config.js` and `project-page/public/config.js` are required at
runtime - nothing substitutes them in at build time. The e2e test suite
doesn't need either (it swaps `extension/supabase-client.js` for an
in-memory stub that never touches Supabase), but `npm run run` does.

```
npm run lint
npm run run
```

`npm run run` runs `scripts/dev.js`, which starts `project-page/` on
`http://localhost:4590` and `web-ext run` together, and stops both on
Ctrl-C. Open `http://localhost:4590` to sign up / log in (email + password)
and see your enabled domains; the extension picks up the session
automatically once the page has it (see [Auth](#auth)).

## Examples

DB usage examples (`fetch` calls paired with raw SQL equivalents) live
in [`docs/db-examples.md`](docs/db-examples.md).

## Permissions

`extension/manifest.json` declares `host_permissions: ["*://*/*"]` -
granted at install, like an ad blocker such as uBlock Origin, rather than
requested per-domain at toggle time. Earlier versions requested
`*://${domain}/*` as an *optional* permission the moment a domain was
enabled via `browser.permissions.request()`. That broke in practice:
`permissions.request()` must be called synchronously from within a user
input handler, and the actual call happened in `background.js` after a
message round-trip from the popup's click handler - crossing that message
boundary loses the "user gesture" context Firefox requires, so every
request failed with `permissions.request may only be called from a user
input handler`, even though a real click triggered it.

Rather than restructure the popup to call `permissions.request()` directly
in its own click handler (still one native permission prompt per new
domain, and still nothing Selenium can drive - see [Dev](#dev)), enabling a
domain is now a pure DB write (`moz_agent_enabled_domains.enabled`); the
browser-level access is already there for every site from install. The
`enabled`/`allow_write` columns and their RLS/trigger enforcement (see
[Auth](#auth) and `supabase/migrations/0001_init.sql`) are unchanged and
remain the real gate on what the agent can do - this only removes the
second, browser-permission-shaped gate that sat in front of them and that
Firefox's own user-gesture rule made unreliable to drive from a
message-passed background script.

Trade-off worth being explicit about: the extension now has standing read
access to every page a user visits from the moment it's installed, same as
any all-urls extension. If per-domain browser-level isolation matters more
than fixing the click-to-permission flow, the alternative is moving
`permissions.request()` into `popup.js` itself (called directly in the
toggle's `click` handler, no `sendMessage` hop) and keeping
`optional_host_permissions` - a contained change, not a schema change,
symmetric with the note on [Auth](#auth) about swapping the session-handoff
design later.



The extension and the project page (your web dashboard) need to resolve to
the same Supabase user, since RLS scopes every row in
`moz_agent_enabled_domains` and `moz_agent_jobs` to `auth.uid()`. There's no
anonymous fallback - an anonymous extension session would be invisible to
the dashboard and vice versa, so the extension sits unauthenticated until
it's explicitly connected.

Flow:

1. `project-page/public/` handles real login - email + password via
   GoTrue's `/auth/v1/token?grant_type=password` (login) and `/auth/v1/signup`
   (new accounts) REST endpoints directly (`fetch`, no SDK, same approach as
   the extension). Both return the session tokens directly in the JSON
   response body, no redirect round-trip. See `project-page/public/app.js`.
2. On login (and on load, if a session is already stored) it dispatches:
   ```js
   window.dispatchEvent(new CustomEvent('moz-agent-session', { detail: { session } }))
   ```
   and the same on logout with `session: null`.
3. `extension/auth-bridge.js`, a content script scoped only to
   `PROJECT_PAGE_ORIGIN`, relays that event to the background script. It
   injects at `document_start`, not the default `document_idle` -
   `app.js` is a `type="module"` script, which executes deferred at roughly
   the same phase `document_idle` would inject at, with no guaranteed
   ordering between the two. `document_start` guarantees the listener is
   attached before any page script runs, so the event is never dispatched
   into an empty room.
4. Background adopts the session via `setSession(...)` in
   `supabase-client.js`, or signs out if the event carried `null`. Either
   way it resets the domain cache, active job counts, and polling before
   reloading - stale rows from a previous identity must never linger.

Session persistence uses `browser.storage.local` rather than `localStorage`,
since Firefox can tear down and respawn MV3 event pages when idle and a
plain `localStorage` session wouldn't reliably survive that. Token refresh
is handled in `supabase-client.js`'s `getSession()`, which transparently
calls GoTrue's `/auth/v1/token?grant_type=refresh_token` when the cached
session is near expiry. `project-page/public/app.js` doesn't refresh its own
copy yet - it's a stub login page, not a full session-management client;
worth adding if the page ends up living longer than a few clicks per visit.

`PROJECT_PAGE_ORIGIN` and the manifest's matching `host_permissions` /
`content_scripts` entry for `auth-bridge.js` both default to
`http://localhost` for local dev (see [Dev](#dev)). Before deploying the
project page for real, update all three - `extension/config.js`'s
`PROJECT_PAGE_ORIGIN`, and both the `host_permissions` entry and the
`auth-bridge.js` match pattern in `extension/manifest.json` - to your real
HTTPS domain, and add that domain to Supabase's redirect URL allow-list too.

Passing the session through a content script rather than exchanging a
short-lived code is the simpler of two reasonable designs - it's safe
specifically because the bridge is scoped to your own trusted origin
(Firefox content scripts run in an isolated JS world, page script can't read
them back out), but it does mean tokens transit the page's DOM event system.
If that tradeoff stops being comfortable later, swapping to a
server-exchanged linking code is a contained change to `auth-bridge.js`
and `handleAuthHandoff`, not a schema change.

If you were already logged in on the project page tab *before* the
extension (re)loaded - e.g. `web-ext run` restarted - that tab won't have
`auth-bridge.js` yet. Extensions only inject content scripts into new
navigations after install/reload, not into already-open tabs. Reload the
project page tab once and the handoff fires normally.

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

**What's covered**: message routing and the enable/write gating logic
end-to-end, including that `setWrite` is rejected on a domain that isn't
enabled. Since the extension now holds `*://*/*` at install time (see
[Permissions](#permissions) below), enabling a domain is a pure DB write
with no native permission prompt in the way, so this suite can exercise the
whole enable → write flow headlessly - there's no longer a manual-only step
here.

Requires a real Firefox install on the machine running the tests. Set
`FIREFOX_BIN` to point at a specific binary if it's not on `PATH`.

## Next steps

- pick a transport for the agent connection (websocket vs native messaging)
- add the agent server (node), with HURL tests against its HTTP/WS endpoints
- more command types in `content.js`/`background.js` beyond
  `msg`/`$`/`$$`/`wait`/`goto`/`screenshot` (form-submission-shaped page
  actions) - and when the first write-shaped one is added, re-checking the
  *current* tab's domain permissions before running it, since `goto` can
  move a job onto a different domain than the one it was
  scheduled/permission-checked under (see
  [docs/db-examples.md](docs/db-examples.md))
- move `screenshot`'s image data out of `moz_agent_jobs.result` and into
  Supabase Storage once used at any real volume - a base64 PNG inline in
  `jsonb` is fine for occasional use, not for scale
- e2e coverage for the dispatch path itself (claim race, a tab with no
  content script yet, `allow_write` revoked mid-job, a `goto` navigation)
