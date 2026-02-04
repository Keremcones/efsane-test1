alter table if exists public.user_binance_keys
  add column if not exists futures_limit_timeout_seconds integer default 60,
  add column if not exists futures_limit_fallback_to_market boolean default true;