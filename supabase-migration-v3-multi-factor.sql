-- v3 multi-factor 모델용 컬럼 추가
-- Supabase SQL Editor 에서 실행
-- 기존 컬럼이 있으면 IF NOT EXISTS 로 안전하게 추가

ALTER TABLE market_indicators_history
  -- FINRA monthly margin debt (1997~)
  ADD COLUMN IF NOT EXISTS margin_debt NUMERIC,
  -- AAII weekly sentiment (1987~)
  ADD COLUMN IF NOT EXISTS aaii_bullish NUMERIC,
  ADD COLUMN IF NOT EXISTS aaii_bearish NUMERIC,
  ADD COLUMN IF NOT EXISTS aaii_neutral NUMERIC,
  ADD COLUMN IF NOT EXISTS aaii_spread NUMERIC,
  -- SPY daily volume (Yahoo)
  ADD COLUMN IF NOT EXISTS spy_volume BIGINT;

-- 인덱스: margin_debt rolling window 조회 최적화
CREATE INDEX IF NOT EXISTS idx_market_history_margin_debt
  ON market_indicators_history(date) WHERE margin_debt IS NOT NULL;
