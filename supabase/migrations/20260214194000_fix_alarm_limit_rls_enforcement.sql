-- Harden alarm limit enforcement by removing permissive INSERT/UPDATE policies
-- and making limit resolution deterministic for users without profile rows.

CREATE OR REPLACE FUNCTION public.get_user_alarm_limit(p_user_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT CASE
        WHEN up.is_admin = true THEN -1
        WHEN up.max_alarm_count IS NOT NULL THEN up.max_alarm_count
        WHEN up.membership_type IN ('plus', 'premium') THEN 3
        ELSE 0
      END
      FROM public.user_profiles up
      WHERE up.id = p_user_id
      LIMIT 1
    ),
    0
  );
$$;

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'alarms'
      AND cmd IN ('INSERT', 'UPDATE')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.alarms', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "Users can insert limited user alarms"
  ON public.alarms FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND (
      type <> 'user_alarm'
      OR COALESCE(is_active, true) = false
      OR public.get_user_alarm_limit(auth.uid()) < 0
      OR public.get_active_user_alarm_count(auth.uid()) < public.get_user_alarm_limit(auth.uid())
    )
  );

CREATE POLICY "Users can update limited user alarms"
  ON public.alarms FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND (
      type <> 'user_alarm'
      OR COALESCE(is_active, true) = false
      OR public.get_user_alarm_limit(auth.uid()) < 0
      OR public.get_active_user_alarm_count(auth.uid(), id) < public.get_user_alarm_limit(auth.uid())
    )
  );
