-- Supabase Row Level Security (RLS) 설정
-- market_indicators_history 테이블에 대한 보안 정책

-- 0. 기존 정책 삭제 (있는 경우)
DROP POLICY IF EXISTS "Allow public read access" ON market_indicators_history;
DROP POLICY IF EXISTS "Allow service role write access" ON market_indicators_history;
DROP POLICY IF EXISTS "Allow service role update access" ON market_indicators_history;
DROP POLICY IF EXISTS "Allow service role delete access" ON market_indicators_history;

-- 1. RLS 활성화
ALTER TABLE market_indicators_history ENABLE ROW LEVEL SECURITY;

-- 2. 모든 사용자에게 읽기 권한 허용 (공개 데이터)
CREATE POLICY "Allow public read access"
ON market_indicators_history
FOR SELECT
TO anon, authenticated
USING (true);

-- 3. 서비스 역할에게만 쓰기 권한 허용 (서버 측 cron job만 데이터 삽입 가능)
CREATE POLICY "Allow service role write access"
ON market_indicators_history
FOR INSERT
TO service_role
WITH CHECK (true);

-- 4. 서비스 역할에게만 업데이트 권한 허용
CREATE POLICY "Allow service role update access"
ON market_indicators_history
FOR UPDATE
TO service_role
USING (true)
WITH CHECK (true);

-- 5. 서비스 역할에게만 삭제 권한 허용
CREATE POLICY "Allow service role delete access"
ON market_indicators_history
FOR DELETE
TO service_role
USING (true);

-- ==================================================================
-- global_indices_history 테이블 RLS 정책
-- ==================================================================

-- 0. 기존 정책 삭제 (있는 경우)
DROP POLICY IF EXISTS "Allow public read access" ON global_indices_history;
DROP POLICY IF EXISTS "Allow service role write access" ON global_indices_history;
DROP POLICY IF EXISTS "Allow service role update access" ON global_indices_history;
DROP POLICY IF EXISTS "Allow service role delete access" ON global_indices_history;

-- 1. RLS 활성화
ALTER TABLE global_indices_history ENABLE ROW LEVEL SECURITY;

-- 2. 모든 사용자에게 읽기 권한 허용 (공개 데이터)
CREATE POLICY "Allow public read access"
ON global_indices_history
FOR SELECT
TO anon, authenticated
USING (true);

-- 3. 서비스 역할에게만 쓰기 권한 허용 (서버 측 cron job만 데이터 삽입 가능)
CREATE POLICY "Allow service role write access"
ON global_indices_history
FOR INSERT
TO service_role
WITH CHECK (true);

-- 4. 서비스 역할에게만 업데이트 권한 허용
CREATE POLICY "Allow service role update access"
ON global_indices_history
FOR UPDATE
TO service_role
USING (true)
WITH CHECK (true);

-- 5. 서비스 역할에게만 삭제 권한 허용
CREATE POLICY "Allow service role delete access"
ON global_indices_history
FOR DELETE
TO service_role
USING (true);
