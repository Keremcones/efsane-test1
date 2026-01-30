-- Fix security warnings from Supabase linter

-- 1) Function search_path mutable
ALTER FUNCTION public.update_updated_at_column()
  SET search_path = public, pg_catalog;

-- 2) Extension in public schema
CREATE SCHEMA IF NOT EXISTS extensions;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'http') THEN
    RAISE NOTICE 'Extension "http" does not support SET SCHEMA in this environment; leaving as-is.';
  END IF;
END $$;

-- 3) Overly permissive RLS policy on user_settings
DROP POLICY IF EXISTS user_settings_all ON public.user_settings;
DROP POLICY IF EXISTS "user_settings_all" ON public.user_settings;
