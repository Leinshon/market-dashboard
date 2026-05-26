#!/usr/bin/env node

// ECOS API에서 우리가 원하는 한국 매크로 지표들 stat_code + item_code 확인

import { readFileSync, existsSync } from 'node:fs'
import dotenv from 'dotenv'

if (existsSync('.env.local')) dotenv.config({ path: '.env.local' })
else dotenv.config()

const KEY = (process.env.ECOS_API_KEY ?? '').replace(/^["']|["']$/g, '')
if (!KEY) { console.error('ECOS_API_KEY missing'); process.exit(1) }

async function fetchEcos(statCode, cycle, startPeriod, endPeriod, itemCode1 = '?') {
  const path = itemCode1 === '?'
    ? `${statCode}/${cycle}/${startPeriod}/${endPeriod}`
    : `${statCode}/${cycle}/${startPeriod}/${endPeriod}/${itemCode1}`
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${KEY}/json/kr/1/30/${path}`
  const r = await fetch(url)
  if (!r.ok) { console.error(`  HTTP ${r.status}`); return null }
  const j = await r.json()
  if (j.RESULT) { console.error(`  ERROR: ${j.RESULT.MESSAGE}`); return null }
  return j.StatisticSearch?.row ?? []
}

async function probe(label, statCode, cycle, start, end, item1 = '?') {
  console.log(`\n[${label}] ${statCode} cycle=${cycle} item=${item1}`)
  const rows = await fetchEcos(statCode, cycle, start, end, item1)
  if (!rows || rows.length === 0) { console.log('  (no data)'); return }
  // 최근 3개 + ITEM_NAME1 unique
  const items = new Set(rows.map(r => `${r.ITEM_CODE1}=${r.ITEM_NAME1}`))
  console.log(`  total ${rows.length} rows, items:`, [...items].slice(0, 5).join(' | '))
  rows.slice(-3).forEach(r => {
    console.log(`    ${r.TIME} ${r.ITEM_NAME1?.substring(0, 25)}: ${r.DATA_VALUE} ${r.UNIT_NAME ?? ''}`)
  })
}

// 1) 한국은행 기준금리 (수시 발표, 월간 cycle로 query)
await probe('한국은행 기준금리', '722Y001', 'M', '202501', '202612', '0101000')

// 2) 소비자물가지수 (CPI) - 901Y009
//   - 0: 총지수 (전체)
await probe('CPI', '901Y009', 'M', '202401', '202612', '0')

// 3) 근원 CPI - 901Y009 의 다른 item code
await probe('Core CPI 후보', '901Y009', 'M', '202601', '202612')

// 4) 실업률 - 901Y027
await probe('경제활동인구 (실업률)', '901Y027', 'M', '202601', '202612')

// 5) 산업생산지수 - 901Y033
await probe('산업생산', '901Y033', 'M', '202601', '202612')

// 6) GDP 분기 성장률 - 200Y001 (분기 GDP 성장률)
await probe('GDP (분기)', '200Y001', 'Q', '2024Q1', '2026Q4')

// 7) 시장금리 - 817Y002
await probe('국고채 등 금리', '817Y002', 'D', '20260501', '20260522')

// 8) 환율 - 731Y001
await probe('환율', '731Y001', 'D', '20260501', '20260522')

// 9) 통화량 M2 - 101Y004
await probe('M2', '101Y004', 'M', '202601', '202612')

// 10) 무역수지 - 901Y011
await probe('무역수지', '901Y011', 'M', '202601', '202612')

// 11) 외환보유고 - 732Y001
await probe('외환보유고', '732Y001', 'M', '202601', '202612')

// 12) 소매판매액지수 - 901Y007
await probe('소매판매', '901Y007', 'M', '202601', '202612')
