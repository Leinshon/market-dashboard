#!/usr/bin/env node

// 한국 매크로 지표 30년 backfill
// ECOS API + Yahoo (KOSPI/KOSDAQ) 에서 모든 historical 데이터 가져와서
// market_indicators_history 의 kr_* 컬럼 UPDATE
//
// 실행: node scripts/backfill_kr_macro.mjs
// 필요: SQL migration 먼저 실행 (supabase-migration-kr-macro.sql)

import { createClient } from '@supabase/supabase-js'
import { existsSync } from 'node:fs'
import dotenv from 'dotenv'

if (existsSync('.env.local')) dotenv.config({ path: '.env.local' })
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const ECOS_KEY = (process.env.ECOS_API_KEY ?? '').replace(/^["']|["']$/g, '')
if (!SUPABASE_URL || !SUPABASE_KEY || !ECOS_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY / ECOS_API_KEY 필요')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// 컬럼 존재 확인
const { error: chk } = await supabase
  .from('market_indicators_history')
  .select('kr_base_rate, kr_cpi, usd_krw, kospi_price')
  .limit(1)
if (chk && chk.message.includes('column')) {
  console.error('\nkr_* 컬럼이 없습니다. supabase-migration-kr-macro.sql 먼저 실행하세요.\n')
  process.exit(1)
}

// ============================================================
// ECOS fetch helper (page over 1000 limit if needed)
// ============================================================
async function fetchEcosAll(statCode, cycle, start, end, itemCode) {
  const all = []
  let offset = 1
  const PAGE = 1000
  while (true) {
    const url = `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_KEY}/json/kr/${offset}/${offset + PAGE - 1}/${statCode}/${cycle}/${start}/${end}/${itemCode}`
    const r = await fetch(url)
    if (!r.ok) { console.warn(`  ${statCode}/${itemCode}: HTTP ${r.status}`); break }
    const j = await r.json()
    if (j.RESULT) { console.warn(`  ${statCode}/${itemCode}: ${j.RESULT.MESSAGE}`); break }
    const rows = j.StatisticSearch?.row ?? []
    all.push(...rows)
    if (rows.length < PAGE) break
    offset += PAGE
  }
  return all
}

// ECOS TIME → YYYY-MM-DD
// cycle M: 202604 → 2026-04-30 (월말)
// cycle D: 20260522 → 2026-05-22
// cycle Q: 2026Q1 → 2026-03-31
function ecosTimeToDate(time, cycle) {
  const t = String(time)
  if (cycle === 'D') {
    return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`
  }
  if (cycle === 'M') {
    const y = parseInt(t.slice(0, 4))
    const m = parseInt(t.slice(4, 6))
    const lastDay = new Date(y, m, 0).getDate()
    return `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  }
  if (cycle === 'Q') {
    const y = t.slice(0, 4); const q = t.slice(-1)
    const endMonth = { '1': '03', '2': '06', '3': '09', '4': '12' }[q]
    const lastDay = q === '1' ? 31 : q === '2' ? 30 : q === '3' ? 30 : 31
    return `${y}-${endMonth}-${lastDay}`
  }
  return null
}

// ============================================================
// ECOS 지표 정의 (column, statCode, itemCode, cycle, transform)
// ============================================================
const ECOS_INDICATORS = [
  // 금리
  { col: 'kr_base_rate',      stat: '722Y001', item: '0101000', cycle: 'M', xform: v => v },
  { col: 'kr_treasury_10y',   stat: '817Y002', item: '010210000', cycle: 'D', xform: v => v },
  { col: 'kr_treasury_3y',    stat: '817Y002', item: '010200000', cycle: 'D', xform: v => v },
  { col: 'kr_call_rate',      stat: '817Y002', item: '010101000', cycle: 'D', xform: v => v },
  // 신용
  { col: 'kr_corp_aa_3y',     stat: '817Y002', item: '010300000', cycle: 'D', xform: v => v },
  { col: 'kr_corp_bbb_3y',    stat: '817Y002', item: '010320000', cycle: 'D', xform: v => v },
  // 물가
  { col: 'kr_cpi',            stat: '901Y009', item: '0', cycle: 'M', xform: v => v },
  { col: 'kr_ppi',            stat: '404Y014', item: '*AA', cycle: 'M', xform: v => v },
  // 외환
  { col: 'usd_krw',           stat: '731Y001', item: '0000001', cycle: 'D', xform: v => v },
  { col: 'kr_forex_reserves', stat: '732Y001', item: '99', cycle: 'M', xform: v => v / 1000 }, // 천달러 → 백만달러
  // 생산
  { col: 'kr_industrial_production', stat: '901Y033', item: 'A00', cycle: 'M', xform: v => v },
  { col: 'kr_mining_manufacturing',  stat: '901Y033', item: 'AB00', cycle: 'M', xform: v => v },
  // 고용
  { col: 'kr_employment',     stat: '901Y027', item: 'I61BA', cycle: 'M', xform: v => v },
  { col: 'kr_econ_active_pop', stat: '901Y027', item: 'I61B', cycle: 'M', xform: v => v },
  // 무역 (백만달러)
  { col: 'kr_current_account', stat: '301Y013', item: '000000', cycle: 'M', xform: v => v },
  { col: 'kr_trade_balance',  stat: '301Y013', item: '100000', cycle: 'M', xform: v => v },
  { col: 'kr_exports',        stat: '301Y013', item: '110000', cycle: 'M', xform: v => v },
  { col: 'kr_imports',        stat: '301Y013', item: '120000', cycle: 'M', xform: v => v },
  // 심리
  { col: 'kr_consumer_sentiment', stat: '511Y002', item: 'FMAA', cycle: 'M', xform: v => v },
]

// 1996~2026 범위
const START = { D: '19960101', M: '199601', Q: '1996Q1' }
const END = { D: '20261231', M: '202612', Q: '2026Q4' }

// ============================================================
// 한 지표 fetch + date→value Map 생성
// ============================================================
async function fetchIndicator(ind) {
  const rows = await fetchEcosAll(ind.stat, ind.cycle, START[ind.cycle], END[ind.cycle], ind.item)
  const map = new Map()
  for (const r of rows) {
    const date = ecosTimeToDate(r.TIME, ind.cycle)
    const val = parseFloat(r.DATA_VALUE)
    if (date && Number.isFinite(val)) {
      map.set(date, ind.xform(val))
    }
  }
  return map
}

// ============================================================
// Yahoo KOSPI/KOSDAQ
// ============================================================
async function fetchYahooDaily(symbol, period = '30y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${period}`
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!r.ok) { console.warn(`  ${symbol}: HTTP ${r.status}`); return new Map() }
  const j = await r.json()
  const result = j?.chart?.result?.[0]
  if (!result) return new Map()
  const ts = result.timestamp ?? []
  const closes = result.indicators?.quote?.[0]?.close ?? []
  const vols = result.indicators?.quote?.[0]?.volume ?? []
  const map = new Map()
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] === null || closes[i] === undefined) continue
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10)
    map.set(date, { price: closes[i], volume: vols[i] ?? null })
  }
  return map
}

// ============================================================
// MAIN
// ============================================================
console.log('ECOS 지표 fetch 시작 (1996~2026)...')
const ecosData = {}
for (const ind of ECOS_INDICATORS) {
  process.stdout.write(`  ${ind.col} (${ind.stat}/${ind.item}, ${ind.cycle}) ... `)
  ecosData[ind.col] = await fetchIndicator(ind)
  console.log(`${ecosData[ind.col].size}개`)
  await new Promise(r => setTimeout(r, 200)) // ECOS rate limit
}

console.log('\nYahoo KOSPI/KOSDAQ fetch...')
const kospi = await fetchYahooDaily('^KS11', '30y')
console.log(`  KOSPI: ${kospi.size}개`)
await new Promise(r => setTimeout(r, 2000))
const kosdaq = await fetchYahooDaily('^KQ11', '30y')
console.log(`  KOSDAQ: ${kosdaq.size}개`)

// ============================================================
// DB UPDATE: market_indicators_history 의 모든 row 에 매칭
// ============================================================
console.log('\nDB rows 조회...')
const allRows = []
let offset = 0
while (true) {
  const { data, error } = await supabase
    .from('market_indicators_history')
    .select('date')
    .order('date', { ascending: true })
    .range(offset, offset + 999)
  if (error) { console.error(error); process.exit(1) }
  if (!data || data.length === 0) break
  allRows.push(...data)
  if (data.length < 1000) break
  offset += 1000
}
console.log(`  총 ${allRows.length} rows`)

// 매칭 함수: 정확히 같은 날짜 없으면 직전 N일 내 가장 가까운 값
function matchValue(map, targetDate, maxBack) {
  if (map.has(targetDate)) return map.get(targetDate)
  const d = new Date(targetDate)
  for (let back = 1; back <= maxBack; back++) {
    const t = new Date(d.getTime() - back * 86400000).toISOString().slice(0, 10)
    if (map.has(t)) return map.get(t)
  }
  return null
}

console.log('\nUPDATE 시작...')
let updated = 0; let failed = 0
for (const row of allRows) {
  const updateData = {}

  // ECOS 지표들
  for (const ind of ECOS_INDICATORS) {
    const cyc = ind.cycle
    const maxBack = cyc === 'D' ? 5 : cyc === 'M' ? 40 : 100 // daily 5일, monthly 40일, quarterly 100일
    const v = matchValue(ecosData[ind.col], row.date, maxBack)
    if (v !== null) updateData[ind.col] = v
  }
  // KOSPI/KOSDAQ (5일 maxBack)
  const k1 = matchValue(kospi, row.date, 5)
  if (k1 !== null) {
    updateData.kospi_price = k1.price
    if (k1.volume !== null) updateData.kospi_volume = k1.volume
  }
  const k2 = matchValue(kosdaq, row.date, 5)
  if (k2 !== null) updateData.kosdaq_price = k2.price

  if (Object.keys(updateData).length === 0) continue

  const { error } = await supabase
    .from('market_indicators_history')
    .update(updateData)
    .eq('date', row.date)
  if (error) {
    failed++
    if (failed <= 3) console.warn(`  ${row.date}: ${error.message}`)
  } else updated++

  if (updated % 200 === 0 && updated > 0) console.log(`  ${updated} updated...`)
}

console.log(`\n완료: updated ${updated}, failed ${failed}, total ${allRows.length}`)
