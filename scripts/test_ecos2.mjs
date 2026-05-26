#!/usr/bin/env node
import { existsSync } from 'node:fs'
import dotenv from 'dotenv'
if (existsSync('.env.local')) dotenv.config({ path: '.env.local' })
const KEY = (process.env.ECOS_API_KEY ?? '').replace(/^["']|["']$/g, '')

async function probe(label, statCode, cycle, start, end, listOnly = false) {
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${KEY}/json/kr/1/100/${statCode}/${cycle}/${start}/${end}`
  const r = await fetch(url)
  const j = await r.json()
  if (j.RESULT) { console.log(`\n[${label}] ERROR: ${j.RESULT.MESSAGE}`); return }
  const rows = j.StatisticSearch?.row ?? []
  console.log(`\n[${label}] ${statCode}/${cycle} — ${rows.length}rows`)
  const items = new Map()
  for (const r of rows) {
    const k = r.ITEM_CODE1
    if (!items.has(k)) items.set(k, { name: r.ITEM_NAME1, unit: r.UNIT_NAME, lastVal: r.DATA_VALUE, lastTime: r.TIME })
    else items.get(k).lastVal = r.DATA_VALUE
  }
  const sorted = [...items.entries()].slice(0, 20)
  for (const [code, info] of sorted) {
    console.log(`  ${code}: ${info.name?.substring(0, 35)} = ${info.lastVal} ${info.unit ?? ''}`)
  }
}

// 시장금리 - 국고채 항목 찾기
await probe('시장금리', '817Y002', 'D', '20260520', '20260522')

// 실업률 - 901Y027 (경제활동인구조사)
await probe('경제활동인구', '901Y027', 'M', '202602', '202604')

// CPI 902Y008 (또는 901Y009의 sub-item)
await probe('CPI 시도1', '901Y009', 'M', '202604', '202604')

// 901Y008 (생산자물가지수 PPI)
await probe('PPI', '404Y014', 'M', '202602', '202604')

// 통화 및 유동성 - 101Y003 (M2 시도)
await probe('M2 통화량 시도1', '101Y003', 'M', '202602', '202604')
await probe('M2 통화량 시도2', '101Y016', 'M', '202602', '202604')

// 산업활동동향 - 901Y033 sub items
await probe('산업생산 sub', '901Y033', 'M', '202603', '202603')

// 무역수지 - 901Y013 등 시도
await probe('국제수지 시도1', '301Y013', 'M', '202602', '202604')
await probe('국제수지 시도2', '301Y017', 'M', '202602', '202604')

// 분기 GDP - 200Y002 ~ 200Y010 시도
for (const code of ['200Y002','200Y003','200Y104','111Y002','111Y008']) {
  await probe(`GDP 시도 ${code}`, code, 'Q', '2025Q1', '2025Q4')
}

// 소비자심리지수 (참고)
await probe('소비자심리', '511Y002', 'M', '202602', '202604')
