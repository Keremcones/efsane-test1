-- Manually test the cron job logic
SELECT 
  'Testing cron job with net.http_request' as test,
  net.http_request(
    'POST',
    'https://jcrbhekrphxodxhkuzju.supabase.co/functions/v1/check-alarm-signals',
    jsonb_build_object('source', 'cron_manual_test', 'timestamp', now()::text),
    jsonb_build_object(
      'method', 'POST',
      'headers', jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjcmJoZWtycGh4b2R4aGt1emp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkwOTY3MTQsImV4cCI6MjA4NDY3MjcxNH0.xg1dgP6uprsGg3Us-nUghbFc2xCrrQsSKOkz4c7MxAo'
      )
    )
  ) as http_response;
