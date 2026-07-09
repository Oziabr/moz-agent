# DB examples

Each operation below is shown as a `supabase-js` call (what the extension
actually runs) and the raw SQL equivalent (useful in the SQL editor, or a
psql session, for debugging RLS/trigger behavior directly).

`user_id` defaults to `auth.uid()`, which is only populated under an
authenticated PostgREST/supabase-js request. Running the SQL directly as the
`postgres` role means `auth.uid()` is null, so the samples below pass
`user_id` explicitly - swap in a real user uuid.

## Enable a domain (read-only, parse/crawl)

```js
const enableDomain = (supabase, domain) =>
  supabase
    .from('moz_agent_enabled_domains')
    .upsert({ domain, enabled: true }, { onConflict: 'user_id,domain' })
```

```sql
insert into moz_agent_enabled_domains (user_id, domain, enabled)
values ('<user-uuid>', 'example.com', true)
on conflict (user_id, domain)
do update set enabled = true;
```

## Enable a domain for form submission too

```js
const enableDomainForWrite = (supabase, domain) =>
  supabase
    .from('moz_agent_enabled_domains')
    .upsert({ domain, enabled: true, allow_write: true }, { onConflict: 'user_id,domain' })
```

```sql
insert into moz_agent_enabled_domains (user_id, domain, enabled, allow_write)
values ('<user-uuid>', 'example.com', true, true)
on conflict (user_id, domain)
do update set enabled = true, allow_write = true;
```

## Disable a domain

```js
const disableDomain = (supabase, domain) =>
  supabase
    .from('moz_agent_enabled_domains')
    .update({ enabled: false, allow_write: false })
    .eq('domain', domain)
```

```sql
update moz_agent_enabled_domains
set enabled = false, allow_write = false
where user_id = '<user-uuid>'
  and domain = 'example.com';
```

## Subscribe to pending jobs over realtime

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

No SQL equivalent - this rides on Postgres logical replication under the
hood, not a query you can run standalone. To see the same rows manually,
just poll:

```sql
select * from moz_agent_jobs
where user_id = '<user-uuid>'
  and status = 'pending'
order by created_at;
```

## Claim a job

Guards against a second instance grabbing the same row - the `status = 'pending'`
check in the `where` clause means only one concurrent update wins.

```js
const claimJob = (supabase, jobId, instanceId) =>
  supabase
    .from('moz_agent_jobs')
    .update({ status: 'claimed', claimed_by: instanceId, claimed_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select()
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
const createParseJob = (supabase, domain, payload) =>
  supabase
    .from('moz_agent_jobs')
    .insert({ domain, type: 'parse', payload })

const createSubmitJob = (supabase, domain, payload) =>
  supabase
    .from('moz_agent_jobs')
    .insert({ domain, type: 'submit', payload })
```

```sql
insert into moz_agent_jobs (user_id, domain, type, payload)
values ('<user-uuid>', 'example.com', 'parse', '{"selector": ".title"}'::jsonb);

insert into moz_agent_jobs (user_id, domain, type, payload)
values ('<user-uuid>', 'example.com', 'submit', '{"form": "#contact"}'::jsonb);
```
