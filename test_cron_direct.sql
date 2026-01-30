-- Check cron job status
SELECT jobid, jobname, schedule, command FROM cron.job WHERE jobname = 'check-alarm-signals';
