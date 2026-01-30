-- Fix admin access policy for user_profiles
DROP POLICY IF EXISTS "user_profiles_admin_select" ON public.user_profiles;
DROP POLICY IF EXISTS "user_profiles_admin_update" ON public.user_profiles;

-- Allow admins (marked in user_profiles) to read/update any profile
CREATE POLICY "user_profiles_admin_select"
  ON public.user_profiles
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles p
      WHERE p.id = auth.uid()
        AND p.is_admin = true
    )
  );

CREATE POLICY "user_profiles_admin_update"
  ON public.user_profiles
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles p
      WHERE p.id = auth.uid()
        AND p.is_admin = true
    )
  );
