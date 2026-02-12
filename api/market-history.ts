import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

// 시장 지표 히스토리 조회 API
// GET /api/market-history?days=30 (기본 365일)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Cache-Control', 'public, max-age=3600') // 1 hour cache

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  try {
    // Query parameter: days (default 365)
    const days = parseInt((req.query.days as string) || '365')
    const limitDays = Math.min(Math.max(days, 1), 365) // 1-365 days

    const startDate = new Date()
    startDate.setDate(startDate.getDate() - limitDays)

    const { data, error } = await supabase
      .from('market_indicators_history')
      .select('*')
      .gte('date', startDate.toISOString().split('T')[0])
      .order('date', { ascending: true })

    if (error) {
      console.error('Supabase error:', error)
      return res.status(500).json({
        error: 'Failed to fetch history',
        details: error.message
      })
    }

    // 응답 형식 정리
    const history = data.map(row => ({
      date: row.date,
      fearGreed: row.fear_greed,
      vix: row.vix,
      spyVs200MA: row.spy_vs_200ma,
      buffettIndicator: row.buffett_indicator,
      fedBalanceSheetYoY: row.fed_balance_sheet_yoy,
      m2GrowthYoY: row.m2_growth_yoy,
      hySpread: row.hy_spread,
      yieldCurve10Y2Y: row.yield_curve_10y2y,
      yieldCurve10Y3M: row.yield_curve_10y3m,
      initialClaims: row.initial_claims,
      compositeScore: row.composite_score,
    }))

    return res.status(200).json({
      count: history.length,
      startDate: startDate.toISOString().split('T')[0],
      endDate: new Date().toISOString().split('T')[0],
      data: history,
    })
  } catch (error) {
    console.error('Error fetching market history:', error)
    return res.status(500).json({
      error: 'Failed to fetch market history',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
