-- Add close-notification Telegram tracking fields for active_signals
ALTER TABLE public.active_signals
ADD COLUMN IF NOT EXISTS telegram_close_status TEXT,
ADD COLUMN IF NOT EXISTS telegram_close_error TEXT,
ADD COLUMN IF NOT EXISTS telegram_close_sent_at TIMESTAMPTZ;
