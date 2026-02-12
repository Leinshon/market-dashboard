import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { calculateCompositeScore } from '../../src/lib/composite-score.js'

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
      ismManufacturingData,
      ismServicesData,
      retailSalesData,
      cpiData,
      coreCpiData,
      pceData,
      corePceData,
      ppiData,
      payrollsData,
      unemploymentData,
      laborParticipationData,
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
      fetchFRED('MANEMP', FRED_API_KEY, 5),
      fetchFRED('NMFBAI', FRED_API_KEY, 5),
      fetchFRED('RSXFS', FRED_API_KEY, 15),
      fetchFRED('CPIAUCSL', FRED_API_KEY, 15),
      fetchFRED('CPILFESL', FRED_API_KEY, 15),
      fetchFRED('PCEPI', FRED_API_KEY, 15),
      fetchFRED('PCEPILFE', FRED_API_KEY, 15),
      fetchFRED('PPIACO', FRED_API_KEY, 15),
      fetchFRED('PAYEMS', FRED_API_KEY, 3),
      fetchFRED('UNRATE', FRED_API_KEY, 5),
      fetchFRED('CIVPART', FRED_API_KEY, 5),
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
    }

    let ismManufacturing: number | null = null
    if (ismManufacturingData.length > 0) {
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

    let nonfarmPayrollsMoM: number | null = null
    if (payrollsData.length >= 2) {
      const current = parseFloat(payrollsData[0].value)
      const prevMonth = parseFloat(payrollsData[1].value)
      nonfarmPayrollsMoM = Math.round((current - prevMonth) * 1000)
    }

    let unemploymentRate: number | null = null
    if (unemploymentData.length > 0) {
      unemploymentRate = Math.round(parseFloat(unemploymentData[0].value) * 100) / 100
    }

    let laborParticipation: number | null = null
    if (laborParticipationData.length > 0) {
      laborParticipation = Math.round(parseFloat(laborParticipationData[0].value) * 100) / 100
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
    // ERP = Earnings Yield (E/P) - 10Y Treasury Yield
    // Approximate earnings yield as inverse of P/E ratio (~20 for S&P 500, so ~5%)
    // Or use actual earnings yield if available
    let erp: number | null = null
    if (treasury10y !== null) {
      // Using estimated earnings yield of 5% (inverse of P/E ~20)
      // This is a simplified calculation
      const earningsYield = 5.0
      erp = Math.round((earningsYield - treasury10y) * 100) / 100
    }

    let dollarIndex: number | null = null
    if (dxyData?.chart?.result?.[0]) {
      dollarIndex = Math.round(dxyData.chart.result[0].meta.regularMarketPrice * 100) / 100
    }

    // Calculate composite score
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
        erp,
        dollarIndex,
      },
    }

    const { error } = await supabase
      .from('market_indicators_history')
      .upsert(record, { onConflict: 'date' })

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
