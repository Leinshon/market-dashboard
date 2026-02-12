import type { VercelRequest, VercelResponse } from '@vercel/node'

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

interface MarketIndicators {
  fearGreed: {
    value: number
    rating: string
    previousClose: number
    oneWeekAgo: number
    oneMonthAgo: number
    oneYearAgo: number
  } | null
  vix: number | null
  spyVs200MA: {
    currentPrice: number
    ma200: number
    percentAbove: number
  } | null
  buffettIndicator: {
    value: number
    gdp: number
    marketCap: number
  } | null
  fedBalanceSheet: {
    value: number
    yoyChange: number
  } | null
  m2Growth: {
    value: number
    yoyChange: number
  } | null
  highYieldSpread: number | null
  yieldCurve10Y2Y: number | null
  yieldCurve10Y3M: number | null
  initialClaims: {
    value: number
    fourWeekAvg: number
  } | null
  lastUpdated: string
}

// FRED API Helper - returns empty array on error instead of throwing
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
async function fetchFearGreed(): Promise<MarketIndicators['fearGreed']> {
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
    const fgi = data.fear_and_greed

    return {
      value: Math.round(fgi.score),
      rating: fgi.rating,
      previousClose: Math.round(fgi.previous_close),
      oneWeekAgo: Math.round(fgi.previous_1_week),
      oneMonthAgo: Math.round(fgi.previous_1_month),
      oneYearAgo: Math.round(fgi.previous_1_year),
    }
  } catch {
    return null
  }
}

// Calculate 200-day MA from daily prices
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
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Cache-Control', 'public, max-age=3600') // 1 hour cache

  // Handle OPTIONS request for CORS
  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  const FRED_API_KEY = process.env.FRED_API_KEY

  if (!FRED_API_KEY) {
    return res.status(500).json({ error: 'FRED API key not configured' })
  }

  const indicators: MarketIndicators = {
    fearGreed: null,
    vix: null,
    spyVs200MA: null,
    buffettIndicator: null,
    fedBalanceSheet: null,
    m2Growth: null,
    highYieldSpread: null,
    yieldCurve10Y2Y: null,
    yieldCurve10Y3M: null,
    initialClaims: null,
    lastUpdated: new Date().toISOString(),
  }

  try {
    // Parallel fetch all data
    const [
      fearGreedData,
      vixData,
      spyData,
      gdpData,
      marketCapData,
      walclData,
      m2Data,
      hySpreadData,
      dgs10Data,
      dgs2Data,
      dgs3moData,
      icsaData,
    ] = await Promise.all([
      fetchFearGreed(),
      fetchYahooQuote('^VIX'),
      fetchYahooQuote('SPY'),
      fetchFRED('GDP', FRED_API_KEY, 5),
      fetchFRED('NCBCEL', FRED_API_KEY, 5), // Nonfinancial Corporate Business Equities (Market Cap proxy)
      fetchFRED('WALCL', FRED_API_KEY, 60), // Weekly data, need ~1 year
      fetchFRED('M2SL', FRED_API_KEY, 15), // Monthly
      fetchFRED('BAMLH0A0HYM2', FRED_API_KEY, 5),
      fetchFRED('DGS10', FRED_API_KEY, 5),
      fetchFRED('DGS2', FRED_API_KEY, 5),
      fetchFRED('DGS3MO', FRED_API_KEY, 5),
      fetchFRED('ICSA', FRED_API_KEY, 5), // Weekly
    ])

    // 1. Fear & Greed
    indicators.fearGreed = fearGreedData

    // 2. VIX
    if (vixData?.chart?.result?.[0]) {
      indicators.vix = vixData.chart.result[0].meta.regularMarketPrice
    }

    // 3. SPY vs 200 MA
    if (spyData?.chart?.result?.[0]) {
      const result = spyData.chart.result[0]
      const prices = result.indicators.adjclose[0].adjclose.filter(p => p != null)
      const currentPrice = result.meta.regularMarketPrice
      const ma200 = calculate200MA(prices)
      indicators.spyVs200MA = {
        currentPrice: Math.round(currentPrice * 100) / 100,
        ma200: Math.round(ma200 * 100) / 100,
        percentAbove: Math.round(((currentPrice - ma200) / ma200) * 10000) / 100,
      }
    }

    // 4. Buffett Indicator (using NCBCEL - Corporate Equities Market Cap)
    if (gdpData.length > 0 && marketCapData.length > 0) {
      const gdp = parseFloat(gdpData[0].value) * 1000000000 // GDP is in billions
      const marketCap = parseFloat(marketCapData[0].value) * 1000000 // NCBCEL is in millions
      indicators.buffettIndicator = {
        value: Math.round((marketCap / gdp) * 10000) / 100, // percentage
        gdp: gdp,
        marketCap: marketCap,
      }
    }

    // 5. Fed Balance Sheet (WALCL is in millions)
    if (walclData.length >= 52) {
      const current = parseFloat(walclData[0].value)
      const yearAgo = parseFloat(walclData[51].value) // ~52 weeks ago
      indicators.fedBalanceSheet = {
        value: current,
        yoyChange: Math.round(calculateYoYChange(current, yearAgo) * 100) / 100,
      }
    } else if (walclData.length > 0) {
      indicators.fedBalanceSheet = {
        value: parseFloat(walclData[0].value),
        yoyChange: 0,
      }
    }

    // 6. M2 YoY Growth
    if (m2Data.length >= 13) {
      const current = parseFloat(m2Data[0].value)
      const yearAgo = parseFloat(m2Data[12].value)
      indicators.m2Growth = {
        value: current,
        yoyChange: Math.round(calculateYoYChange(current, yearAgo) * 100) / 100,
      }
    }

    // 7. High Yield Spread
    if (hySpreadData.length > 0) {
      indicators.highYieldSpread = parseFloat(hySpreadData[0].value)
    }

    // 8 & 9. Yield Curves
    if (dgs10Data.length > 0 && dgs2Data.length > 0) {
      indicators.yieldCurve10Y2Y = Math.round((parseFloat(dgs10Data[0].value) - parseFloat(dgs2Data[0].value)) * 100) / 100
    }
    if (dgs10Data.length > 0 && dgs3moData.length > 0) {
      indicators.yieldCurve10Y3M = Math.round((parseFloat(dgs10Data[0].value) - parseFloat(dgs3moData[0].value)) * 100) / 100
    }

    // 10. Initial Jobless Claims
    if (icsaData.length >= 4) {
      const claims = icsaData.slice(0, 4).map(d => parseFloat(d.value))
      indicators.initialClaims = {
        value: claims[0],
        fourWeekAvg: Math.round(claims.reduce((a, b) => a + b, 0) / 4),
      }
    }

    return res.status(200).json(indicators)
  } catch (error) {
    console.error('Error fetching market indicators:', error)
    return res.status(500).json({
      error: 'Failed to fetch market indicators',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
