alter table if exists public.cron_locks
  add column if not exists last_started_at timestamptz,
  add column if not exists last_finished_at timestamptz,
  add column if not exists last_status text,
  add column if not exists last_request_id text,
  add column if not exists updated_at timestamptz default now();

create index if not exists cron_locks_updated_at_idx on public.cron_locks (updated_at desc);