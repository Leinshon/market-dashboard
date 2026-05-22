-- P1b: ISM Employment sub-index columns
-- Safe to re-run.

ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS ism_mfg_employment NUMERIC(6, 2);

ALTER TABLE market_indicators_history
  ADD COLUMN IF NOT EXISTS ism_svc_employment NUMERIC(6, 2);
