-- Fix pg_net http_post signature so headers don't become query params

SELECT cron.unschedule('check-alarm-signals');

SELECT cron.schedule(
  'check-alarm-signals',
  '* * * * *',
  $$SELECT net.http_post(
      'https://jcrbhekrphxodxhkuzju.functions.supabase.co/check-alarm-signals',
      jsonb_build_object('source', 'cron', 'timestamp', now()::text),
      '{}'::jsonb,
      jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer your-cron-secret-for-protection',
        'apikey', 'your-anon-or-service-role-key'
      )
    ) AS request_id;$$
);
