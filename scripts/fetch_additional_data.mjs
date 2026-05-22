#!/usr/bin/env node

// stooq.com에서 SPY volume, ^VIX9D, ^VIX3M, HYG, LQD 가져오기
// CSV 응답: Date,Open,High,Low,Close,Volume
// 결과를 market_data_full.json에 매칭해서 /tmp/market_data_enhanced.json

import { readFileSync, writeFileSync } from 'node:fs'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchStooqCSV(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${symbol}&i=d`
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/csv,text/plain,*/*',
    },
  })
  if (!r.ok) {
    console.warn(`${symbol}: HTTP ${r.status}`)
    return null
  }
  const text = await r.text()
  if (text.includes('No data') || text.length < 50) {
    console.warn(`${symbol}: empty/no data response`)
    return null
  }
  // Date,Open,High,Low,Close,Volume
  const lines = text.trim().split('\n').slice(1)
  return lines.map(l => {
    const [date, open, high, low, close, volume] = l.split(',')
    return {
      date,
      close: parseFloat(close),
      volume: volume ? parseInt(volume) : null,
    }
  }).filter(d => Number.isFinite(d.close))
}

async function fetchWithGap(label, sym) {
  console.log(`${label} fetching from stooq...`)
  const d = await fetchStooqCSV(sym)
  console.log(`  ${sym}: ${d?.length ?? 0} rows, ${d?.[0]?.date ?? '?'} ~ ${d?.[d?.length-1]?.date ?? '?'}`)
  await sleep(1500)
  return d
}

// stooq 심볼: 미국 ETF는 .us, 지수는 ^로 시작
const spy = await fetchWithGap('SPY daily', 'spy.us')
const vix9d = await fetchWithGap('VIX9D', '^vix9d')
const vix3m = await fetchWithGap('VIX3M', '^vix3m')
const hyg = await fetchWithGap('HYG', 'hyg.us')
const lqd = await fetchWithGap('LQD', 'lqd.us')

function toMap(arr, valueField) {
  if (!arr) return new Map()
  const m = new Map()
  for (const d of arr) m.set(d.date, d[valueField])
  return m
}

const spyVolMap = toMap(spy, 'volume')
const vix9dMap = toMap(vix9d, 'close')
const vix3mMap = toMap(vix3m, 'close')
const hygMap = toMap(hyg, 'close')
const lqdMap = toMap(lqd, 'close')

const market = JSON.parse(readFileSync('/tmp/market_data_full.json', 'utf-8'))
console.log(`\nmarket_data_full.json: ${market.length} rows`)

function matchDate(map, targetDate) {
  if (map.has(targetDate)) return map.get(targetDate)
  const d = new Date(targetDate)
  for (let back = 1; back <= 7; back++) {
    const t = new Date(d.getTime() - back * 86400000).toISOString().slice(0, 10)
    if (map.has(t)) return map.get(t)
  }
  return null
}

const matched = { spy_volume: 0, vix9d: 0, vix3m: 0, hyg: 0, lqd: 0 }
for (const rec of market) {
  rec.spy_volume_yh = matchDate(spyVolMap, rec.date)
  rec.vix9d_yh = matchDate(vix9dMap, rec.date)
  rec.vix3m_yh = matchDate(vix3mMap, rec.date)
  rec.hyg_yh = matchDate(hygMap, rec.date)
  rec.lqd_yh = matchDate(lqdMap, rec.date)
  if (rec.spy_volume_yh !== null) matched.spy_volume++
  if (rec.vix9d_yh !== null) matched.vix9d++
  if (rec.vix3m_yh !== null) matched.vix3m++
  if (rec.hyg_yh !== null) matched.hyg++
  if (rec.lqd_yh !== null) matched.lqd++
}

// 첫/마지막 valid 날짜
function range(field) {
  const valid = market.filter(d => d[field] !== null)
  if (!valid.length) return 'none'
  return `${valid[0].date} ~ ${valid[valid.length-1].date}`
}

console.log('\n매칭 결과:')
for (const [k, v] of Object.entries(matched)) {
  const field = k === 'spy_volume' ? 'spy_volume_yh' : `${k.replace('9d', '9d').replace('3m', '3m')}_yh`
  console.log(`  ${k}: ${v}/${market.length} (${(v/market.length*100).toFixed(1)}%) ${range(field)}`)
}

writeFileSync('/tmp/market_data_enhanced.json', JSON.stringify(market))
console.log(`\nwrote ${market.length} rows to /tmp/market_data_enhanced.json`)
