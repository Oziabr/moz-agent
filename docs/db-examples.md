# DB examples

Each operation below is shown as a call into `extension/supabase-client.js`
(a thin `fetch` wrapper - see the [README](../README.md#why-no-bundler) for
why there's no SDK) and the raw SQL equivalent (useful in the SQL editor, or
a psql session, for debugging RLS/trigger behavior directly).

`user_id` defaults to `auth.uid()`, which is only populated under an
authenticated PostgREST request (i.e. with a real user's access token in the
`Authorization` header). Running the SQL directly as the `postgres` role
means `auth.uid()` is null, so the samples below pass `user_id` explicitly -
swap in a real user uuid.

## Enable a domain (read-only, parse/crawl)

```js
const enableDomain = domain =>
  upsertRow('moz_agent_enabled_domains', { domain, enabled: true }, { onConflict: 'user_id,domain' })
```

```sql
insert into moz_agent_enabled_domains (user_id, domain, enabled)
values ('<user-uuid>', 'example.com', true)
on conflict (user_id, domain)
do update set enabled = true;
```

## Enable a domain for form submission too

```js
const enableDomainForWrite = domain =>
  upsertRow(
    'moz_agent_enabled_domains',
    { domain, enabled: true, allow_write: true },
    { onConflict: 'user_id,domain' }
  )
```

```sql
insert into moz_agent_enabled_domains (user_id, domain, enabled, allow_write)
values ('<user-uuid>', 'example.com', true, true)
on conflict (user_id, domain)
do update set enabled = true, allow_write = true;
```

## Disable a domain

```js
const disableDomain = domain =>
  updateRows('moz_agent_enabled_domains', { enabled: false, allow_write: false }, { domain: eq(domain) })
```

```sql
update moz_agent_enabled_domains
set enabled = false, allow_write = false
where user_id = '<user-uuid>'
  and domain = 'example.com';
```

## Poll for pending jobs

No push/realtime - `background.js` polls on a `browser.alarms` timer
instead (see the README). Same query either way:

```js
const getPendingJobs = () =>
  selectRows('moz_agent_jobs', { filters: { status: eq('pending') } })
```

```sql
select * from moz_agent_jobs
where user_id = '<user-uuid>'
  and status = 'pending'
order by created_at;
```

## Claim a job

Guards against a second instance grabbing the same row - the `status = 'pending'`
filter means only one concurrent update wins (PostgREST's `PATCH` only
touches rows matching the filter at the time it runs).

```js
const claimJob = (jobId, instanceId) =>
  updateRows(
    'moz_agent_jobs',
    { status: 'claimed', claimed_by: instanceId, claimed_at: new Date().toISOString() },
    { id: eq(jobId), status: eq('pending') }
  )
```

```sql
update moz_agent_jobs
set status = 'claimed', claimed_by = '<instance-id>', claimed_at = now()
where id = '<job-uuid>'
  and status = 'pending'
returning *;
```

## Resolve a job

```js
const completeJob = (jobId, result) =>
  updateRows('moz_agent_jobs', { status: 'done', result, completed_at: new Date().toISOString() }, { id: eq(jobId) })

const failJob = (jobId, error) =>
  updateRows('moz_agent_jobs', { status: 'failed', error, completed_at: new Date().toISOString() }, { id: eq(jobId) })
```

```sql
update moz_agent_jobs
set status = 'done', result = '{"key": "value"}'::jsonb, completed_at = now()
where id = '<job-uuid>';

update moz_agent_jobs
set status = 'failed', error = 'timeout', completed_at = now()
where id = '<job-uuid>';
```

## Insert a job manually for testing

Only works if the domain is enabled, and `allow_write`'d for a `submit`
job - the `moz_agent_jobs_check_domain_permission` trigger rejects it
otherwise.

```js
const createParseJob = (domain, payload) =>
  upsertRow('moz_agent_jobs', { domain, type: 'parse', payload })

const createSubmitJob = (domain, payload) =>
  upsertRow('moz_agent_jobs', { domain, type: 'submit', payload })
```

```sql
insert into moz_agent_jobs (user_id, domain, type, payload)
values ('<user-uuid>', 'example.com', 'parse', '{"selector": ".title"}'::jsonb);

insert into moz_agent_jobs (user_id, domain, type, payload)
values ('<user-uuid>', 'example.com', 'submit', '{"form": "#contact"}'::jsonb);
```
