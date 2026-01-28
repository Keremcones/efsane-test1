-- Tablolar sıfırla
DROP TABLE IF EXISTS alarms CASCADE;
DROP TABLE IF EXISTS user_settings CASCADE;

-- Alarms table oluştur
CREATE TABLE alarms (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('user_alarm', 'auto_signal')),
  symbol VARCHAR(20) NOT NULL,
  timeframe VARCHAR(10),
  market_type VARCHAR(10) NOT NULL CHECK (market_type IN ('spot', 'futures')) DEFAULT 'spot',
  entry_price DECIMAL(20,8),
  take_profit DECIMAL(20,8),
  stop_loss DECIMAL(20,8),
  target_price DECIMAL(20,8),
  condition VARCHAR(50),
  tp_percent DECIMAL(5,2),
  sl_percent DECIMAL(5,2),
  bar_close_limit INT,
  status VARCHAR(20) DEFAULT 'active',
  is_active BOOLEAN DEFAULT true,
  telegram_enabled BOOLEAN DEFAULT true,
  telegram_chat_id VARCHAR(50),
  confidence_score DECIMAL(5,2),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE INDEX idx_alarms_user_id ON alarms(user_id);
CREATE INDEX idx_alarms_status ON alarms(status);
CREATE INDEX idx_alarms_type ON alarms(type);

-- User Settings table
CREATE TABLE IF NOT EXISTS user_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  telegram_username VARCHAR(50),
  notifications_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- RLS Policies
ALTER TABLE alarms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alarms_select ON alarms;
CREATE POLICY alarms_select ON alarms FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS alarms_insert ON alarms;
CREATE POLICY alarms_insert ON alarms FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS alarms_update ON alarms;
CREATE POLICY alarms_update ON alarms FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS alarms_delete ON alarms;
CREATE POLICY alarms_delete ON alarms FOR DELETE USING (auth.uid() = user_id);
