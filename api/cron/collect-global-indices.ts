import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

// Vercel Cron Function - 글로벌 지수 데이터 수집
// 매일 오후 10시(UTC) 실행

interface YahooQuoteResult {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number
        previousClose: number
        symbol: string
      }
    }>
    error: null | { code: string; description: string }
  }
}

// Yahoo Finance API Helper
async function fetchYahooQuote(symbol: string): Promise<YahooQuoteResult | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    })
    if (!response.ok) {
      console.warn(`Yahoo API warning for ${symbol}: ${response.status}`)
      return null
    }
    return await response.json()
  } catch (error) {
    console.warn(`Yahoo API error for ${symbol}:`, error)
    return null
  }
}

// 글로벌 지수 목록
const GLOBAL_INDICES = [
  // 미국
  { symbol: '^GSPC', name: 'S&P 500', region: '미국' },
  { symbol: '^IXIC', name: 'NASDAQ', region: '미국' },
  { symbol: '^DJI', name: 'Dow Jones', region: '미국' },
  { symbol: '^RUT', name: 'Russell 2000', region: '미국' },

  // 유럽
  { symbol: '^FTSE', name: 'FTSE 100', region: '유럽' },
  { symbol: '^GDAXI', name: 'DAX', region: '유럽' },
  { symbol: '^FCHI', name: 'CAC 40', region: '유럽' },
  { symbol: '^STOXX50E', name: 'EURO STOXX 50', region: '유럽' },

  // 아시아
  { symbol: '^KS11', name: 'KOSPI', region: '아시아' },
  { symbol: '^N225', name: 'Nikkei 225', region: '아시아' },
  { symbol: '^HSI', name: 'Hang Seng', region: '아시아' },
  { symbol: '000001.SS', name: 'SSE Composite', region: '아시아' },

  // 기타
  { symbol: '^AXJO', name: 'ASX 200', region: '기타' },
  { symbol: '^BVSP', name: 'Bovespa', region: '기타' },
  { symbol: '^GSPTSE', name: 'S&P/TSX', region: '기타' },
  { symbol: '^MXX', name: 'IPC Mexico', region: '기타' },
]

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('Starting global indices data collection...')

  // Verify this is a cron request from Vercel
  const isVercelCron = req.headers['x-vercel-cron'] === '1'
  const authHeader = req.headers.authorization
  const isManualTrigger = authHeader === `Bearer ${process.env.CRON_SECRET}`

  if (!isVercelCron && !isManualTrigger) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing required environment variables')
    return res.status(500).json({ error: 'Missing required environment variables' })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  try {
    const today = new Date().toISOString().split('T')[0]
    const records = []

    // Fetch all indices in parallel
    const results = await Promise.all(
      GLOBAL_INDICES.map(async (index) => {
        const data = await fetchYahooQuote(index.symbol)

        if (data?.chart?.result?.[0]) {
          const result = data.chart.result[0]
          const price = Math.round(result.meta.regularMarketPrice * 100) / 100

          return {
            symbol: index.symbol,
            name: index.name,
            region: index.region,
            date: today,
            close_price: price,
          }
        }

        console.warn(`Failed to fetch data for ${index.symbol}`)
        return null
      })
    )

    // Filter out null results
    const validRecords = results.filter((r): r is NonNullable<typeof r> => r !== null)

    if (validRecords.length === 0) {
      console.error('No valid data collected')
      return res.status(500).json({ error: 'No valid data collected' })
    }

    // Insert into Supabase
    const { error } = await supabase
      .from('global_indices_history')
      .insert(validRecords)

    if (error) {
      console.error('Supabase error:', error)
      return res.status(500).json({
        error: 'Failed to save data',
        details: error.message
      })
    }

    console.log(`Successfully saved ${validRecords.length} global indices for ${today}`)
    return res.status(200).json({
      success: true,
      date: today,
      count: validRecords.length,
      message: 'Global indices data collected and saved successfully',
    })
  } catch (error) {
    console.error('Error collecting global indices data:', error)
    return res.status(500).json({
      error: 'Failed to collect global indices data',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
