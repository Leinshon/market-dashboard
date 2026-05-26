#!/usr/bin/env node
// FRED DFF (daily effective Fed funds rate) 30년 backfill

import { createClient } from '@supabase/supabase-js'
import { existsSync } from 'node:fs'
import dotenv from 'dotenv'

if (existsSync('.env.local')) dotenv.config({ path: '.env.local' })
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const FRED_KEY = (process.env.FRED_API_KEY ?? '').replace(/^["']|["']$/g, '')
if (!SUPABASE_URL || !SUPABASE_KEY || !FRED_KEY) { console.error('env 누락'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const { error: chk } = await supabase.from('market_indicators_history').select('fed_funds_rate').limit(1)
if (chk?.message?.includes('column')) {
  console.error('\nfed_funds_rate 컬럼 없음. SQL 먼저 실행하세요:')
  console.error('ALTER TABLE market_indicators_history ADD COLUMN IF NOT EXISTS fed_funds_rate NUMERIC;\n')
  process.exit(1)
}

console.log('FRED DFF (Fed funds rate) 1996+ fetch...')
const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DFF&api_key=${FRED_KEY}&file_type=json&observation_start=1996-01-01&sort_order=asc`
const r = await fetch(url)
if (!r.ok) { console.error(`FRED HTTP ${r.status}`); process.exit(1) }
const j = await r.json()
const obs = (j.observations ?? []).filter(o => o.value !== '.')
console.log(`  ${obs.length} 일별 observation, ${obs[0]?.date} ~ ${obs[obs.length-1]?.date}`)

// date → value map
const ratesMap = new Map(obs.map(o => [o.date, parseFloat(o.value)]))

// DB rows 전체
let allRows = []
let off = 0
while (true) {
  const { data } = await supabase.from('market_indicators_history').select('date').order('date',{ascending:true}).range(off, off+999)
  if (!data?.length) break
  allRows.push(...data)
  if (data.length < 1000) break
  off += 1000
}
console.log(`DB ${allRows.length} rows`)

function match(target) {
  if (ratesMap.has(target)) return ratesMap.get(target)
  const d = new Date(target)
  for (let back = 1; back <= 7; back++) {
    const t = new Date(d.getTime() - back * 86400000).toISOString().slice(0, 10)
    if (ratesMap.has(t)) return ratesMap.get(t)
  }
  return null
}

let updated = 0; let failed = 0
for (const row of allRows) {
  const val = match(row.date)
  if (val === null) continue
  const { error } = await supabase.from('market_indicators_history').update({ fed_funds_rate: val }).eq('date', row.date)
  if (error) { failed++; if (failed <= 3) console.warn(`  ${row.date}: ${error.message}`) }
  else updated++
  if (updated % 300 === 0 && updated > 0) console.log(`  ${updated} updated...`)
}
console.log(`\n완료: ${updated} updated, ${failed} failed, ${allRows.length} total`)
