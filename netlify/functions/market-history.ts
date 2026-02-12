import type { Handler, HandlerEvent } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'

// 시장 지표 히스토리 조회 API
// GET /api/market-history?days=30 (기본 365일)

const handler: Handler = async (event: HandlerEvent) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600', // 1 hour cache
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' }
  }

  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Supabase not configured' }),
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  try {
    // Query parameter: days (default 365)
    const days = parseInt(event.queryStringParameters?.days || '365')
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
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch history', details: error.message }),
      }
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        count: history.length,
        startDate: startDate.toISOString().split('T')[0],
        endDate: new Date().toISOString().split('T')[0],
        data: history,
      }),
    }
  } catch (error) {
    console.error('Error fetching market history:', error)
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to fetch market history',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    }
  }
}

export { handler }
