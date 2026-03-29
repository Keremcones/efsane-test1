-- Add Telegram blocked-user cooldown tracking to suppress repeated 403 retries
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS telegram_blocked_until timestamptz,
  ADD COLUMN IF NOT EXISTS telegram_blocked_reason text;
