#!/usr/bin/env node

// Backfill recently-null columns:
//   - 5 new P1 indicators (hyg/lqd ratio, vix term, 5Y5Y forward, copper/gold, sahm)
//   - Buffett Indicator (quarterly source -> LOCF inside same quarter)
//   - ERP (daily, LOCF cosmetic only; true historical earnings yield is monthly).
//
// Idempotent: only updates rows where the target column is currently NULL.
//
// Run:
//   node scripts/backfill_p1_indicators.mjs
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, FRED_API_KEY (.env.local or .env)

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { existsSync } from 'node:fs'

if (existsSync('.env.local')) dotenv.config({ path: '.env.local' })
else dotenv.config()

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const FRED_KEY = process.env.FRED_API_KEY

if (!SUPABASE_URL || !SUPABASE_KEY || !FRED_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY / FRED_API_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d

async function fetchYahooHistory(symbol, range = '3mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!r.ok) {
    console.warn(`Yahoo ${symbol}: ${r.status}`)
    return {}
  }
  const j = await r.json()
  const result = j?.chart?.result?.[0]
  if (!result) return {}
  const timestamps = result.timestamp || []
  const closes =
    result.indicators?.adjclose?.[0]?.adjclose ||
    result.indicators?.quote?.[0]?.close ||
    []
  const map = {}
  timestamps.forEach((t, i) => {
    const c = closes[i]
    if (c != null && Number.isFinite(c)) {
      const d = new Date(t * 1000).toISOString().split('T')[0]
      map[d] = c
    }
  })
  return map
}

async function fetchFREDHistory(seriesId, limit = 30) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=${limit}`
  const r = await fetch(url)
  if (!r.ok) {
    console.warn(`FRED ${seriesId}: ${r.status}`)
    return {}
  }
  const j = await r.json()
  const map = {}
  for (const obs of j.observations || []) {
    if (obs.value !== '.' && Number.isFinite(parseFloat(obs.value))) {
      map[obs.date] = parseFloat(obs.value)
    }
  }
  return map
}

// As-of lookup: latest observation date <= target date.
// Yahoo/FRED have non-trading-day gaps so we carry forward the prior close.
function asOf(map, dateStr) {
  const keys = Object.keys(map).sort()
  let last = null
  for (const k of keys) {
    if (k <= dateStr) last = k
    else break
  }
  return last !== null ? map[last] : null
}

// Sahm Rule from monthly UNRATE history, computed as-of target date.
// Needs >= 14 monthly observations <= target.
function sahmAt(unrateMap, dateStr) {
  const monthEntries = Object.entries(unrateMap)
    .filter(([d]) => d <= dateStr)
    .sort((a, b) => b[0].localeCompare(a[0])) // desc
  if (monthEntries.length < 14) return null
  const rates = monthEntries.slice(0, 14).map(([, v]) => v)
  const avgs = []
  for (let i = 0; i < 12; i++) {
    const w = rates.slice(i, i + 3)
    if (w.length < 3) continue
    avgs.push((w[0] + w[1] + w[2]) / 3)
  }
  if (avgs.length < 2) return null
  const min = Math.min(...avgs)
  return round(avgs[0] - min, 3)
}

console.log('=== Loading historical sources ===')
const [hyg, lqd, vix9d, vix, copper, gold, t5y, unrate] = await Promise.all([
  fetchYahooHistory('HYG'),
  fetchYahooHistory('LQD'),
  fetchYahooHistory('^VIX9D'),
  fetchYahooHistory('^VIX'),
  fetchYahooHistory('HG=F'),
  fetchYahooHistory('GC=F'),
  fetchFREDHistory('T5YIFR', 90),
  fetchFREDHistory('UNRATE', 30),
])

for (const [k, m] of Object.entries({ hyg, lqd, vix9d, vix, copper, gold, t5y, unrate })) {
  const keys = Object.keys(m).sort()
  console.log(`  ${k}: ${keys.length} obs, ${keys[0] || '-'} .. ${keys[keys.length - 1] || '-'}`)
}

// Load rows needing backfill (last 60 days window).
const since = new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0]
const { data: rows, error: rowErr } = await supabase
  .from('market_indicators_history')
  .select('date, hyg_lqd_ratio, vix_term_ratio, inflation_5y5y, copper_gold_ratio, sahm_rule, buffett_indicator, erp')
  .gte('date', since)
  .order('date', { ascending: true })

if (rowErr) {
  console.error('Supabase row fetch failed:', rowErr.message)
  process.exit(1)
}

console.log(`\n=== ${rows.length} rows in window (>= ${since}) ===\n`)

let updated = 0
let buffettCarry = null
let erpCarry = null

for (const row of rows) {
  const date = row.date
  const updates = {}

  if (row.hyg_lqd_ratio === null) {
    const h = asOf(hyg, date)
    const l = asOf(lqd, date)
    if (h !== null && l !== null && l > 0) {
      updates.hyg_price = round(h, 2)
      updates.lqd_price = round(l, 2)
      updates.hyg_lqd_ratio = round(h / l, 4)
    }
  }

  if (row.vix_term_ratio === null) {
    const v9 = asOf(vix9d, date)
    const v30 = asOf(vix, date)
    if (v9 !== null && v30 !== null && v30 > 0) {
      updates.vix_9d = round(v9, 4)
      updates.vix_term_ratio = round(v9 / v30, 4)
    }
  }

  if (row.inflation_5y5y === null) {
    const v = asOf(t5y, date)
    if (v !== null) updates.inflation_5y5y = round(v, 4)
  }

  if (row.copper_gold_ratio === null) {
    const cu = asOf(copper, date)
    const au = asOf(gold, date)
    if (cu !== null && au !== null && au > 0) {
      updates.copper_price = round(cu, 4)
      updates.gold_futures_price = round(au, 2)
      updates.copper_gold_ratio = round(cu / au, 6)
    }
  }

  if (row.sahm_rule === null) {
    const s = sahmAt(unrate, date)
    if (s !== null) updates.sahm_rule = s
  }

  // Buffett: LOCF using prior non-null value seen in this window.
  if (row.buffett_indicator !== null) {
    buffettCarry = row.buffett_indicator
  } else if (buffettCarry !== null) {
    updates.buffett_indicator = buffettCarry
  }

  // ERP: cosmetic LOCF for old hardcoded-5.0-era nulls. Daily cron writes fresh values going forward.
  if (row.erp !== null) {
    erpCarry = row.erp
  } else if (erpCarry !== null) {
    updates.erp = erpCarry
  }

  if (Object.keys(updates).length === 0) continue

  const { error } = await supabase
    .from('market_indicators_history')
    .update(updates)
    .eq('date', date)

  if (error) {
    console.error(`  ${date}  FAIL  ${error.message}`)
  } else {
    updated += 1
    console.log(`  ${date}  ok  fields=${Object.keys(updates).join(',')}`)
  }
}

console.log(`\n=== done: ${updated} rows updated ===`)
