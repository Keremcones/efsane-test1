-- Check all cron jobs
SELECT * FROM cron.job;

-- Check cron job logs (last 20 executions)
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- Get job execution history
SELECT job_id, database, command, nodename, nodeport, status, return_message, start_time 
FROM cron.job_run_details 
ORDER BY start_time DESC 
LIMIT 30;
