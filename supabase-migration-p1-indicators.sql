-- P1 Coverage migration: 5 new leading indicators
-- Safe to re-run (IF NOT EXISTS guards).

-- Sahm Rule
ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS sahm_rule NUMERIC(5, 3);

-- HYG / LQD credit ratio
ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS hyg_price NUMERIC(10, 2);

ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS lqd_price NUMERIC(10, 2);

ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS hyg_lqd_ratio NUMERIC(8, 4);

-- VIX term structure
ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS vix_9d NUMERIC(8, 4);

ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS vix_term_ratio NUMERIC(8, 4);

-- 5Y5Y forward inflation expectation (FRED T5YIFR)
ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS inflation_5y5y NUMERIC(8, 4);

-- Copper / Gold ratio
ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS copper_price NUMERIC(10, 4);

ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS gold_futures_price NUMERIC(10, 2);

ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS copper_gold_ratio NUMERIC(10, 6);
