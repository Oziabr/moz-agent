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

Using `@supabase/supabase-js` from the extension's background script.

Enable a domain (read-only, parse/crawl):

```js
const enableDomain = (supabase, domain) =>
  supabase
    .from('moz_agent_enabled_domains')
    .upsert({ domain, enabled: true }, { onConflict: 'user_id,domain' })
```

Enable a domain for form submission too:

```js
const enableDomainForWrite = (supabase, domain) =>
  supabase
    .from('moz_agent_enabled_domains')
    .upsert({ domain, enabled: true, allow_write: true }, { onConflict: 'user_id,domain' })
```

Disable a domain:

```js
const disableDomain = (supabase, domain) =>
  supabase
    .from('moz_agent_enabled_domains')
    .update({ enabled: false, allow_write: false })
    .eq('domain', domain)
```

Subscribe to pending jobs over realtime:

```js
const subscribeToJobs = (supabase, onJob) =>
  supabase
    .channel('moz_agent_jobs_pending')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'moz_agent_jobs',
      filter: 'status=eq.pending'
    }, payload => onJob(payload.new))
    .subscribe()
```

Claim a job (guards against a second instance grabbing the same row):

```js
const claimJob = (supabase, jobId, instanceId) =>
  supabase
    .from('moz_agent_jobs')
    .update({ status: 'claimed', claimed_by: instanceId, claimed_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select()
```

Resolve a job:

```js
const completeJob = (supabase, jobId, result) =>
  supabase
    .from('moz_agent_jobs')
    .update({ status: 'done', result, completed_at: new Date().toISOString() })
    .eq('id', jobId)

const failJob = (supabase, jobId, error) =>
  supabase
    .from('moz_agent_jobs')
    .update({ status: 'failed', error, completed_at: new Date().toISOString() })
    .eq('id', jobId)
```

Insert a job manually for testing (only works if the domain is enabled, and
allow_write'd for a submit job — the DB trigger rejects it otherwise):

```js
const createParseJob = (supabase, domain, payload) =>
  supabase
    .from('moz_agent_jobs')
    .insert({ domain, type: 'parse', payload })

const createSubmitJob = (supabase, domain, payload) =>
  supabase
    .from('moz_agent_jobs')
    .insert({ domain, type: 'submit', payload })
```

## Next steps

- pick a transport for the agent connection (websocket vs native messaging)
- add the agent server (node), with HURL tests against its HTTP/WS endpoints
- content script for page-level actions
- auth/session handoff between extension and agent server
