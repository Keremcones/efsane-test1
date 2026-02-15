-- Login event tracking for admin site statistics
create table if not exists public.login_events (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

create index if not exists idx_login_events_created_at on public.login_events(created_at desc);
create index if not exists idx_login_events_user_id_created_at on public.login_events(user_id, created_at desc);

alter table public.login_events enable row level security;

drop policy if exists "Users can insert own login events" on public.login_events;
create policy "Users can insert own login events"
  on public.login_events
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can view own login events" on public.login_events;
create policy "Users can view own login events"
  on public.login_events
  for select
  using (auth.uid() = user_id);

drop policy if exists "Admins can view all login events" on public.login_events;
create policy "Admins can view all login events"
  on public.login_events
  for select
  using (public.is_admin());
