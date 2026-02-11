-- Allow plus membership type in user_profiles
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints
    WHERE  table_schema = 'public'
    AND    table_name = 'user_profiles'
    AND    constraint_name = 'user_profiles_membership_type_check'
  ) THEN
    ALTER TABLE public.user_profiles
      DROP CONSTRAINT user_profiles_membership_type_check;
  END IF;
END $$;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_membership_type_check
  CHECK (membership_type IN ('standard', 'plus', 'premium'));
