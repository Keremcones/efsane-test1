-- Setup pg_cron job to check alarm signals every 1 minute
-- This will trigger the check-alarm-signals edge function

-- Schedule the job to run every 1 minute
SELECT cron.schedule(
  'check-alarm-signals',
  '* * * * *',
  'SELECT net.http_post(
    ''https://jcrbhekrphxodxhkuzju.supabase.co/functions/v1/check-alarm-signals'',
    jsonb_build_object(''source'', ''cron'')
  ) as request_id;'
);
