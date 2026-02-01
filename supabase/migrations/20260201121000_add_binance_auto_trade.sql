-- Add Binance auto-trade support

CREATE TABLE IF NOT EXISTS user_binance_keys (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  api_key TEXT NOT NULL,
  api_secret TEXT NOT NULL,

  auto_trade_enabled BOOLEAN DEFAULT false,

  futures_enabled BOOLEAN DEFAULT false,
  futures_leverage INTEGER DEFAULT 10,
  futures_position_size_percent NUMERIC DEFAULT 5,

  spot_enabled BOOLEAN DEFAULT false,
  spot_position_size_percent NUMERIC DEFAULT 5,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id)
);

ALTER TABLE user_binance_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own keys" ON user_binance_keys
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own keys" ON user_binance_keys
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own keys" ON user_binance_keys
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own keys" ON user_binance_keys
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_user_binance_keys_updated_at
  BEFORE UPDATE ON user_binance_keys
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE alarms ADD COLUMN IF NOT EXISTS auto_trade_enabled BOOLEAN DEFAULT false;
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS binance_order_id TEXT;
