alter table public.user_binance_keys
  drop column if exists use_mark_price,
  drop column if exists use_tick_rounding;
