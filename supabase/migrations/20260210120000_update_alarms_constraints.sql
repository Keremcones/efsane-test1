-- Normalize alarms status and extend allowed types/close reasons

ALTER TABLE public.alarms
DROP CONSTRAINT IF EXISTS alarms_type_check;

ALTER TABLE public.alarms
ADD CONSTRAINT alarms_type_check
CHECK (type IN ('user_alarm', 'auto_signal', 'PRICE_LEVEL', 'ACTIVE_TRADE', 'SIGNAL'));

ALTER TABLE public.alarms
ADD COLUMN IF NOT EXISTS close_reason VARCHAR(20);

ALTER TABLE public.alarms
DROP CONSTRAINT IF EXISTS alarms_close_reason_check;

ALTER TABLE public.alarms
ADD CONSTRAINT alarms_close_reason_check
CHECK (close_reason IN ('TP_HIT', 'SL_HIT', 'MANUAL', 'EXPIRED', 'TIMEOUT'));

UPDATE public.alarms
SET status = 'ACTIVE'
WHERE status ILIKE 'AKTIF';

UPDATE public.alarms
SET status = 'CLOSED'
WHERE status ILIKE 'KAPATILDI';

UPDATE public.alarms
SET status = 'ACTIVE'
WHERE status IS NULL;
