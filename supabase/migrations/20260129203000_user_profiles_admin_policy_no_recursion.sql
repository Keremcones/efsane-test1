-- Fix admin policies to avoid self-referential RLS recursion
DROP POLICY IF EXISTS "user_profiles_admin_select" ON public.user_profiles;
DROP POLICY IF EXISTS "user_profiles_admin_update" ON public.user_profiles;

CREATE POLICY "user_profiles_admin_select"
  ON public.user_profiles
  FOR SELECT
  USING ((auth.jwt() ->> 'email') = 'asd@asd.com');

CREATE POLICY "user_profiles_admin_update"
  ON public.user_profiles
  FOR UPDATE
  USING ((auth.jwt() ->> 'email') = 'asd@asd.com');
