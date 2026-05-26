-- 한국 매크로 지표 컬럼 추가 (v4.5 KR macro tab)
-- Supabase SQL Editor 에서 실행

ALTER TABLE market_indicators_history
  -- 금리
  ADD COLUMN IF NOT EXISTS kr_base_rate NUMERIC,             -- 한국은행 기준금리 (연%)
  ADD COLUMN IF NOT EXISTS kr_treasury_10y NUMERIC,          -- 국고채 10년
  ADD COLUMN IF NOT EXISTS kr_treasury_3y NUMERIC,           -- 국고채 3년
  ADD COLUMN IF NOT EXISTS kr_call_rate NUMERIC,             -- 콜금리 1일
  -- 신용
  ADD COLUMN IF NOT EXISTS kr_corp_aa_3y NUMERIC,            -- 회사채 3년 AA-
  ADD COLUMN IF NOT EXISTS kr_corp_bbb_3y NUMERIC,           -- 회사채 3년 BBB-
  -- 물가 (raw 지수 + YoY는 frontend에서 계산)
  ADD COLUMN IF NOT EXISTS kr_cpi NUMERIC,                   -- CPI (2020=100)
  ADD COLUMN IF NOT EXISTS kr_ppi NUMERIC,                   -- PPI (2020=100)
  -- 외환
  ADD COLUMN IF NOT EXISTS usd_krw NUMERIC,                  -- 원/달러
  ADD COLUMN IF NOT EXISTS kr_forex_reserves NUMERIC,        -- 외환보유고 (백만달러, 천달러→백만으로 변환해서 저장)
  -- 생산
  ADD COLUMN IF NOT EXISTS kr_industrial_production NUMERIC, -- 전산업생산 지수
  ADD COLUMN IF NOT EXISTS kr_mining_manufacturing NUMERIC,  -- 광공업생산 지수
  -- 고용
  ADD COLUMN IF NOT EXISTS kr_employment NUMERIC,            -- 취업자수 (천명)
  ADD COLUMN IF NOT EXISTS kr_econ_active_pop NUMERIC,       -- 경제활동인구 (천명)
  -- 무역 (월간, 백만달러)
  ADD COLUMN IF NOT EXISTS kr_current_account NUMERIC,       -- 경상수지
  ADD COLUMN IF NOT EXISTS kr_trade_balance NUMERIC,         -- 상품수지
  ADD COLUMN IF NOT EXISTS kr_exports NUMERIC,               -- 상품수출
  ADD COLUMN IF NOT EXISTS kr_imports NUMERIC,               -- 상품수입
  -- 심리
  ADD COLUMN IF NOT EXISTS kr_consumer_sentiment NUMERIC,    -- 소비자심리지수
  -- 주식 (Yahoo)
  ADD COLUMN IF NOT EXISTS kospi_price NUMERIC,
  ADD COLUMN IF NOT EXISTS kospi_volume BIGINT,
  ADD COLUMN IF NOT EXISTS kosdaq_price NUMERIC;
