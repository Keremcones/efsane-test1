-- Set free users alarm limit to 0 (no active user alarms)
-- Plus/Premium default remains 3, admins remain unlimited.

CREATE OR REPLACE FUNCTION public.get_user_alarm_limit(p_user_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN up.is_admin = true THEN NULL
    WHEN up.max_alarm_count IS NOT NULL THEN up.max_alarm_count
    WHEN up.membership_type IN ('plus', 'premium') THEN 3
    ELSE 0
  END
  FROM public.user_profiles up
  WHERE up.id = p_user_id
  LIMIT 1;
$$;
