#!/usr/bin/env node

// v3 backfill: AAII sentiment + FINRA margin + SPY volume 을 DB 의 기존 row들에 UPDATE.
// 새 컬럼들이 없으면 사용자에게 SQL 실행 안내 후 종료.
//
// 실행: node scripts/backfill_v3.mjs
// 필요 컬럼: margin_debt, aaii_bullish, aaii_bearish, aaii_neutral, aaii_spread, spy_volume

import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import dotenv from 'dotenv'

if (existsSync('.env.local')) dotenv.config({ path: '.env.local' })
else dotenv.config()

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY 필요')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// 컬럼 존재 확인
console.log('컬럼 존재 확인...')
const { error: checkErr } = await supabase
  .from('market_indicators_history')
  .select('margin_debt, aaii_bullish, spy_volume')
  .limit(1)

if (checkErr && checkErr.message.includes('column')) {
  console.error('\n신규 컬럼이 없습니다. Supabase SQL Editor에서 다음 SQL을 먼저 실행하세요:\n')
  console.error('===================================================')
  console.error(readFileSync('supabase-migration-v3-multi-factor.sql', 'utf-8'))
  console.error('===================================================')
  console.error('\n완료 후 이 스크립트 다시 실행: node scripts/backfill_v3.mjs')
  process.exit(1)
}

console.log('컬럼 OK\n')

// 합쳐진 데이터 (AAII + FINRA + SPY volume + HYG/LQD/VIX9D/VIX3M)
// market_data_full_v2.json 에 AAII/FINRA 매칭됨, market_data_enhanced.json 에 Yahoo 데이터
// 둘 다 합쳐서 사용
const v2 = JSON.parse(readFileSync('/tmp/market_data_full_v2.json', 'utf-8'))
const yh = JSON.parse(readFileSync('/tmp/market_data_enhanced.json', 'utf-8'))

const yhMap = new Map(yh.map(r => [r.date, r]))
const merged = v2.map(r => {
  const y = yhMap.get(r.date) || {}
  return {
    date: r.date,
    margin_debt:   r.margin_debt   ?? null,
    aaii_bullish:  r.aaii_bullish  ?? null,
    aaii_bearish:  r.aaii_bearish  ?? null,
    aaii_spread:   r.aaii_spread   ?? null,
    spy_volume:    y.spy_volume_yh ?? null,
  }
})

// 통계
const stats = {
  margin_debt: 0, aaii_bullish: 0, aaii_bearish: 0, aaii_spread: 0, spy_volume: 0,
}
for (const r of merged) {
  for (const k of Object.keys(stats)) {
    if (r[k] !== null) stats[k]++
  }
}
console.log('업데이트할 데이터:')
for (const [k, v] of Object.entries(stats)) {
  console.log(`  ${k}: ${v}/${merged.length} valid`)
}

// 100개씩 배치로 update
const BATCH = 100
let updated = 0
let failed = 0
for (let i = 0; i < merged.length; i += BATCH) {
  const batch = merged.slice(i, i + BATCH)

  // 각 row를 date로 upsert. upsert는 모든 컬럼을 덮어쓸 수 있어서 update를 row별로 진행.
  for (const r of batch) {
    // null만 있는 row는 skip
    const hasData = Object.keys(stats).some(k => r[k] !== null)
    if (!hasData) continue

    const updateData = {}
    for (const k of Object.keys(stats)) {
      if (r[k] !== null) updateData[k] = r[k]
    }

    const { error } = await supabase
      .from('market_indicators_history')
      .update(updateData)
      .eq('date', r.date)

    if (error) {
      failed++
      if (failed <= 5) console.warn(`  ${r.date}: ${error.message}`)
    } else {
      updated++
    }
  }
  if (i % 200 === 0) console.log(`  진행: ${i}/${merged.length} (updated ${updated}, failed ${failed})`)
}

console.log(`\n완료: updated ${updated}, failed ${failed}, total ${merged.length}`)
