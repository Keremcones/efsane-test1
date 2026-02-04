alter table if exists public.active_signals
  add column if not exists signal_timestamp timestamptz;