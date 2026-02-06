-- Deduplicate ACTIVE signals per user/alarm before adding unique index
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY user_id, alarm_id
               ORDER BY created_at DESC, id DESC
           ) AS rn
    FROM public.active_signals
    WHERE status = 'ACTIVE'
)
DELETE FROM public.active_signals a
USING ranked r
WHERE a.id = r.id
  AND r.rn > 1;

-- Ensure only one ACTIVE signal per user/alarm
CREATE UNIQUE INDEX IF NOT EXISTS active_signals_unique_active_alarm
ON public.active_signals (user_id, alarm_id)
WHERE status = 'ACTIVE';
