import type { Handler, HandlerEvent } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import { calculateCompositeScore } from '../../src/lib/composite-score'

// Netlify Scheduled Function - 매일 오후 10시(UTC) 실행
// 미국 장 마감 후 + CNN Fear & Greed 마감 후 확정값 수집
// netlify.toml에 스케줄 설정 필요:
// [functions."collect-market-data"]
// schedule = "0 22 * * *"

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

const handler: Handler = async (event: HandlerEvent) => {
  console.log('Starting market data collection...')

  const FRED_API_KEY = process.env.FRED_API_KEY
  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

  if (!FRED_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing required environment variables')
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Missing required environment variables' }),
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  try {
    // Parallel fetch all data
    const [
      fearGreedValue,
      vixData,
      spyData,
      dxyData, // DXY Dollar Index from Yahoo Finance
      gdpData,
      marketCapData,
      walclData,
      m2Data,
      hySpreadData,
      dgs10Data,
      dgs2Data,
      dgs3moData,
      icsaData,
      // 성장 지표
      gdpGrowthData,
      ismManufacturingData,
      ismServicesData,
      retailSalesData,
      // 물가 지표
      cpiData,
      coreCpiData,
      pceData,
      corePceData,
      ppiData,
      // 고용 지표
      payrollsData,
      unemploymentData,
      laborParticipationData,
    ] = await Promise.all([
      fetchFearGreed(),
      fetchYahooQuote('^VIX'),
      fetchYahooQuote('SPY'),
      fetchYahooQuote('DX-Y.NYB'), // DXY Dollar Index
      fetchFRED('GDP', FRED_API_KEY, 5),
      fetchFRED('NCBCEL', FRED_API_KEY, 5),
      fetchFRED('WALCL', FRED_API_KEY, 60),
      fetchFRED('M2SL', FRED_API_KEY, 15),
      fetchFRED('BAMLH0A0HYM2', FRED_API_KEY, 5),
      fetchFRED('DGS10', FRED_API_KEY, 5),
      fetchFRED('DGS2', FRED_API_KEY, 5),
      fetchFRED('DGS3MO', FRED_API_KEY, 5),
      fetchFRED('ICSA', FRED_API_KEY, 5),
      // 성장 지표
      fetchFRED('A191RL1Q225SBEA', FRED_API_KEY, 5), // GDP 성장률 (QoQ, 연율화)
      fetchFRED('MANEMP', FRED_API_KEY, 5), // 제조업 고용 (ISM 대용)
      fetchFRED('NMFBAI', FRED_API_KEY, 5), // ISM 비제조업 지수
      fetchFRED('RSXFS', FRED_API_KEY, 15), // 소매 판매 (YoY 계산용)
      // 물가 지표
      fetchFRED('CPIAUCSL', FRED_API_KEY, 15), // CPI (YoY 계산용)
      fetchFRED('CPILFESL', FRED_API_KEY, 15), // Core CPI (YoY 계산용)
      fetchFRED('PCEPI', FRED_API_KEY, 15), // PCE (YoY 계산용)
      fetchFRED('PCEPILFE', FRED_API_KEY, 15), // Core PCE (YoY 계산용)
      fetchFRED('PPIACO', FRED_API_KEY, 15), // PPI (YoY 계산용)
      // 고용 지표
      fetchFRED('PAYEMS', FRED_API_KEY, 3), // 비농업 고용자 수 (MoM 계산용)
      fetchFRED('UNRATE', FRED_API_KEY, 5), // 실업률
      fetchFRED('CIVPART', FRED_API_KEY, 5), // 경제활동참가율
    ])

    // Process data
    const today = new Date().toISOString().split('T')[0]

    let vix: number | null = null
    if (vixData?.chart?.result?.[0]) {
      vix = Math.round(vixData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }

    let spyVs200MA: number | null = null
    if (spyData?.chart?.result?.[0]) {
      const result = spyData.chart.result[0]
      const prices = result.indicators.adjclose[0].adjclose.filter(p => p != null)
      const currentPrice = result.meta.regularMarketPrice
      const ma200 = calculate200MA(prices)
      spyVs200MA = Math.round(((currentPrice - ma200) / ma200) * 10000) / 100
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

    // === 성장 지표 ===
    let gdpGrowthQoQ: number | null = null
    if (gdpGrowthData.length > 0) {
      gdpGrowthQoQ = Math.round(parseFloat(gdpGrowthData[0].value) * 100) / 100
    }

    let ismManufacturing: number | null = null
    if (ismManufacturingData.length > 0) {
      // MANEMP는 제조업 고용수치 (천명 단위), PMI 대용으로 사용
      ismManufacturing = Math.round(parseFloat(ismManufacturingData[0].value) * 100) / 100
    }

    let ismServices: number | null = null
    if (ismServicesData.length > 0) {
      ismServices = Math.round(parseFloat(ismServicesData[0].value) * 100) / 100
    }

    let retailSalesYoY: number | null = null
    if (retailSalesData.length >= 13) {
      const current = parseFloat(retailSalesData[0].value)
      const yearAgo = parseFloat(retailSalesData[12].value)
      retailSalesYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    }

    // === 물가 지표 ===
    let cpiYoY: number | null = null
    if (cpiData.length >= 13) {
      const current = parseFloat(cpiData[0].value)
      const yearAgo = parseFloat(cpiData[12].value)
      cpiYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    }

    let coreCpiYoY: number | null = null
    if (coreCpiData.length >= 13) {
      const current = parseFloat(coreCpiData[0].value)
      const yearAgo = parseFloat(coreCpiData[12].value)
      coreCpiYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    }

    let pceYoY: number | null = null
    if (pceData.length >= 13) {
      const current = parseFloat(pceData[0].value)
      const yearAgo = parseFloat(pceData[12].value)
      pceYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    }

    let corePceYoY: number | null = null
    if (corePceData.length >= 13) {
      const current = parseFloat(corePceData[0].value)
      const yearAgo = parseFloat(corePceData[12].value)
      corePceYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    }

    let ppiYoY: number | null = null
    if (ppiData.length >= 13) {
      const current = parseFloat(ppiData[0].value)
      const yearAgo = parseFloat(ppiData[12].value)
      ppiYoY = Math.round(calculateYoYChange(current, yearAgo) * 100) / 100
    }

    // === 고용 지표 ===
    let nonfarmPayrollsMoM: number | null = null
    if (payrollsData.length >= 2) {
      const current = parseFloat(payrollsData[0].value)
      const prevMonth = parseFloat(payrollsData[1].value)
      nonfarmPayrollsMoM = Math.round((current - prevMonth) * 1000) // 천명 단위 -> 명 단위
    }

    let unemploymentRate: number | null = null
    if (unemploymentData.length > 0) {
      unemploymentRate = Math.round(parseFloat(unemploymentData[0].value) * 100) / 100
    }

    let laborParticipation: number | null = null
    if (laborParticipationData.length > 0) {
      laborParticipation = Math.round(parseFloat(laborParticipationData[0].value) * 100) / 100
    }

    // === 통화정책 지표 ===
    let treasury10y: number | null = null
    if (dgs10Data.length > 0) {
      treasury10y = Math.round(parseFloat(dgs10Data[0].value) * 1000) / 1000
    }

    let treasury2y: number | null = null
    if (dgs2Data.length > 0) {
      treasury2y = Math.round(parseFloat(dgs2Data[0].value) * 1000) / 1000
    }

    let dollarIndex: number | null = null
    if (dxyData?.chart?.result?.[0]) {
      dollarIndex = Math.round(dxyData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }

    // Calculate composite score (Z-score 기반 5개 핵심 지표)
    const compositeScore = calculateCompositeScore({
      vix,
      spyVs200MA,
      hySpread,
      yieldCurve10Y2Y,
      initialClaims,
    })

    // Save to Supabase
    const record = {
      date: today,
      fear_greed: fearGreedValue,
      vix,
      spy_vs_200ma: spyVs200MA,
      buffett_indicator: buffettIndicator,
      fed_balance_sheet_yoy: fedBalanceSheetYoY,
      m2_growth_yoy: m2GrowthYoY,
      hy_spread: hySpread,
      yield_curve_10y2y: yieldCurve10Y2Y,
      yield_curve_10y3m: yieldCurve10Y3M,
      initial_claims: initialClaims,
      composite_score: compositeScore,
      // 성장 지표
      gdp_growth_qoq: gdpGrowthQoQ,
      ism_manufacturing: ismManufacturing,
      ism_services: ismServices,
      retail_sales_yoy: retailSalesYoY,
      // 물가 지표
      cpi_yoy: cpiYoY,
      core_cpi_yoy: coreCpiYoY,
      pce_yoy: pceYoY,
      core_pce_yoy: corePceYoY,
      ppi_yoy: ppiYoY,
      // 고용 지표
      nonfarm_payrolls_mom: nonfarmPayrollsMoM,
      unemployment_rate: unemploymentRate,
      labor_participation: laborParticipation,
      // 통화정책 지표
      treasury_10y: treasury10y,
      treasury_2y: treasury2y,
      dollar_index: dollarIndex,
      raw_data: {
        fearGreed: fearGreedValue,
        vix,
        spyVs200MA,
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
        dollarIndex,
      },
    }

    // Upsert (insert or update if date exists)
    const { error } = await supabase
      .from('market_indicators_history')
      .upsert(record, { onConflict: 'date' })

    if (error) {
      console.error('Supabase error:', error)
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to save data', details: error.message }),
      }
    }

    console.log(`Successfully saved market data for ${today}`)
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        date: today,
        compositeScore,
        message: 'Market data collected and saved successfully',
      }),
    }
  } catch (error) {
    console.error('Error collecting market data:', error)
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to collect market data',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    }
  }
}

export { handler }
