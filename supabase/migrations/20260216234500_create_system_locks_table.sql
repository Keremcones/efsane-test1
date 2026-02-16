create table if not exists public.system_locks (
  lock_name text primary key,
  owner_id text,
  locked_until timestamptz not null default to_timestamp(0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists system_locks_locked_until_idx
  on public.system_locks (locked_until);

alter table public.system_locks enable row level security;

drop policy if exists system_locks_service_role_all on public.system_locks;
create policy system_locks_service_role_all
  on public.system_locks
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');