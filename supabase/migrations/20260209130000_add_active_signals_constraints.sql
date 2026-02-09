-- Add signal_timestamp for active_signals and enforce uniqueness per bar
ALTER TABLE public.active_signals
ADD COLUMN IF NOT EXISTS signal_timestamp TIMESTAMP WITH TIME ZONE;

UPDATE public.active_signals
SET signal_timestamp = created_at
WHERE signal_timestamp IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_signals_unique
ON public.active_signals (user_id, symbol, direction, signal_timestamp)
WHERE status = 'ACTIVE';

-- Ensure FK uses alarms table (named constraint)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_active_signals_alarm'
  ) THEN
    ALTER TABLE public.active_signals
    ADD CONSTRAINT fk_active_signals_alarm
    FOREIGN KEY (alarm_id)
    REFERENCES public.alarms(id)
    ON DELETE CASCADE;
  END IF;
END $$;

-- Extend close_reason constraint to include TIMEOUT
ALTER TABLE public.active_signals
DROP CONSTRAINT IF EXISTS active_signals_close_reason_check;

ALTER TABLE public.active_signals
ADD CONSTRAINT active_signals_close_reason_check
CHECK (close_reason IN ('TP_HIT', 'SL_HIT', 'CLOSED_BY_USER', 'TIMEOUT'));
