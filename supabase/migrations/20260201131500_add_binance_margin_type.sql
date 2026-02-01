alter table public.user_binance_keys
add column if not exists futures_margin_type text default 'CROSS';