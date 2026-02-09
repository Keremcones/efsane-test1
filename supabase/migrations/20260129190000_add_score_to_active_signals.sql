-- Add score column to active_signals table
-- Score: Sinyal güven skoru (0-100)

ALTER TABLE public.active_signals
ADD COLUMN IF NOT EXISTS score DECIMAL(10, 2) DEFAULT 50;

-- Update close_reason constraint
ALTER TABLE public.active_signals
DROP CONSTRAINT IF EXISTS active_signals_close_reason_check;

ALTER TABLE public.active_signals
ADD CONSTRAINT active_signals_close_reason_check
CHECK (close_reason IN ('TP_HIT', 'SL_HIT', 'CLOSED_BY_USER'));

-- Add comment
COMMENT ON COLUMN public.active_signals.score IS 'Signal confidence score (0-100), calculated by generateSignalScore()';
