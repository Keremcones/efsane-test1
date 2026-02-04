-- Cron lock table for preventing duplicate runs
create table if not exists public.cron_locks (
  name text primary key,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text,
  last_request_id text,
  updated_at timestamptz default now()
);

-- Optional index for monitoring
create index if not exists cron_locks_updated_at_idx on public.cron_locks (updated_at desc);
