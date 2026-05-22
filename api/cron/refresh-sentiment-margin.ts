import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

// Weekly cron: AAII sentiment (목요일 발표) + FINRA margin debt (월 1회 발표) refresh
// vercel.json 에서 매주 금요일 등 적당한 주기로 실행
//
// 작동 방식:
// 1. AAII XLS 다운로드 → 최신 N주 파싱 → 가장 최근 발표일에 해당하는 record들 update
// 2. FINRA XLSX 다운로드 → 가장 최근월 마지막일 record에 update (월 1회만 갱신)

const AAII_URL = 'https://www.aaii.com/files/surveys/sentiment.xls'
const FINRA_URL_CURRENT = 'https://www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx'

interface AAIIRow {
  date: string
  bullish: number | null
  bearish: number | null
  neutral: number | null
  spread: number | null
}

async function fetchAAIIRecent(): Promise<AAIIRow[]> {
  const r = await fetch(AAII_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': '*/*',
      'Referer': 'https://www.aaii.com/sentimentsurvey',
    },
  })
  if (!r.ok) {
    console.warn(`AAII fetch ${r.status}`)
    return []
  }
  const buf = Buffer.from(await r.arrayBuffer())
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
  const sheet = wb.Sheets['SENTIMENT']
  if (!sheet) return []
  // Headers 3행에 있음. sheet_to_json with header: 1 줄별 array
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true })
  // 데이터 행 찾기 (Date 열이 datetime인 행)
  const out: AAIIRow[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const d = row[0]
    if (!(d instanceof Date) || isNaN(d.getTime())) continue
    const date = d.toISOString().slice(0, 10)
    const bullish = typeof row[1] === 'number' ? row[1] : null
    const neutral = typeof row[2] === 'number' ? row[2] : null
    const bearish = typeof row[3] === 'number' ? row[3] : null
    const spread = typeof row[6] === 'number' ? row[6] : null
    out.push({ date, bullish, bearish, neutral, spread })
  }
  // 최근 12주만 반환 (성능)
  return out.slice(-12)
}

async function fetchFinraLatest(): Promise<{ date: string; margin_debt: number } | null> {
  const r = await fetch(FINRA_URL_CURRENT, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!r.ok) {
    console.warn(`FINRA fetch ${r.status}`)
    return null
  }
  const buf = Buffer.from(await r.arrayBuffer())
  const wb = XLSX.read(buf, { type: 'buffer' })
  const sheet = wb.Sheets['Customer Margin Balances']
  if (!sheet) return null
  const rows = XLSX.utils.sheet_to_json<{ 'Year-Month'?: string;[k: string]: unknown }>(sheet)
  if (rows.length === 0) return null
  // 첫 행이 최신월
  const first = rows[0]
  const ym = String(first['Year-Month'] ?? '')
  const m = ym.match(/^(\d{4})-(\d{1,2})$/)
  if (!m) return null
  const [, year, month] = m
  // 월 마지막일
  const nextMonth = month === '12' ? `${parseInt(year) + 1}-01-01` : `${year}-${String(parseInt(month) + 1).padStart(2, '0')}-01`
  const lastDay = new Date(new Date(nextMonth).getTime() - 86_400_000).toISOString().slice(0, 10)
  const debit = first["Debit Balances in Customers' Securities Margin Accounts"]
  const debitNum = typeof debit === 'number' ? debit : parseFloat(String(debit))
  if (!Number.isFinite(debitNum)) return null
  return { date: lastDay, margin_debt: debitNum }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const isCron = req.headers['x-vercel-cron'] === '1'
  const isManual = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' })

  const SUPABASE_URL = process.env.SUPABASE_URL
  const KEY = process.env.SUPABASE_SERVICE_KEY
  if (!SUPABASE_URL || !KEY) return res.status(500).json({ error: 'Supabase env missing' })
  const supabase = createClient(SUPABASE_URL, KEY)

  const summary = { aaii_updated: 0, finra_updated: 0, errors: [] as string[] }

  try {
    const aaii = await fetchAAIIRecent()
    console.log(`AAII fetched ${aaii.length} recent weeks`)
    for (const row of aaii) {
      // 해당 주 (date) 또는 직후 7일 내 record들에 update
      // 정확히 같은 날 record가 없을 가능성 高 → 7일 윈도우 update
      const startDate = row.date
      const endDate = new Date(new Date(row.date).getTime() + 7 * 86_400_000).toISOString().slice(0, 10)
      const updateData: Record<string, number | null> = {}
      if (row.bullish !== null) updateData.aaii_bullish = row.bullish
      if (row.bearish !== null) updateData.aaii_bearish = row.bearish
      if (row.neutral !== null) updateData.aaii_neutral = row.neutral
      if (row.spread !== null) updateData.aaii_spread = row.spread
      if (Object.keys(updateData).length === 0) continue
      const { error, count } = await supabase
        .from('market_indicators_history')
        .update(updateData, { count: 'exact' })
        .gte('date', startDate)
        .lte('date', endDate)
      if (error) summary.errors.push(`AAII ${row.date}: ${error.message}`)
      else if (count) summary.aaii_updated += count
    }
  } catch (e) {
    summary.errors.push(`AAII: ${e instanceof Error ? e.message : 'unknown'}`)
  }

  try {
    const finra = await fetchFinraLatest()
    if (finra) {
      console.log(`FINRA latest: ${finra.date} margin_debt=${finra.margin_debt}`)
      // 해당 월의 모든 record 에 margin_debt 채움 (월 데이터를 daily로 spread)
      const ym = finra.date.slice(0, 7)
      const { error, count } = await supabase
        .from('market_indicators_history')
        .update({ margin_debt: finra.margin_debt }, { count: 'exact' })
        .gte('date', `${ym}-01`)
        .lte('date', finra.date)
      if (error) summary.errors.push(`FINRA: ${error.message}`)
      else if (count) summary.finra_updated = count
    }
  } catch (e) {
    summary.errors.push(`FINRA: ${e instanceof Error ? e.message : 'unknown'}`)
  }

  console.log('Summary:', summary)
  return res.status(200).json(summary)
}
