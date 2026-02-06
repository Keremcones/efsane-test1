alter table public.user_binance_keys
add column if not exists futures_entry_type text default 'MARKET',
add column if not exists futures_limit_deviation_percent numeric default 0.3,
add column if not exists futures_limit_timeout_seconds integer default 60;
