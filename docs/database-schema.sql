-- Kripto Analiz Uygulaması - Database Şeması
-- Supabase SQL Editor'de çalıştır

-- 1. Kullanıcı Profilleri (Auth ile otomatik oluşur ama ekstra bilgi için)
CREATE TABLE IF NOT EXISTS public.user_profiles (
    id UUID REFERENCES auth.users(id) PRIMARY KEY,
    username TEXT UNIQUE,
    full_name TEXT,
    avatar_url TEXT,
    membership_type TEXT DEFAULT 'standard' CHECK (membership_type IN ('standard', 'premium')),
    membership_expires_at TIMESTAMP WITH TIME ZONE,
    last_password_change TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 1.5. Kullanıcı Ayarları (Telegram, Bildirimler vb.)
CREATE TABLE IF NOT EXISTS public.user_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
    telegram_username TEXT,
    notifications_enabled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Favori Coinler
CREATE TABLE IF NOT EXISTS public.favorite_coins (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    coin_name TEXT,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, symbol)
);

-- 3. Analiz Geçmişi
CREATE TABLE IF NOT EXISTS public.analysis_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    price DECIMAL(20, 8),
    signal_direction TEXT, -- 'LONG' veya 'SHORT'
    entry_price DECIMAL(20, 8),
    stop_loss DECIMAL(20, 8),
    take_profit DECIMAL(20, 8),
    confidence_score INTEGER,
    indicators JSONB, -- Tüm indikatör değerleri
    support_levels JSONB,
    resistance_levels JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Watchlist (İzleme Listesi)
CREATE TABLE IF NOT EXISTS public.watchlist (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    alert_price DECIMAL(20, 8),
    alert_type TEXT, -- 'above' veya 'below'
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    triggered_at TIMESTAMP WITH TIME ZONE
);

-- 5. Alarm Tablosu (YENİ)
CREATE TABLE IF NOT EXISTS public.alarms (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    target_price DECIMAL(20, 8),
    condition TEXT CHECK (condition IN ('above', 'below')),
    alarm_type TEXT DEFAULT 'price',
    is_active BOOLEAN DEFAULT TRUE,
    is_triggered BOOLEAN DEFAULT FALSE,
    triggered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Backtest Results (YENİ)
CREATE TABLE IF NOT EXISTS public.backtest_results (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    timeframe TEXT,
    total_trades INTEGER,
    win_rate DECIMAL(5, 2),
    total_profit DECIMAL(10, 2),
    profit_factor DECIMAL(5, 2),
    test_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    parameters JSONB
);

-- 7. Pattern Detection History (YENİ)
CREATE TABLE IF NOT EXISTS public.pattern_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    pattern_type TEXT,
    detected_at TIMESTAMP WITH TIME ZONE,
    confidence DECIMAL(5, 2),
    result TEXT, -- 'success', 'failure', 'pending'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Row Level Security (RLS) Politikaları

-- user_profiles için RLS
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own profile"
    ON public.user_profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
    ON public.user_profiles FOR UPDATE
    USING (auth.uid() = id);

CREATE POLICY "Users can insert their own profile"
    ON public.user_profiles FOR INSERT
    WITH CHECK (auth.uid() = id);

-- user_settings için RLS
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own settings"
    ON public.user_settings FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own settings"
    ON public.user_settings FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own settings"
    ON public.user_settings FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- favorite_coins için RLS
ALTER TABLE public.favorite_coins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own favorites"
    ON public.favorite_coins FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own favorites"
    ON public.favorite_coins FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own favorites"
    ON public.favorite_coins FOR DELETE
    USING (auth.uid() = user_id);

-- analysis_history için RLS
ALTER TABLE public.analysis_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own analysis history"
    ON public.analysis_history FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own analysis"
    ON public.analysis_history FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- watchlist için RLS
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own watchlist"
    ON public.watchlist FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own watchlist"
    ON public.watchlist FOR ALL
    USING (auth.uid() = user_id);

-- alarms için RLS (YENİ)
ALTER TABLE public.alarms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their alarms" ON public.alarms
    FOR ALL USING (auth.uid() = user_id);

-- backtest_results için RLS (YENİ)
ALTER TABLE public.backtest_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their backtests" ON public.backtest_results
    FOR ALL USING (auth.uid() = user_id);

-- pattern_history için RLS (YENİ)
ALTER TABLE public.pattern_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view pattern history" ON public.pattern_history
    FOR ALL USING (auth.uid() = user_id);

-- İndeksler (Performans için)
CREATE INDEX IF NOT EXISTS idx_favorite_coins_user_id ON public.favorite_coins(user_id);
CREATE INDEX IF NOT EXISTS idx_analysis_history_user_id ON public.analysis_history(user_id);
CREATE INDEX IF NOT EXISTS idx_analysis_history_created_at ON public.analysis_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watchlist_user_id ON public.watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_active ON public.watchlist(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_alarms_user_active ON public.alarms(user_id, is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_backtest_user_date ON public.backtest_results(user_id, test_date DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_user_symbol ON public.pattern_history(user_id, symbol);
CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON public.user_settings(user_id);

-- Trigger: updated_at otomatik güncelleme
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_profiles_updated_at
    BEFORE UPDATE ON public.user_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_settings_updated_at
    BEFORE UPDATE ON public.user_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Başarılı mesajı
DO $$
BEGIN
    RAISE NOTICE 'Database şeması başarıyla oluşturuldu! ✅';
END $$;