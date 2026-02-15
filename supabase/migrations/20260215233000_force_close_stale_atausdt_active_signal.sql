-- One-time cleanup for stale ATAUSDT futures signals stuck as ACTIVE
-- Closes only old records linked to alarms without open Binance order id.

UPDATE public.active_signals s
SET
  status = 'CLOSED',
  close_reason = 'EXTERNAL_CLOSE',
  profit_loss = COALESCE(s.profit_loss, 0),
  closed_at = COALESCE(s.closed_at, NOW()),
  telegram_close_status = NULL,
  telegram_close_error = NULL
FROM public.alarms a
WHERE a.id = s.alarm_id
  AND s.status IN ('ACTIVE', 'active')
  AND UPPER(COALESCE(s.symbol, '')) = 'ATAUSDT'
  AND LOWER(COALESCE(s.market_type, '')) = 'futures'
  AND s.created_at < NOW() - INTERVAL '10 minutes'
  AND COALESCE(TRIM(a.binance_order_id), '') = '';
