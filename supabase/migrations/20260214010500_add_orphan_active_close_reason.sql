-- Allow ORPHAN_ACTIVE_NO_TRADE and NO_POSITION close reasons for active_signals
ALTER TABLE public.active_signals
DROP CONSTRAINT IF EXISTS active_signals_close_reason_check;

ALTER TABLE public.active_signals
ADD CONSTRAINT active_signals_close_reason_check
CHECK (close_reason IN (
  'TP_HIT',
  'SL_HIT',
  'CLOSED_BY_USER',
  'TIMEOUT',
  'NOT_FILLED',
  'TP_HIT_NO_POSITION',
  'SL_HIT_NO_POSITION',
  'ORPHAN_ACTIVE_NO_TRADE'
));
