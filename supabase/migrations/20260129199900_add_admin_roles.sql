-- Add admin support + email to user_profiles
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

-- Ensure RLS is enabled
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Admin policies (admin email: asd@asd.com)
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

-- Seed admin flag if row already exists
UPDATE public.user_profiles
SET is_admin = true
WHERE email = 'asd@asd.com';
