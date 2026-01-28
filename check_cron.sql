-- Check all scheduled cron jobs
SELECT * FROM cron.job;

-- Check recent job runs
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
