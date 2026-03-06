-- Ensure expired paid memberships also remove active alarms

CREATE OR REPLACE FUNCTION public.expire_outdated_memberships()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected_count INTEGER := 0;
BEGIN
  WITH expired_users AS (
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
      AND membership_expires_at <= NOW()
    RETURNING id
  )
  DELETE FROM public.alarms a
  USING expired_users e
  WHERE
    a.user_id = e.id
    AND (
      a.status IS NULL
      OR UPPER(COALESCE(a.status, '')) = 'ACTIVE'
    );

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$;

SELECT public.expire_outdated_memberships();
