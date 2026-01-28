-- MIGRATION: Expand user_settings table with trading preferences
-- Purpose: Add missing columns without losing existing data
-- Status: DATA-SAFE (uses ALTER TABLE, preserves existing record)

-- Add missing columns to user_settings
-- This uses ALTER TABLE to preserve existing user data
ALTER TABLE user_settings 
  ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(10) DEFAULT 'tr',
  ADD COLUMN IF NOT EXISTS preferred_timeframe VARCHAR(10) DEFAULT '1h',
  ADD COLUMN IF NOT EXISTS theme VARCHAR(20) DEFAULT 'dark',
  ADD COLUMN IF NOT EXISTS default_tp_percent DECIMAL(10,2) DEFAULT 5.0,
  ADD COLUMN IF NOT EXISTS default_sl_percent DECIMAL(10,2) DEFAULT 3.0,
  ADD COLUMN IF NOT EXISTS default_risk_per_trade DECIMAL(5,2) DEFAULT 2.0,
  ADD COLUMN IF NOT EXISTS auto_signals_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS confidence_threshold INTEGER DEFAULT 60;

-- Create index on user_id for fast lookups
CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);
