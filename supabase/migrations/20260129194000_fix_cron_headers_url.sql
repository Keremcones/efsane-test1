-- Fix cron job URL and headers formatting

SELECT cron.unschedule('check-alarm-signals');

SELECT cron.schedule(
  'check-alarm-signals',
  '* * * * *',
  $$SELECT net.http_post(
      'https://jcrbhekrphxodxhkuzju.functions.supabase.co/check-alarm-signals',
      jsonb_build_object('source', 'cron', 'timestamp', now()::text),
      jsonb_build_object(
        'headers', jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjcmJoZWtycGh4b2R4aGt1emp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkwOTY3MTQsImV4cCI6MjA4NDY3MjcxNH0.xg1dgP6uprsGg3Us-nUghbFc2xCrrQsSKOkz4c7MxAo',
          'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjcmJoZWtycGh4b2R4aGt1emp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkwOTY3MTQsImV4cCI6MjA4NDY3MjcxNH0.xg1dgP6uprsGg3Us-nUghbFc2xCrrQsSKOkz4c7MxAo'
        )
      )
    ) AS request_id;$$
);
