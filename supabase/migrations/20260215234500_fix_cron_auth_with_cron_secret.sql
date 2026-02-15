-- Ensure cron job calls edge function with CRON_SECRET (not anon JWT)
SELECT cron.unschedule('check-alarm-signals');

SELECT cron.schedule(
  'check-alarm-signals',
  '* * * * *',
  $$SELECT net.http_post(
      url := 'https://jcrbhekrphxodxhkuzju.functions.supabase.co/check-alarm-signals',
      body := jsonb_build_object('source', 'cron', 'timestamp', now()::text),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer your-cron-secret-for-protection'
      )
  );$$
);
