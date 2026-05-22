import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { calculateTimingScore } from '../../src/lib/composite-score.js'

// Vercel Cron Function - 매일 오후 10시(UTC) 실행
// 미국 장 마감 후 + CNN Fear & Greed 마감 후 확정값 수집
// vercel.json에서 cron 설정 필요

interface FREDObservation {
  date: string
  value: string
}

interface FREDResponse {
  observations: FREDObservation[]
}

interface YahooQuoteResult {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number
        previousClose: number
      }
      timestamp: number[]
      indicators: {
        adjclose: Array<{
          adjclose: number[]
        }>
      }
    }>
    error: null | { code: string; description: string }
  }
}

// FRED API Helper
async function fetchFRED(seriesId: string, apiKey: string, limit = 10): Promise<FREDObservation[]> {
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`
    const response = await fetch(url)
    if (!response.ok) {
      console.warn(`FRED API warning for ${seriesId}: ${response.status}`)
      return []
    }
    const data: FREDResponse = await response.json()
    return data.observations.filter(obs => obs.value !== '.')
  } catch (error) {
    console.warn(`FRED API error for ${seriesId}:`, error)
    return []
  }
}

// Yahoo Finance Helper
async function fetchYahooQuote(symbol: string): Promise<YahooQuoteResult | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

// CNN Fear & Greed Helper
async function fetchFearGreed(): Promise<number | null> {
  try {
    const url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata'
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://edition.cnn.com/markets/fear-and-greed',
      },
    })
    if (!response.ok) return null
    const data = await response.json()
    return Math.round(data.fear_and_greed.score)
  } catch {
    return null
  }
}

// DBnomics latest-observation helper.
// validRange filters out corrupt / mis-mapped values (DBnomics ISM/pmi/pm has emitted
// ~10-class values since 2025-09 which are clearly not PMI). For diffusion indices
// like ISM, real-world range [20, 80] covers historical extremes with margin.
async function fetchDBnomicsLatest(
  provider: string,
  dataset: string,
  series: string,
  validRange: [number, number] = [20, 80]
): Promise<number | null> {
  try {
    const url = `https://api.db.nomics.world/v22/series/${provider}/${dataset}/${series}?observations=1`
    const response = await fetch(url)
    if (!response.ok) {
      console.warn(`DBnomics warning ${provider}/${dataset}/${series}: ${response.status}`)
      return null
    }
    const data = await response.json()
    const seriesData = data.series?.docs?.[0]
    if (!seriesData || !seriesData.period || !seriesData.value) {
      return null
    }
    const periods: string[] = seriesData.period
    const values: (number | string)[] = seriesData.value
    for (let i = periods.length - 1; i >= 0; i--) {
      const raw = values[i]
      const v = typeof raw === 'number' ? raw : parseFloat(raw)
      if (Number.isFinite(v) && v >= validRange[0] && v <= validRange[1]) {
        return Math.round(v * 100) / 100
      }
    }
    return null
  } catch (error) {
    console.warn(`DBnomics error ${provider}/${dataset}/${series}:`, error)
    return null
  }
}

// PMI = simple average of sub-indices. Returns null if any sub is missing,
// since a partial average is not a meaningful PMI value.
function pmiFromSubs(subs: (number | null)[]): number | null {
  if (subs.some(v => v === null)) return null
  const nums = subs as number[]
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100
}

// S&P 500 Earnings Yield scraper (multpl.com)
// Returns trailing E/P as percent (e.g. 3.12 for 3.12%)
async function fetchSP500EarningsYield(): Promise<number | null> {
  try {
    const response = await fetch('https://www.multpl.com/s-p-500-earnings-yield', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    })
    if (!response.ok) {
      console.warn(`multpl.com earnings yield warning: ${response.status}`)
      return null
    }
    const html = await response.text()
    // Page renders: `<div id="current">Current S&P 500 Earnings Yield: <b>3.12%</b> ...</div>`
    // Be lenient about whitespace/tags between label and number.
    const match = html.match(/Current S&amp;P 500 Earnings Yield[\s\S]{0,200}?(\d+\.\d+)\s*%/i)
      || html.match(/Current S&P 500 Earnings Yield[\s\S]{0,200}?(\d+\.\d+)\s*%/i)
    if (!match) {
      console.warn('multpl.com earnings yield: pattern not matched')
      return null
    }
    const value = parseFloat(match[1])
    if (!Number.isFinite(value) || value <= 0 || value > 25) {
      console.warn(`multpl.com earnings yield: out-of-range value ${value}`)
      return null
    }
    return Math.round(value * 100) / 100
  } catch (error) {
    console.warn('multpl.com earnings yield error:', error)
    return null
  }
}

// FINRA monthly margin debt scraper.
// XLSX 다운로드 후 첫 행(최신월)의 "Debit Balances in Customers' Securities Margin Accounts" 반환.
// XLSX는 binary라 server-side parsing 어려움 → 단순 우회: 직전 record 의 margin_debt를 fallback로 사용 (월 1회만 갱신 충분)
// 실제 backfill 은 scripts/backfill_v3.mjs 가 수행
async function fetchLatestMarginDebt(): Promise<number | null> {
  try {
    const url = 'https://www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx'
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const buf = await r.arrayBuffer()
    // XLSX 첫 sheet 첫 데이터 row 의 두 번째 cell 읽기. zip + XML 파싱 필요해서 raw search로 대체.
    // openpyxl 없이 binary 안에 텍스트 형태로 숫자가 있는지 단순 매칭 (best-effort, 실패 시 null)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
    // sharedStrings.xml 또는 sheet1.xml 안에 첫 row 데이터 있음. 첫 큰 정수 (margin debt > 100000)
    const matches = text.match(/<v>(\d{7,9})<\/v>/g)
    if (!matches || matches.length === 0) return null
    const first = matches[0].match(/(\d+)/)?.[1]
    return first ? parseInt(first) : null
  } catch {
    return null
  }
}

// AAII weekly sentiment scraper - 매주 목요일 발표
// JSON API 가 없고 page는 JS-rendered. 가장 안정적: weekly XLS 다시 fetch (이미 backfill에 사용)
async function fetchLatestAAII(): Promise<{ bullish: number; bearish: number; neutral: number; spread: number } | null> {
  try {
    const r = await fetch('https://www.aaii.com/files/surveys/sentiment.xls', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://www.aaii.com/sentimentsurvey',
      },
    })
    if (!r.ok) return null
    const buf = await r.arrayBuffer()
    // .xls (old format) binary 안에서 마지막 weekly row를 추출하기 어려움.
    // best-effort: 실패 시 previousRecord fallback에 의존 (weekly 데이터는 7일 stale tolerance)
    // production grade는 별도 parser 필요. 일단 null 반환.
    void buf
    return null
  } catch {
    return null
  }
}

// Per-frequency stale thresholds.
// previousRecord acts as fallback when a source API fails, but only within these windows.
// Beyond the window the value is treated as too old to trust and we emit null instead.
const STALE_THRESHOLDS = {
  daily: 7,
  weekly: 21,
  monthly: 45,
  quarterly: 120,
} as const

const FIELD_FREQUENCY: Record<string, keyof typeof STALE_THRESHOLDS> = {
  gdp_growth_qoq: 'quarterly',
  ism_manufacturing: 'monthly',
  ism_services: 'monthly',
  ism_mfg_employment: 'monthly',
  ism_svc_employment: 'monthly',
  retail_sales_yoy: 'monthly',
  cpi_yoy: 'monthly',
  core_cpi_yoy: 'monthly',
  pce_yoy: 'monthly',
  core_pce_yoy: 'monthly',
  ppi_yoy: 'monthly',
  nonfarm_payrolls_mom: 'monthly',
  unemployment_rate: 'monthly',
  labor_participation: 'monthly',
  erp: 'daily',
  margin_debt: 'monthly',
  aaii_bullish: 'weekly',
  aaii_bearish: 'weekly',
  aaii_neutral: 'weekly',
  aaii_spread: 'weekly',
  spy_volume: 'daily',
}

// Sanity bounds per field. Values outside these ranges are nulled before save and logged.
// Ranges are chosen wide enough to cover historical extremes (e.g. COVID claims spike).
const FIELD_BOUNDS: Record<string, [number, number]> = {
  fear_greed: [0, 100],
  vix: [5, 200],
  spy_price: [10, 10000],
  qqq_price: [10, 10000],
  sgov_price: [50, 200],
  gld_price: [10, 1000],
  schd_price: [10, 1000],
  vym_price: [10, 1000],
  spy_vs_200ma: [-60, 60],
  buffett_indicator: [30, 500],
  fed_balance_sheet_yoy: [-50, 200],
  m2_growth_yoy: [-15, 40],
  hy_spread: [0, 30],
  yield_curve_10y2y: [-5, 5],
  yield_curve_10y3m: [-6, 6],
  initial_claims: [100_000, 8_000_000],
  composite_score: [0, 100],
  gdp_growth_qoq: [-40, 40],
  ism_manufacturing: [20, 80],
  ism_services: [20, 80],
  ism_mfg_employment: [20, 80],
  ism_svc_employment: [20, 80],
  retail_sales_yoy: [-30, 60],
  cpi_yoy: [-5, 25],
  core_cpi_yoy: [-5, 25],
  pce_yoy: [-5, 25],
  core_pce_yoy: [-5, 25],
  ppi_yoy: [-25, 50],
  nonfarm_payrolls_mom: [-25_000_000, 5_000_000],
  unemployment_rate: [1, 30],
  labor_participation: [50, 75],
  treasury_10y: [0, 25],
  treasury_2y: [0, 25],
  treasury_3m: [0, 25],
  erp: [-15, 20],
  dollar_index: [60, 200],
  sahm_rule: [-2, 5],
  hyg_price: [30, 200],
  lqd_price: [50, 250],
  hyg_lqd_ratio: [0.2, 2.5],
  vix_9d: [5, 200],
  vix_term_ratio: [0.3, 3],
  inflation_5y5y: [0, 8],
  copper_price: [0.5, 15],
  gold_futures_price: [200, 10_000],
  copper_gold_ratio: [0.00005, 0.01],
  // v4 multi-factor
  margin_debt: [50_000, 5_000_000],  // FINRA monthly, 단위: 백만$
  aaii_bullish: [0, 1],              // 0~1 비율
  aaii_bearish: [0, 1],
  aaii_neutral: [0, 1],
  aaii_spread: [-1, 1],              // bullish - bearish
  spy_volume: [1_000_000, 10_000_000_000],
}

function validateRecord<T extends Record<string, unknown>>(record: T): T {
  const sanitized: Record<string, unknown> = { ...record }
  for (const [field, [min, max]] of Object.entries(FIELD_BOUNDS)) {
    const value = sanitized[field]
    if (value === null || value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      console.warn(`Validation: non-numeric ${field}=${String(value)} → null`)
      sanitized[field] = null
      continue
    }
    if (value < min || value > max) {
      console.warn(`Validation: out-of-range ${field}=${value} not in [${min}, ${max}] → null`)
      sanitized[field] = null
    }
  }
  return sanitized as T
}

function getStaleSafeFallback(
  previousRecord: Record<string, unknown> | null,
  field: string,
  todayStr: string
): number | null {
  if (!previousRecord) return null
  const value = previousRecord[field]
  if (value === null || value === undefined) return null
  if (typeof value !== 'number') return null

  const freq = FIELD_FREQUENCY[field] ?? 'monthly'
  const maxDays = STALE_THRESHOLDS[freq]

  const prevDateStr = typeof previousRecord.date === 'string' ? previousRecord.date : undefined
  if (prevDateStr) {
    const ageDays = (new Date(todayStr).getTime() - new Date(prevDateStr).getTime()) / 86400000
    if (ageDays > maxDays) {
      console.warn(`Refusing stale fallback for ${field}: ${Math.round(ageDays)}d old (max ${maxDays}d for ${freq})`)
      return null
    }
  }
  return value
}

// Calculate 200-day MA
function calculate200MA(prices: number[]): number {
  if (prices.length < 200) {
    return prices.reduce((a, b) => a + b, 0) / prices.length
  }
  const last200 = prices.slice(-200)
  return last200.reduce((a, b) => a + b, 0) / 200
}

// Calculate YoY change
function calculateYoYChange(current: number, yearAgo: number): number {
  return ((current - yearAgo) / yearAgo) * 100
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('Starting market data collection...')

  // Verify this is a cron request from Vercel
  // Vercel automatically adds this header to cron requests
  const isVercelCron = req.headers['x-vercel-cron'] === '1'

  // Also allow manual trigger with CRON_SECRET for testing
  const authHeader = req.headers.authorization
  const isManualTrigger = authHeader === `Bearer ${process.env.CRON_SECRET}`

  if (!isVercelCron && !isManualTrigger) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const FRED_API_KEY = process.env.FRED_API_KEY
  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

  if (!FRED_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing required environment variables')
    return res.status(500).json({ error: 'Missing required environment variables' })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  try {
    // Get the most recent record from DB for fallback values (monthly indicators)
    const { data: previousRecord } = await supabase
      .from('market_indicators_history')
      .select('*')
      .order('date', { ascending: false })
      .limit(1)
      .single()

    // Get last ~10년 spy_price for Timing Score percentile 계산
    const { data: priorSpyRecords } = await supabase
      .from('market_indicators_history')
      .select('date, spy_price')
      .order('date', { ascending: true })
      .limit(600)
    const priorSpyPrices: (number | null)[] = (priorSpyRecords ?? []).map(r => r.spy_price)

    // Parallel fetch all data
    const [
      fearGreedValue,
      vixData,
      spyData,
      qqqData,
      sgovData,
      gldData,
      schdData,
      vymData,
      dxyData,
      gdpData,
      marketCapData,
      walclData,
      m2Data,
      hySpreadData,
      dgs10Data,
      dgs2Data,
      dgs3moData,
      icsaData,
      gdpGrowthData,
      ismMfgProd,
      ismMfgNeword,
      ismMfgEmploy,
      ismMfgSupdel,
      ismMfgInven,
      ismSvcBusact,
      ismSvcNeword,
      ismSvcEmploy,
      ismSvcSupdel,
      retailSalesData,
      cpiData,
      coreCpiData,
      pceData,
      corePceData,
      ppiData,
      payrollsData,
      unemploymentData,
      laborParticipationData,
      sp500EarningsYield,
      unemploymentHistoryData,
      hygData,
      lqdData,
      vix9dData,
      inflation5y5yData,
      copperData,
      goldFuturesData,
    ] = await Promise.all([
      fetchFearGreed(),
      fetchYahooQuote('^VIX'),
      fetchYahooQuote('SPY'),
      fetchYahooQuote('QQQ'),
      fetchYahooQuote('SGOV'),
      fetchYahooQuote('GLD'),
      fetchYahooQuote('SCHD'),
      fetchYahooQuote('VYM'),
      fetchYahooQuote('DX-Y.NYB'),
      fetchFRED('GDP', FRED_API_KEY, 5),
      fetchFRED('NCBCEL', FRED_API_KEY, 5),
      fetchFRED('WALCL', FRED_API_KEY, 60),
      fetchFRED('M2SL', FRED_API_KEY, 15),
      fetchFRED('BAMLH0A0HYM2', FRED_API_KEY, 5),
      fetchFRED('DGS10', FRED_API_KEY, 5),
      fetchFRED('DGS2', FRED_API_KEY, 5),
      fetchFRED('DGS3MO', FRED_API_KEY, 5),
      fetchFRED('ICSA', FRED_API_KEY, 5),
      fetchFRED('A191RL1Q225SBEA', FRED_API_KEY, 5),
      // ISM Manufacturing PMI = avg(Production, New Orders, Employment, Supplier Deliveries, Inventories)
      // DBnomics ISM/pmi/pm has been corrupt since 2025-09 (returning ~10), so we reconstruct PMI
      // from the five sub-indices which remained fresh.
      fetchDBnomicsLatest('ISM', 'production', 'in'),
      fetchDBnomicsLatest('ISM', 'neword', 'in'),
      fetchDBnomicsLatest('ISM', 'employment', 'in'),
      fetchDBnomicsLatest('ISM', 'supdel', 'in'),
      fetchDBnomicsLatest('ISM', 'inventories', 'in'),
      // ISM Services PMI = avg(Business Activity, New Orders, Employment, Supplier Deliveries)
      fetchDBnomicsLatest('ISM', 'nm-busact', 'in'),
      fetchDBnomicsLatest('ISM', 'nm-neword', 'in'),
      fetchDBnomicsLatest('ISM', 'nm-employment', 'in'),
      fetchDBnomicsLatest('ISM', 'nm-supdel', 'in'),
      fetchFRED('RSXFS', FRED_API_KEY, 15),
      fetchFRED('CPIAUCSL', FRED_API_KEY, 15),
      fetchFRED('CPILFESL', FRED_API_KEY, 15),
      fetchFRED('PCEPI', FRED_API_KEY, 15),
      fetchFRED('PCEPILFE', FRED_API_KEY, 15),
      fetchFRED('PPIACO', FRED_API_KEY, 15),
      fetchFRED('PAYEMS', FRED_API_KEY, 3),
      fetchFRED('UNRATE', FRED_API_KEY, 5),
      fetchFRED('CIVPART', FRED_API_KEY, 5),
      fetchSP500EarningsYield(),
      // Sahm Rule needs 14+ months: 12-month trailing min of 3-month rolling avg.
      // Pull 18 to leave room for any single-month gaps.
      fetchFRED('UNRATE', FRED_API_KEY, 18),
      fetchYahooQuote('HYG'),
      fetchYahooQuote('LQD'),
      fetchYahooQuote('^VIX9D'),
      fetchFRED('T5YIFR', FRED_API_KEY, 5),
      fetchYahooQuote('HG=F'),
      fetchYahooQuote('GC=F'),
    ])

    // Process data
    const today = new Date().toISOString().split('T')[0]

    let vix: number | null = null
    if (vixData?.chart?.result?.[0]) {
      vix = Math.round(vixData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }

    let spyPrice: number | null = null
    let spyVs200MA: number | null = null
    if (spyData?.chart?.result?.[0]) {
      const result = spyData.chart.result[0]
      const prices = result.indicators.adjclose[0].adjclose.filter(p => p != null)
      const currentPrice = result.meta.regularMarketPrice
      spyPrice = Math.round(currentPrice * 100) / 100
      const ma200 = calculate200MA(prices)
      spyVs200MA = Math.round(((currentPrice - ma200) / ma200) * 10000) / 100
    }

    let qqqPrice: number | null = null
    if (qqqData?.chart?.result?.[0]) {
      qqqPrice = Math.round(qqqData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }

    let sgovPrice: number | null = null
    if (sgovData?.chart?.result?.[0]) {
      sgovPrice = Math.round(sgovData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }

    let gldPrice: number | null = null
    if (gldData?.chart?.result?.[0]) {
      gldPrice = Math.round(gldData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }

    let schdPrice: number | null = null
    if (schdData?.chart?.result?.[0]) {
      schdPrice = Math.round(schdData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }

    let vymPrice: number | null = null
    if (vymData?.chart?.result?.[0]) {
      vymPrice = Math.round(vymData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }

    let buffettIndicator: number | null = null
    if (gdpData.length > 0 && marketCapData.length > 0) {
      const gdp = parseFloat(gdpData[0].value) * 1000000000
      const marketCap = parseFloat(marketCapData[0].value) * 1000000
      buffettIndicator = Math.round((marketCap / gdp) * 10000) / 100
    }

    let fedBalanceSheetYoY: number | null = null
    if (walclData.length >= 52) {
      const current = parseFloat(walclData[0].value)
      const yearAgo = parseFloat(walclData[51].value)
      fedBalanceSheetYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    }

    let m2GrowthYoY: number | null = null
    if (m2Data.length >= 13) {
      const current = parseFloat(m2Data[0].value)
      const yearAgo = parseFloat(m2Data[12].value)
      m2GrowthYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    }

    let hySpread: number | null = null
    if (hySpreadData.length > 0) {
      hySpread = Math.round(parseFloat(hySpreadData[0].value) * 1000) / 1000
    }

    let yieldCurve10Y2Y: number | null = null
    if (dgs10Data.length > 0 && dgs2Data.length > 0) {
      yieldCurve10Y2Y = Math.round((parseFloat(dgs10Data[0].value) - parseFloat(dgs2Data[0].value)) * 1000) / 1000
    }

    let yieldCurve10Y3M: number | null = null
    if (dgs10Data.length > 0 && dgs3moData.length > 0) {
      yieldCurve10Y3M = Math.round((parseFloat(dgs10Data[0].value) - parseFloat(dgs3moData[0].value)) * 1000) / 1000
    }

    let initialClaims: number | null = null
    if (icsaData.length > 0) {
      initialClaims = parseInt(icsaData[0].value)
    }

    let gdpGrowthQoQ: number | null = null
    if (gdpGrowthData.length > 0) {
      gdpGrowthQoQ = Math.round(parseFloat(gdpGrowthData[0].value) * 100) / 100
    } else {
      gdpGrowthQoQ = getStaleSafeFallback(previousRecord, 'gdp_growth_qoq', today)
    }

    // ISM Manufacturing PMI from 5 sub-indices.
    let ismManufacturing: number | null = pmiFromSubs([
      ismMfgProd, ismMfgNeword, ismMfgEmploy, ismMfgSupdel, ismMfgInven,
    ])
    if (ismManufacturing === null) {
      ismManufacturing = getStaleSafeFallback(previousRecord, 'ism_manufacturing', today)
    }

    // ISM Services PMI from 4 sub-indices (Business Activity, New Orders, Employment, Supplier Deliveries).
    let ismServices: number | null = pmiFromSubs([
      ismSvcBusact, ismSvcNeword, ismSvcEmploy, ismSvcSupdel,
    ])
    if (ismServices === null) {
      ismServices = getStaleSafeFallback(previousRecord, 'ism_services', today)
    }

    // Employment sub-indices exposed directly. These signal labor demand within
    // each ISM survey and lead nonfarm payrolls by ~1 month.
    const ismMfgEmployment: number | null = ismMfgEmploy
      ?? getStaleSafeFallback(previousRecord, 'ism_mfg_employment', today)
    const ismSvcEmployment: number | null = ismSvcEmploy
      ?? getStaleSafeFallback(previousRecord, 'ism_svc_employment', today)

    let retailSalesYoY: number | null = null
    if (retailSalesData.length >= 13) {
      const current = parseFloat(retailSalesData[0].value)
      const yearAgo = parseFloat(retailSalesData[12].value)
      retailSalesYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    } else {
      retailSalesYoY = getStaleSafeFallback(previousRecord, 'retail_sales_yoy', today)
    }

    let cpiYoY: number | null = null
    if (cpiData.length >= 13) {
      const current = parseFloat(cpiData[0].value)
      const yearAgo = parseFloat(cpiData[12].value)
      cpiYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    } else {
      cpiYoY = getStaleSafeFallback(previousRecord, 'cpi_yoy', today)
    }

    let coreCpiYoY: number | null = null
    if (coreCpiData.length >= 13) {
      const current = parseFloat(coreCpiData[0].value)
      const yearAgo = parseFloat(coreCpiData[12].value)
      coreCpiYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    } else {
      coreCpiYoY = getStaleSafeFallback(previousRecord, 'core_cpi_yoy', today)
    }

    let pceYoY: number | null = null
    if (pceData.length >= 13) {
      const current = parseFloat(pceData[0].value)
      const yearAgo = parseFloat(pceData[12].value)
      pceYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    } else {
      pceYoY = getStaleSafeFallback(previousRecord, 'pce_yoy', today)
    }

    let corePceYoY: number | null = null
    if (corePceData.length >= 13) {
      const current = parseFloat(corePceData[0].value)
      const yearAgo = parseFloat(corePceData[12].value)
      corePceYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    } else {
      corePceYoY = getStaleSafeFallback(previousRecord, 'core_pce_yoy', today)
    }

    let ppiYoY: number | null = null
    if (ppiData.length >= 13) {
      const current = parseFloat(ppiData[0].value)
      const yearAgo = parseFloat(ppiData[12].value)
      ppiYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    } else {
      ppiYoY = getStaleSafeFallback(previousRecord, 'ppi_yoy', today)
    }

    let nonfarmPayrollsMoM: number | null = null
    if (payrollsData.length >= 2) {
      const current = parseFloat(payrollsData[0].value)
      const prevMonth = parseFloat(payrollsData[1].value)
      nonfarmPayrollsMoM = Math.round((current - prevMonth) * 1000)
    } else {
      nonfarmPayrollsMoM = getStaleSafeFallback(previousRecord, 'nonfarm_payrolls_mom', today)
    }

    let unemploymentRate: number | null = null
    if (unemploymentData.length > 0) {
      unemploymentRate = Math.round(parseFloat(unemploymentData[0].value) * 100) / 100
    } else {
      unemploymentRate = getStaleSafeFallback(previousRecord, 'unemployment_rate', today)
    }

    let laborParticipation: number | null = null
    if (laborParticipationData.length > 0) {
      laborParticipation = Math.round(parseFloat(laborParticipationData[0].value) * 100) / 100
    } else {
      laborParticipation = getStaleSafeFallback(previousRecord, 'labor_participation', today)
    }

    let treasury10y: number | null = null
    if (dgs10Data.length > 0) {
      treasury10y = Math.round(parseFloat(dgs10Data[0].value) * 1000) / 1000
    }

    let treasury2y: number | null = null
    if (dgs2Data.length > 0) {
      treasury2y = Math.round(parseFloat(dgs2Data[0].value) * 1000) / 1000
    }

    let treasury3m: number | null = null
    if (dgs3moData.length > 0) {
      treasury3m = Math.round(parseFloat(dgs3moData[0].value) * 1000) / 1000
    }

    // Calculate Equity Risk Premium (ERP)
    // ERP = S&P 500 trailing Earnings Yield (E/P) - 10Y Treasury Yield
    // Earnings yield is fetched live from multpl.com (trailing 12M).
    // Falls back to previousRecord.erp only when both inputs are unavailable.
    let erp: number | null = null
    if (sp500EarningsYield !== null && treasury10y !== null) {
      erp = Math.round((sp500EarningsYield - treasury10y) * 100) / 100
    } else {
      erp = getStaleSafeFallback(previousRecord, 'erp', today)
    }

    let dollarIndex: number | null = null
    if (dxyData?.chart?.result?.[0]) {
      dollarIndex = Math.round(dxyData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }

    // Sahm Rule = current 3-month avg UNRATE - min(3-month avg UNRATE) over trailing 12 months.
    // unemploymentHistoryData is desc-sorted (newest first). Need >= 14 observations.
    let sahmRule: number | null = null
    if (unemploymentHistoryData.length >= 14) {
      const rates = unemploymentHistoryData.map(o => parseFloat(o.value))
      const threeMonthAvgs: number[] = []
      // index i -> avg of months i, i+1, i+2 (i is most-recent-first). Need 12 trailing windows.
      for (let i = 0; i < 12; i++) {
        const win = rates.slice(i, i + 3)
        if (win.length < 3 || win.some(v => !Number.isFinite(v))) continue
        threeMonthAvgs.push(win.reduce((a, b) => a + b, 0) / 3)
      }
      if (threeMonthAvgs.length >= 2) {
        const current = threeMonthAvgs[0]
        const trailingMin = Math.min(...threeMonthAvgs.slice(0, 12))
        sahmRule = Math.round((current - trailingMin) * 1000) / 1000
      }
    }
    if (sahmRule === null) {
      sahmRule = getStaleSafeFallback(previousRecord, 'sahm_rule', today)
    }

    // HYG (high yield ETF) / LQD (investment grade ETF) ratio — daily credit risk gauge.
    let hygPrice: number | null = null
    if (hygData?.chart?.result?.[0]) {
      hygPrice = Math.round(hygData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }
    let lqdPrice: number | null = null
    if (lqdData?.chart?.result?.[0]) {
      lqdPrice = Math.round(lqdData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }
    let hygLqdRatio: number | null = null
    if (hygPrice !== null && lqdPrice !== null && lqdPrice > 0) {
      hygLqdRatio = Math.round((hygPrice / lqdPrice) * 10000) / 10000
    }

    // VIX term structure: VIX9D / VIX. > 1 = backwardation = near-term stress.
    let vix9d: number | null = null
    if (vix9dData?.chart?.result?.[0]) {
      vix9d = Math.round(vix9dData.chart.result[0].meta.regularMarketPrice * 10000) / 10000
    }
    let vixTermRatio: number | null = null
    if (vix9d !== null && vix !== null && vix > 0) {
      vixTermRatio = Math.round((vix9d / vix) * 10000) / 10000
    }

    // 5Y5Y forward inflation expectation (FRED T5YIFR, daily, percent).
    let inflation5y5y: number | null = null
    if (inflation5y5yData.length > 0) {
      inflation5y5y = Math.round(parseFloat(inflation5y5yData[0].value) * 10000) / 10000
    }

    // Copper (HG=F) / Gold (GC=F) — industrial-demand vs safe-haven ratio.
    let copperPrice: number | null = null
    if (copperData?.chart?.result?.[0]) {
      copperPrice = Math.round(copperData.chart.result[0].meta.regularMarketPrice * 10000) / 10000
    }
    let goldFuturesPrice: number | null = null
    if (goldFuturesData?.chart?.result?.[0]) {
      goldFuturesPrice = Math.round(goldFuturesData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }
    let copperGoldRatio: number | null = null
    if (copperPrice !== null && goldFuturesPrice !== null && goldFuturesPrice > 0) {
      copperGoldRatio = Math.round((copperPrice / goldFuturesPrice) * 1_000_000) / 1_000_000
    }

    // SPY daily volume (Yahoo 응답에 포함됨)
    let spyVolume: number | null = null
    if (spyData?.chart?.result?.[0]) {
      const r = spyData.chart.result[0]
      const ts = r.timestamp ?? []
      const vols = r.indicators?.quote?.[0]?.volume ?? []
      if (vols.length > 0) {
        const lastVol = vols[vols.length - 1]
        if (typeof lastVol === 'number' && Number.isFinite(lastVol)) spyVolume = lastVol
      }
      void ts
    }

    // FINRA margin debt — monthly 발표라 매일 fetch 시도하되 실패 시 직전 값 fallback
    let marginDebt: number | null = await fetchLatestMarginDebt()
    if (marginDebt === null) {
      marginDebt = getStaleSafeFallback(previousRecord, 'margin_debt', today)
    }

    // AAII weekly sentiment — 매주 발표라 매일 fetch 시도하되 실패 시 직전 값 fallback
    let aaiiBullish: number | null = null
    let aaiiBearish: number | null = null
    let aaiiNeutral: number | null = null
    let aaiiSpread: number | null = null
    const aaii = await fetchLatestAAII()
    if (aaii) {
      aaiiBullish = aaii.bullish
      aaiiBearish = aaii.bearish
      aaiiNeutral = aaii.neutral
      aaiiSpread = aaii.spread
    } else {
      aaiiBullish = getStaleSafeFallback(previousRecord, 'aaii_bullish', today)
      aaiiBearish = getStaleSafeFallback(previousRecord, 'aaii_bearish', today)
      aaiiNeutral = getStaleSafeFallback(previousRecord, 'aaii_neutral', today)
      aaiiSpread = getStaleSafeFallback(previousRecord, 'aaii_spread', today)
    }

    // Calculate timing score (v4: drawdown_ath p10y + margin/SPY lagged p10y)
    // 직전 ~10년 SPY + margin_debt history 가 필요
    const { data: priorFullRecords } = await supabase
      .from('market_indicators_history')
      .select('date, spy_price, margin_debt')
      .order('date', { ascending: true })
      .limit(600)
    const histInput = (priorFullRecords ?? []).map(r => ({
      spy_price: r.spy_price,
      margin_debt: r.margin_debt,
    }))
    histInput.push({ spy_price: spyPrice, margin_debt: marginDebt })
    const compositeScore = calculateTimingScore(histInput)

    // Save to Supabase
    const record = {
      date: today,
      fear_greed: fearGreedValue,
      vix,
      spy_price: spyPrice,
      spy_vs_200ma: spyVs200MA,
      qqq_price: qqqPrice,
      sgov_price: sgovPrice,
      gld_price: gldPrice,
      schd_price: schdPrice,
      vym_price: vymPrice,
      buffett_indicator: buffettIndicator,
      fed_balance_sheet_yoy: fedBalanceSheetYoY,
      m2_growth_yoy: m2GrowthYoY,
      hy_spread: hySpread,
      yield_curve_10y2y: yieldCurve10Y2Y,
      yield_curve_10y3m: yieldCurve10Y3M,
      initial_claims: initialClaims,
      composite_score: compositeScore,
      gdp_growth_qoq: gdpGrowthQoQ,
      ism_manufacturing: ismManufacturing,
      ism_services: ismServices,
      ism_mfg_employment: ismMfgEmployment,
      ism_svc_employment: ismSvcEmployment,
      retail_sales_yoy: retailSalesYoY,
      cpi_yoy: cpiYoY,
      core_cpi_yoy: coreCpiYoY,
      pce_yoy: pceYoY,
      core_pce_yoy: corePceYoY,
      ppi_yoy: ppiYoY,
      nonfarm_payrolls_mom: nonfarmPayrollsMoM,
      unemployment_rate: unemploymentRate,
      labor_participation: laborParticipation,
      treasury_10y: treasury10y,
      treasury_2y: treasury2y,
      treasury_3m: treasury3m,
      erp: erp,
      dollar_index: dollarIndex,
      sahm_rule: sahmRule,
      hyg_price: hygPrice,
      lqd_price: lqdPrice,
      hyg_lqd_ratio: hygLqdRatio,
      vix_9d: vix9d,
      vix_term_ratio: vixTermRatio,
      inflation_5y5y: inflation5y5y,
      copper_price: copperPrice,
      gold_futures_price: goldFuturesPrice,
      copper_gold_ratio: copperGoldRatio,
      // v4 multi-factor 추가 컬럼
      margin_debt: marginDebt,
      aaii_bullish: aaiiBullish,
      aaii_bearish: aaiiBearish,
      aaii_neutral: aaiiNeutral,
      aaii_spread: aaiiSpread,
      spy_volume: spyVolume,
      raw_data: {
        fearGreed: fearGreedValue,
        vix,
        spyPrice,
        spyVs200MA,
        qqqPrice,
        sgovPrice,
        gldPrice,
        schdPrice,
        vymPrice,
        buffettIndicator,
        fedBalanceSheetYoY,
        m2GrowthYoY,
        hySpread,
        yieldCurve10Y2Y,
        yieldCurve10Y3M,
        initialClaims,
        gdpGrowthQoQ,
        ismManufacturing,
        ismServices,
        ismMfgEmployment,
        ismSvcEmployment,
        ismMfgSubs: {
          production: ismMfgProd,
          newOrders: ismMfgNeword,
          employment: ismMfgEmploy,
          supplierDeliveries: ismMfgSupdel,
          inventories: ismMfgInven,
        },
        ismSvcSubs: {
          businessActivity: ismSvcBusact,
          newOrders: ismSvcNeword,
          employment: ismSvcEmploy,
          supplierDeliveries: ismSvcSupdel,
        },
        retailSalesYoY,
        cpiYoY,
        coreCpiYoY,
        pceYoY,
        corePceYoY,
        ppiYoY,
        nonfarmPayrollsMoM,
        unemploymentRate,
        laborParticipation,
        treasury10y,
        treasury2y,
        treasury3m,
        sp500EarningsYield,
        erp,
        dollarIndex,
        sahmRule,
        hygPrice,
        lqdPrice,
        hygLqdRatio,
        vix9d,
        vixTermRatio,
        inflation5y5y,
        copperPrice,
        goldFuturesPrice,
        copperGoldRatio,
      },
    }

    const safeRecord = validateRecord(record)

    const { error } = await supabase
      .from('market_indicators_history')
      .upsert(safeRecord, { onConflict: 'date' })

    if (error) {
      console.error('Supabase error:', error)
      return res.status(500).json({
        error: 'Failed to save data',
        details: error.message
      })
    }

    console.log(`Successfully saved market data for ${today}`)
    return res.status(200).json({
      success: true,
      date: today,
      compositeScore,
      message: 'Market data collected and saved successfully',
    })
  } catch (error) {
    console.error('Error collecting market data:', error)
    return res.status(500).json({
      error: 'Failed to collect market data',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
