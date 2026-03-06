-- Monthly membership day management
-- 1) Existing plus/premium users get 999 days
-- 2) Expired paid memberships auto-fall back to standard
-- 3) Cron runs periodic expiry enforcement

CREATE OR REPLACE FUNCTION public.expire_outdated_memberships()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected_count INTEGER := 0;
BEGIN
  UPDATE public.user_profiles
  SET
    membership_type = 'standard',
    membership_expires_at = NULL,
    max_alarm_count = NULL,
    updated_at = NOW()
  WHERE
    COALESCE(is_admin, false) = false
    AND membership_type IN ('plus', 'premium')
    AND membership_expires_at IS NOT NULL
    AND membership_expires_at <= NOW();

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.expire_outdated_memberships() TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_outdated_memberships() TO service_role;

-- Existing paid users start from 999 days from now
UPDATE public.user_profiles
SET
  membership_expires_at = NOW() + INTERVAL '999 days',
  updated_at = NOW()
WHERE
  COALESCE(is_admin, false) = false
  AND membership_type IN ('plus', 'premium');

-- Ensure any already-expired rows are normalized
SELECT public.expire_outdated_memberships();

-- Keep membership status automatically in sync
DO $$
DECLARE
  existing_job_id BIGINT;
BEGIN
  BEGIN
    SELECT jobid
    INTO existing_job_id
    FROM cron.job
    WHERE jobname = 'expire-memberships'
    ORDER BY jobid DESC
    LIMIT 1;

    IF existing_job_id IS NOT NULL THEN
      PERFORM cron.unschedule(existing_job_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    PERFORM cron.schedule(
      'expire-memberships',
      '0 * * * *',
      $job$SELECT public.expire_outdated_memberships();$job$
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Skipping cron schedule for expire-memberships: %', SQLERRM;
  END;
END;
$$;
