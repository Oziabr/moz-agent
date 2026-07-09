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

## Next steps

- pick a transport for the agent connection (websocket vs native messaging)
- add the agent server (node), with HURL tests against its HTTP/WS endpoints
- content script for page-level actions
- auth/session handoff between extension and agent server
