#!/usr/bin/env node

// Supabase의 market_indicators_history 전체를 /tmp/market_data_full.json 로 덤프
// calculate_weights.py / calculate_stats.py의 입력 데이터
//
// 실행:
//   node scripts/export_market_data.mjs
//
// 필요 환경 변수 (.env):
//   SUPABASE_URL, SUPABASE_ANON_KEY (또는 SUPABASE_SERVICE_KEY)

import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import dotenv from 'dotenv'
import { existsSync } from 'node:fs'

if (existsSync('.env.local')) dotenv.config({ path: '.env.local' })
else dotenv.config()

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_*_KEY in .env')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const PAGE = 1000
let offset = 0
let all = []

while (true) {
  const { data, error } = await supabase
    .from('market_indicators_history')
    .select('date, spy_price, fear_greed, vix, spy_vs_200ma, buffett_indicator, fed_balance_sheet_yoy, m2_growth_yoy, hy_spread, yield_curve_10y2y, yield_curve_10y3m, initial_claims, erp')
    .order('date', { ascending: true })
    .range(offset, offset + PAGE - 1)

  if (error) {
    console.error('Supabase error:', error)
    process.exit(1)
  }

  if (!data || data.length === 0) break

  all = all.concat(data)
  console.log(`fetched ${all.length} rows...`)
  if (data.length < PAGE) break
  offset += PAGE
}

const out = '/tmp/market_data_full.json'
writeFileSync(out, JSON.stringify(all))
console.log(`\nwrote ${all.length} rows to ${out}`)
console.log(`range: ${all[0]?.date} ~ ${all[all.length - 1]?.date}`)
