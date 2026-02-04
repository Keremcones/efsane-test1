alter table if exists public.user_binance_keys
  add column if not exists futures_order_type text default 'market',
  add column if not exists futures_limit_tolerance_percent numeric default 0.3;