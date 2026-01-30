-- Setup pg_cron job to check alarm signals every minute
-- This will trigger the check-alarm-signals edge function
-- Updated (2026-01-29): Added Authorization header with CRON_SECRET

-- Delete existing jobs if they exist
SELECT cron.unschedule('check-alarm-signals');

-- Schedule the job to run every minute with Authorization header
SELECT cron.schedule(
  'check-alarm-signals',
  '* * * * *',
  'SELECT net.http_post(
    ''https://jcrbhekrphxodxhkuzju.supabase.co/functions/v1/check-alarm-signals'',
    jsonb_build_object(''source'', ''cron'', ''timestamp'', now()::text),
    jsonb_build_object(
      ''headers'', jsonb_build_object(
        ''Content-Type'', ''application/json'',
        ''Authorization'', ''Bearer your-cron-secret-for-protection''
      )
    )
  ) as request_id;'
);
