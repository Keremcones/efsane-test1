-- MIGRATION: Enable RLS and create access policies
-- Purpose: Secure database with Row Level Security
-- Status: PRODUCTION READY

-- Enable RLS on protected tables
ALTER TABLE alarms ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid conflicts (idempotent)
DROP POLICY IF EXISTS "Users can view own alarms" ON alarms;
DROP POLICY IF EXISTS "Users can create own alarms" ON alarms;
DROP POLICY IF EXISTS "Users can update own alarms" ON alarms;
DROP POLICY IF EXISTS "Users can delete own alarms" ON alarms;

-- Alarms policies
CREATE POLICY "Users can view own alarms"
  ON alarms FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own alarms"
  ON alarms FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own alarms"
  ON alarms FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own alarms"
  ON alarms FOR DELETE
  USING (auth.uid() = user_id);

-- Drop existing user_settings policies
DROP POLICY IF EXISTS "Users can view own settings" ON user_settings;
DROP POLICY IF EXISTS "Users can create own settings" ON user_settings;
DROP POLICY IF EXISTS "Users can update own settings" ON user_settings;
DROP POLICY IF EXISTS "Users can delete own settings" ON user_settings;

-- User settings policies
CREATE POLICY "Users can view own settings"
  ON user_settings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own settings"
  ON user_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own settings"
  ON user_settings FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own settings"
  ON user_settings FOR DELETE
  USING (auth.uid() = user_id);
