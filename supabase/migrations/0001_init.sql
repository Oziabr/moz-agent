-- moz-agent initial schema
-- run in supabase sql editor, or via `supabase db push`
-- all objects prefixed moz_agent_ since this project has other apps in it

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- moz_agent_enabled_domains
-- one row per (user, domain). enabled = general read access (parse/crawl,
-- both GET only). allow_write = extra opt-in specifically for form submission.
-- ---------------------------------------------------------------------------
create table moz_agent_enabled_domains (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  domain text not null,
  enabled boolean not null default true,
  allow_write boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, domain)
);

create index moz_agent_enabled_domains_user_id_idx on moz_agent_enabled_domains (user_id);

-- ---------------------------------------------------------------------------
-- moz_agent_jobs
-- dispatch queue. rows are inserted by the dispatcher (or the user's own
-- extension), pushed to the extension over realtime, claimed, then resolved.
-- ---------------------------------------------------------------------------
create table moz_agent_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  domain text not null,
  type text not null check (type in ('parse', 'crawl', 'submit')),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'done', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  claimed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz
);

create index moz_agent_jobs_user_id_status_idx on moz_agent_jobs (user_id, status);
create index moz_agent_jobs_domain_idx on moz_agent_jobs (domain);

-- ---------------------------------------------------------------------------
-- updated_at bookkeeping
-- ---------------------------------------------------------------------------
create function moz_agent_set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger moz_agent_enabled_domains_set_updated_at
  before update on moz_agent_enabled_domains
  for each row execute function moz_agent_set_updated_at();

create trigger moz_agent_jobs_set_updated_at
  before update on moz_agent_jobs
  for each row execute function moz_agent_set_updated_at();

-- ---------------------------------------------------------------------------
-- submit gate: a 'submit' job can only be created for a domain the user has
-- explicitly allow_write'd. parse/crawl only need enabled = true.
-- ---------------------------------------------------------------------------
create function moz_agent_check_job_domain_permission() returns trigger as $$
declare
  domain_row moz_agent_enabled_domains%rowtype;
begin
  select * into domain_row
    from moz_agent_enabled_domains
    where user_id = new.user_id
      and domain = new.domain;

  if domain_row is null or domain_row.enabled = false then
    raise exception 'domain % is not enabled for this user', new.domain;
  end if;

  if new.type = 'submit' and domain_row.allow_write = false then
    raise exception 'domain % is not allowed to submit for this user', new.domain;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger moz_agent_jobs_check_domain_permission
  before insert on moz_agent_jobs
  for each row execute function moz_agent_check_job_domain_permission();

-- ---------------------------------------------------------------------------
-- lock down what an update can touch: extension may only move a job through
-- its lifecycle (status/result/error/claimed_by/timestamps), never rewrite
-- user_id, domain, type or payload after creation. without this, the submit
-- gate above could be bypassed by inserting a 'parse' job then updating its
-- type to 'submit'.
-- ---------------------------------------------------------------------------
create function moz_agent_lock_job_identity() returns trigger as $$
begin
  if new.user_id is distinct from old.user_id
    or new.domain is distinct from old.domain
    or new.type is distinct from old.type
    or new.payload is distinct from old.payload then
    raise exception 'moz_agent_jobs.user_id, domain, type and payload are immutable after insert';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger moz_agent_jobs_lock_identity
  before update on moz_agent_jobs
  for each row execute function moz_agent_lock_job_identity();

-- ---------------------------------------------------------------------------
-- row level security
-- ---------------------------------------------------------------------------
alter table moz_agent_enabled_domains enable row level security;
alter table moz_agent_jobs enable row level security;

create policy moz_agent_enabled_domains_owner_select on moz_agent_enabled_domains
  for select using (auth.uid() = user_id);

create policy moz_agent_enabled_domains_owner_insert on moz_agent_enabled_domains
  for insert with check (auth.uid() = user_id);

create policy moz_agent_enabled_domains_owner_update on moz_agent_enabled_domains
  for update using (auth.uid() = user_id);

create policy moz_agent_enabled_domains_owner_delete on moz_agent_enabled_domains
  for delete using (auth.uid() = user_id);

create policy moz_agent_jobs_owner_select on moz_agent_jobs
  for select using (auth.uid() = user_id);

create policy moz_agent_jobs_owner_insert on moz_agent_jobs
  for insert with check (auth.uid() = user_id);

-- extension can update status/result/claimed_by on its own jobs, not user_id/domain/type
create policy moz_agent_jobs_owner_update on moz_agent_jobs
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- realtime: extension subscribes to jobs filtered by user_id + status
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table moz_agent_jobs;
