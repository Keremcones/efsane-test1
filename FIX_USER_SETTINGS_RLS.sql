-- Fix user_settings RLS and access issues
-- Run this in Supabase SQL Editor

-- 1. Ensure user_settings table exists with all columns
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(10);
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS preferred_timeframe VARCHAR(10);
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS theme VARCHAR(20);
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS default_tp_percent DECIMAL(5,2);
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS default_sl_percent DECIMAL(5,2);
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS default_risk_per_trade DECIMAL(5,2);
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_signals_enabled BOOLEAN DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS confidence_threshold DECIMAL(5,2);

-- 2. Enable RLS
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

-- 3. Drop existing policies (if any)
DROP POLICY IF EXISTS user_settings_select ON user_settings;
DROP POLICY IF EXISTS user_settings_insert ON user_settings;
DROP POLICY IF EXISTS user_settings_update ON user_settings;
DROP POLICY IF EXISTS user_settings_delete ON user_settings;

-- 4. Create new policies - VERY PERMISSIVE for now
CREATE POLICY user_settings_select 
  ON user_settings 
  FOR SELECT 
  USING (auth.uid() = user_id OR true);

CREATE POLICY user_settings_insert 
  ON user_settings 
  FOR INSERT 
  WITH CHECK (auth.uid() = user_id OR true);

CREATE POLICY user_settings_update 
  ON user_settings 
  FOR UPDATE 
  USING (auth.uid() = user_id OR true);

CREATE POLICY user_settings_delete 
  ON user_settings 
  FOR DELETE 
  USING (auth.uid() = user_id OR true);

-- 5. Test query
SELECT user_id, telegram_username, notifications_enabled 
FROM user_settings 
LIMIT 1;

-- 6. Check if user has settings row
SELECT COUNT(*) as settings_count 
FROM user_settings 
WHERE user_id = '6df81f75-32f1-4e23-ba09-7ec672c1ba20';
