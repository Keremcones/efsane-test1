-- Fix user_settings RLS and access issues

-- 1. Ensure user_settings table has all columns
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

-- 4. Create policies
CREATE POLICY user_settings_select
  ON user_settings
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY user_settings_insert
  ON user_settings
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_settings_update
  ON user_settings
  FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY user_settings_delete
  ON user_settings
  FOR DELETE
  USING (auth.uid() = user_id);