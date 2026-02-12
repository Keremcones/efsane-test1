-- Add Telegram delivery tracking fields for active_signals
ALTER TABLE public.active_signals
ADD COLUMN IF NOT EXISTS telegram_status TEXT,
ADD COLUMN IF NOT EXISTS telegram_error TEXT,
ADD COLUMN IF NOT EXISTS telegram_sent_at TIMESTAMPTZ;
