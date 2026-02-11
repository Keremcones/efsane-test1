create table if not exists public.admin_announcements (
  key text primary key,
  title text,
  message text,
  is_active boolean default false,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.admin_announcements enable row level security;

drop policy if exists admin_announcements_select on public.admin_announcements;
drop policy if exists admin_announcements_insert on public.admin_announcements;
drop policy if exists admin_announcements_update on public.admin_announcements;
drop policy if exists admin_announcements_delete on public.admin_announcements;

create policy admin_announcements_select
  on public.admin_announcements
  for select to public
  using (true);

create policy admin_announcements_insert
  on public.admin_announcements
  for insert to authenticated
  with check (
    exists (
      select 1 from public.user_profiles up
      where up.id = auth.uid() and up.is_admin = true
    )
  );

create policy admin_announcements_update
  on public.admin_announcements
  for update to authenticated
  using (
    exists (
      select 1 from public.user_profiles up
      where up.id = auth.uid() and up.is_admin = true
    )
  );

create policy admin_announcements_delete
  on public.admin_announcements
  for delete to authenticated
  using (
    exists (
      select 1 from public.user_profiles up
      where up.id = auth.uid() and up.is_admin = true
    )
  );

drop trigger if exists update_admin_announcements_updated_at on public.admin_announcements;
create trigger update_admin_announcements_updated_at
  before update on public.admin_announcements
  for each row
  execute function update_updated_at_column();
