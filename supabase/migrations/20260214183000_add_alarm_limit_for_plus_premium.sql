-- Add per-user alarm limits with default cap for Plus/Premium users

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS max_alarm_count INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'user_profiles'
      AND constraint_name = 'user_profiles_max_alarm_count_check'
  ) THEN
    ALTER TABLE public.user_profiles
      ADD CONSTRAINT user_profiles_max_alarm_count_check
      CHECK (max_alarm_count IS NULL OR max_alarm_count >= 1);
  END IF;
END $$;

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
    ELSE NULL
  END
  FROM public.user_profiles up
  WHERE up.id = p_user_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_active_user_alarm_count(
  p_user_id UUID,
  p_exclude_alarm_id BIGINT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.alarms a
  WHERE a.user_id = p_user_id
    AND a.type = 'user_alarm'
    AND COALESCE(a.is_active, true) = true
    AND (p_exclude_alarm_id IS NULL OR a.id <> p_exclude_alarm_id);
$$;

DROP POLICY IF EXISTS "Users can create own alarms" ON public.alarms;
DROP POLICY IF EXISTS "Users can update own alarms" ON public.alarms;

CREATE POLICY "Users can create own alarms"
  ON public.alarms FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND (
      type <> 'user_alarm'
      OR COALESCE(is_active, true) = false
      OR public.get_user_alarm_limit(auth.uid()) IS NULL
      OR public.get_active_user_alarm_count(auth.uid()) < public.get_user_alarm_limit(auth.uid())
    )
  );

CREATE POLICY "Users can update own alarms"
  ON public.alarms FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND (
      type <> 'user_alarm'
      OR COALESCE(is_active, true) = false
      OR public.get_user_alarm_limit(auth.uid()) IS NULL
      OR public.get_active_user_alarm_count(auth.uid(), id) < public.get_user_alarm_limit(auth.uid())
    )
  );
