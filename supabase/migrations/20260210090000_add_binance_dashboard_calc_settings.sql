alter table public.user_binance_keys
  add column if not exists use_mark_price boolean not null default false,
  add column if not exists use_tick_rounding boolean not null default false;
