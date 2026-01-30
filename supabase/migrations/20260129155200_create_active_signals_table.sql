-- Create active_signals table to track open trading signals
CREATE TABLE public.active_signals (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alarm_id BIGINT NOT NULL REFERENCES public.alarms(id) ON DELETE CASCADE,
  symbol VARCHAR(20) NOT NULL,
  market_type VARCHAR(10) NOT NULL DEFAULT 'spot',
  timeframe VARCHAR(10) NOT NULL,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  entry_price DECIMAL(20, 8) NOT NULL,
  take_profit DECIMAL(20, 8) NOT NULL,
  stop_loss DECIMAL(20, 8) NOT NULL,
  tp_percent DECIMAL(10, 4),
  sl_percent DECIMAL(10, 4),
  bar_close_limit INT,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  close_reason VARCHAR(20) CHECK (close_reason IN ('TP_HIT', 'SL_HIT', 'CLOSED_BY_USER')),
  profit_loss DECIMAL(10, 4),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for performance
CREATE INDEX idx_active_signals_user_id ON public.active_signals(user_id);
CREATE INDEX idx_active_signals_status ON public.active_signals(status);
CREATE INDEX idx_active_signals_user_symbol ON public.active_signals(user_id, symbol);

-- Create unique index for spam prevention: only one active signal per user per symbol
CREATE UNIQUE INDEX idx_active_signals_user_symbol_active 
ON public.active_signals(user_id, symbol) 
WHERE status = 'ACTIVE';

-- Enable RLS
ALTER TABLE public.active_signals ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view their own signals
CREATE POLICY "Users can view own active signals"
ON public.active_signals FOR SELECT
USING (auth.uid() = user_id);

-- RLS Policy: Users can update their own signals
CREATE POLICY "Users can update own active signals"
ON public.active_signals FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- RLS Policy: Service role can do everything
CREATE POLICY "Service role full access to active signals"
ON public.active_signals FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');
