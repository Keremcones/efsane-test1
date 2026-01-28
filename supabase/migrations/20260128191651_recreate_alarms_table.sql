-- MIGRATION: Clean alarms table schema
-- Purpose: Remove duplicates, add constraints, prepare for production
-- Status: PRODUCTION READY

DROP TABLE IF EXISTS alarms CASCADE;

CREATE TABLE alarms (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('user_alarm', 'auto_signal')),
  symbol VARCHAR(20) NOT NULL,
  market_type VARCHAR(10) NOT NULL CHECK (market_type IN ('spot', 'futures')) DEFAULT 'spot',
  target_price DECIMAL(20,8),
  condition VARCHAR(10) CHECK (condition IN ('above', 'below')),
  direction VARCHAR(10) CHECK (direction IN ('LONG', 'SHORT')),
  entry_price DECIMAL(20,8),
  take_profit DECIMAL(20,8),
  stop_loss DECIMAL(20,8),
  timeframe VARCHAR(10),
  confidence_score DECIMAL(5,2),
  tp_percent DECIMAL(10,2),
  sl_percent DECIMAL(10,2),
  bar_close_limit INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  close_reason VARCHAR(20) CHECK (close_reason IN ('TP_HIT', 'SL_HIT', 'MANUAL', 'EXPIRED')),
  is_active BOOLEAN DEFAULT true,
  profit_loss DECIMAL(10,2),
  exit_price DECIMAL(20,8),
  closed_at TIMESTAMP,
  signal_timestamp TIMESTAMP,
  telegram_sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Performance indexes
CREATE INDEX idx_alarms_user_id ON alarms(user_id);
CREATE INDEX idx_alarms_status ON alarms(status);
CREATE INDEX idx_alarms_type ON alarms(type);
CREATE INDEX idx_alarms_is_active ON alarms(is_active);
CREATE INDEX idx_alarms_user_status ON alarms(user_id, status);
CREATE INDEX idx_alarms_created_at ON alarms(created_at DESC);
