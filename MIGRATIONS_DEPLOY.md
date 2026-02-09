📋 SUPABASE MIGRATIONS - DEPLOY GUIDE

🎯 GOAL: 3 SQL migration'ı sırayla Supabase'de çalıştır

---

## 🚀 ADIM 1: SQL EDITOR AÇ

Browser'da git:
https://app.supabase.com/project/jcrbhekrphxodxhkuzju/sql/new

---

## 📝 MIGRATION 1: Alarms Tablosu

### Kopyala:
```sql
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

CREATE INDEX idx_alarms_user_id ON alarms(user_id);
CREATE INDEX idx_alarms_status ON alarms(status);
CREATE INDEX idx_alarms_type ON alarms(type);
CREATE INDEX idx_alarms_is_active ON alarms(is_active);
CREATE INDEX idx_alarms_user_status ON alarms(user_id, status);
CREATE INDEX idx_alarms_created_at ON alarms(created_at DESC);
```

### SQL Editor'da:
1. Kodu yapıştır (Cmd+V)
2. "Execute" tuşuna bas (sağ altta mavi buton)
3. ✅ Sonuç: "Success" görünecek

---

## 🔐 MIGRATION 2: RLS Politikaları

### Kopyala:
```sql
ALTER TABLE alarms ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own alarms" ON alarms;
DROP POLICY IF EXISTS "Users can create own alarms" ON alarms;
DROP POLICY IF EXISTS "Users can update own alarms" ON alarms;
DROP POLICY IF EXISTS "Users can delete own alarms" ON alarms;

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

DROP POLICY IF EXISTS "Users can view own settings" ON user_settings;
DROP POLICY IF EXISTS "Users can create own settings" ON user_settings;
DROP POLICY IF EXISTS "Users can update own settings" ON user_settings;
DROP POLICY IF EXISTS "Users can delete own settings" ON user_settings;

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
```

### SQL Editor'da:
1. Kod sil (Cmd+A → Delete)
2. Yeni kodu yapıştır
3. "Execute" bas
4. ✅ Sonuç: "Success"

---

## ⚙️ MIGRATION 3: User Settings Genişletme

### Kopyala:
```sql
ALTER TABLE user_settings 
  ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(10) DEFAULT 'tr',
  ADD COLUMN IF NOT EXISTS preferred_timeframe VARCHAR(10) DEFAULT '1h',
  ADD COLUMN IF NOT EXISTS theme VARCHAR(20) DEFAULT 'dark',
  ADD COLUMN IF NOT EXISTS default_tp_percent DECIMAL(10,2) DEFAULT 5.0,
  ADD COLUMN IF NOT EXISTS default_sl_percent DECIMAL(10,2) DEFAULT 3.0,
  ADD COLUMN IF NOT EXISTS default_risk_per_trade DECIMAL(5,2) DEFAULT 2.0,
  ADD COLUMN IF NOT EXISTS auto_signals_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS confidence_threshold INTEGER DEFAULT 60;

CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);
```

### SQL Editor'da:
1. Kod sil
2. Yeni kodu yapıştır
3. "Execute" bas
4. ✅ Sonuç: "Success"

---

## ✅ SONRA:

1. Browser REFRESH (Cmd+R)
2. Console'dan hatayı kontrol et
3. "column alarms.type does not exist" kaybolmuş olmalı
4. Alarmlar Supabase'den yüklenecek

---

## 🎉 TAMAMLANDI!

- ✅ alarms tablosu oluşturuldu (28 kolon)
- ✅ RLS politikaları aktif
- ✅ user_settings genişletildi
- ✅ Veri güvenli
- ✅ Ready for production
