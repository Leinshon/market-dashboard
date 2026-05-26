import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { supabase } from './lib/supabase'
import { calculateTimingScoreSeries, calculateRiskSignal, TIMING_SCORE_DISTRIBUTION, type RiskSignal } from './lib/composite-score'
import './Market.css'

// Chart.js 등록
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
)

// 히스토리 데이터 타입
interface MarketHistoryRecord {
  date: string
  fear_greed: number | null
  vix: number | null
  spy_vs_200ma: number | null
  buffett_indicator: number | null
  fed_balance_sheet_yoy: number | null
  m2_growth_yoy: number | null
  hy_spread: number | null
  yield_curve_10y2y: number | null
  yield_curve_10y3m: number | null
  initial_claims: number | null
  erp: number | null
  spy_price: number | null
  composite_score: number
  qqq_price: number | null
  gld_price: number | null
  schd_price: number | null
  vym_price: number | null
  treasury_3m: number | null
  // 성장 지표
  gdp_growth_qoq: number | null
  ism_manufacturing: number | null
  ism_services: number | null
  retail_sales_yoy: number | null
  // 물가 지표
  cpi_yoy: number | null
  core_cpi_yoy: number | null
  pce_yoy: number | null
  core_pce_yoy: number | null
  ppi_yoy: number | null
  // 고용 지표
  nonfarm_payrolls_mom: number | null
  unemployment_rate: number | null
  labor_participation: number | null
  // 통화정책 지표
  treasury_10y: number | null
  treasury_2y: number | null
  dollar_index: number | null
  // v4 multi-factor
  margin_debt: number | null
  aaii_bullish: number | null
  aaii_bearish: number | null
  aaii_spread: number | null
  spy_volume: number | null
  hyg_price?: number | null
  lqd_price?: number | null
  vix_9d?: number | null
  // 한국 매크로 (v4.5 KR macro tab)
  kr_base_rate?: number | null
  kr_treasury_10y?: number | null
  kr_treasury_3y?: number | null
  kr_call_rate?: number | null
  kr_corp_aa_3y?: number | null
  kr_corp_bbb_3y?: number | null
  kr_cpi?: number | null
  kr_ppi?: number | null
  usd_krw?: number | null
  kr_forex_reserves?: number | null
  kr_industrial_production?: number | null
  kr_mining_manufacturing?: number | null
  kr_employment?: number | null
  kr_econ_active_pop?: number | null
  kr_current_account?: number | null
  kr_trade_balance?: number | null
  kr_exports?: number | null
  kr_imports?: number | null
  kr_consumer_sentiment?: number | null
  kospi_price?: number | null
  kospi_volume?: number | null
  kosdaq_price?: number | null
}

// 시장 지표 타입
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
  erp: number | null
  treasury3m: number | null
  lastUpdated: string
}

// 점수화 함수들
const normalizeScore = (value: number, min: number, max: number, invert = false): number => {
  const clamped = Math.max(min, Math.min(max, value))
  const normalized = ((clamped - min) / (max - min)) * 100
  return invert ? 100 - normalized : normalized
}

const applyExtremeCap = (score: number, minCap = 15, maxCap = 85): number => {
  return Math.max(minCap, Math.min(maxCap, score))
}

type IndicatorTiming = 'leading' | 'coincident' | 'lagging'

const indicatorTiming: Record<string, { timing: IndicatorTiming; currentWeight: number; momentumWeight: number }> = {
  'Fear & Greed': { timing: 'lagging', currentWeight: 0.9, momentumWeight: 0.1 },
  'VIX': { timing: 'coincident', currentWeight: 0.7, momentumWeight: 0.3 },
  'S&P vs 200MA': { timing: 'coincident', currentWeight: 0.7, momentumWeight: 0.3 },
  'Buffett Indicator': { timing: 'lagging', currentWeight: 0.9, momentumWeight: 0.1 },
  'Equity Risk Premium': { timing: 'coincident', currentWeight: 0.7, momentumWeight: 0.3 },
  'Fed Balance Sheet': { timing: 'leading', currentWeight: 0.5, momentumWeight: 0.5 },
  'M2 Growth': { timing: 'leading', currentWeight: 0.5, momentumWeight: 0.5 },
  'HY Spread': { timing: 'leading', currentWeight: 0.5, momentumWeight: 0.5 },
  'Yield Curve 10Y-2Y': { timing: 'leading', currentWeight: 0.5, momentumWeight: 0.5 },
  'Yield Curve 10Y-3M': { timing: 'leading', currentWeight: 0.5, momentumWeight: 0.5 },
  'Initial Claims': { timing: 'coincident', currentWeight: 0.7, momentumWeight: 0.3 },
}

interface IndicatorScore {
  name: string
  value: number | string
  score: number
  baseScore: number
  momentumScore: number
  category: string
  range: string
  description: string
  rawValue: number
  min: number
  max: number
  timing: IndicatorTiming
}

const calculateMomentumScore = (
  currentScore: number,
  threeMonthAgoScore: number | null
): number => {
  if (threeMonthAgoScore === null) return 50
  const change = currentScore - threeMonthAgoScore
  const normalizedChange = ((change + 30) / 60) * 100
  return Math.max(0, Math.min(100, normalizedChange))
}

const getThreeMonthAgoValue = (
  history: MarketHistoryRecord[],
  field: keyof MarketHistoryRecord
): number | null => {
  const targetIndex = Math.max(0, history.length - 13)
  const record = history[targetIndex]
  if (!record) return null
  const value = record[field]
  return typeof value === 'number' ? value : null
}

const calculateIndicatorScores = (
  data: MarketIndicators,
  history: MarketHistoryRecord[] = []
): IndicatorScore[] => {
  const scores: IndicatorScore[] = []

  const addIndicator = (
    name: string,
    value: number | string,
    rawValue: number,
    baseScoreRaw: number,
    category: string,
    range: string,
    description: string,
    min: number,
    max: number,
    historyField: keyof MarketHistoryRecord,
    invert: boolean
  ) => {
    const timing = indicatorTiming[name] || { timing: 'coincident' as IndicatorTiming, currentWeight: 0.7, momentumWeight: 0.3 }
    const baseScore = applyExtremeCap(baseScoreRaw)
    const threeMonthAgoValue = getThreeMonthAgoValue(history, historyField)
    let momentumScore = 50

    if (threeMonthAgoValue !== null) {
      const threeMonthAgoScore = invert
        ? normalizeScore(threeMonthAgoValue, min, max, true)
        : normalizeScore(threeMonthAgoValue, min, max, false)
      momentumScore = calculateMomentumScore(baseScoreRaw, threeMonthAgoScore)
    }

    const finalScore = applyExtremeCap(
      baseScore * timing.currentWeight + momentumScore * timing.momentumWeight
    )

    scores.push({
      name,
      value,
      score: finalScore,
      baseScore,
      momentumScore,
      category,
      range,
      description,
      rawValue,
      min,
      max,
      timing: timing.timing,
    })
  }

  if (data.fearGreed) {
    addIndicator(
      'Fear & Greed',
      data.fearGreed.value,
      data.fearGreed.value,
      100 - data.fearGreed.value,
      'sentiment',
      '0-100',
      '낮을수록(공포) 매력 상승, 높을수록(탐욕) 매력 하락',
      0, 100,
      'fear_greed',
      true
    )
  }

  if (data.vix) {
    addIndicator(
      'VIX',
      data.vix.toFixed(1),
      data.vix,
      normalizeScore(data.vix, 12, 40, false),
      'sentiment',
      '12-40',
      '높을수록(공포) 매력 상승. 40+ 패닉은 적극 매수 구간',
      12, 40,
      'vix',
      false
    )
  }

  if (data.spyVs200MA) {
    addIndicator(
      'S&P vs 200MA',
      `${data.spyVs200MA.percentAbove > 0 ? '+' : ''}${data.spyVs200MA.percentAbove.toFixed(1)}%`,
      data.spyVs200MA.percentAbove,
      normalizeScore(data.spyVs200MA.percentAbove, -10, 10, true),
      'sentiment',
      '-10% ~ +10%',
      '200일선 아래일수록 매력 상승 (저점 매수 기회)',
      -10, 10,
      'spy_vs_200ma',
      true
    )
  }

  if (data.buffettIndicator) {
    addIndicator(
      'Buffett Indicator',
      `${data.buffettIndicator.value.toFixed(0)}%`,
      data.buffettIndicator.value,
      normalizeScore(data.buffettIndicator.value, 80, 250, true),
      'valuation',
      '80-250%',
      '시총/GDP 비율. 낮을수록(저평가) 매력 상승',
      80, 250,
      'buffett_indicator',
      true
    )
  }

  if (data.erp !== null) {
    addIndicator(
      'Equity Risk Premium',
      `${data.erp > 0 ? '+' : ''}${data.erp.toFixed(2)}%`,
      data.erp,
      normalizeScore(data.erp, -2, 6),
      'valuation',
      '-2% ~ +6%',
      '채권 대비 주식 초과수익률. 높을수록 매력 상승',
      -2, 6,
      'erp',
      false
    )
  }

  if (data.fedBalanceSheet) {
    addIndicator(
      'Fed Balance Sheet',
      `${data.fedBalanceSheet.yoyChange > 0 ? '+' : ''}${data.fedBalanceSheet.yoyChange.toFixed(1)}% YoY`,
      data.fedBalanceSheet.yoyChange,
      normalizeScore(data.fedBalanceSheet.yoyChange, -5, 15, true),
      'liquidity',
      '-5% ~ +15%',
      '긴축(QT) 중일수록 매력 상승. 완화 전환 시 상승 여력',
      -5, 15,
      'fed_balance_sheet_yoy',
      true
    )
  }

  if (data.m2Growth) {
    addIndicator(
      'M2 Growth',
      `${data.m2Growth.yoyChange > 0 ? '+' : ''}${data.m2Growth.yoyChange.toFixed(1)}% YoY`,
      data.m2Growth.yoyChange,
      normalizeScore(data.m2Growth.yoyChange, -5, 10, true),
      'liquidity',
      '-5% ~ +10%',
      '통화량 감소 중일수록 매력 상승. 확대 전환 시 상승 여력',
      -5, 10,
      'm2_growth_yoy',
      true
    )
  }

  if (data.highYieldSpread) {
    addIndicator(
      'HY Spread',
      `${data.highYieldSpread.toFixed(2)}%`,
      data.highYieldSpread,
      normalizeScore(data.highYieldSpread, 2.5, 8, false),
      'credit',
      '2.5-8%',
      '높을수록(신용위기 우려) 매력 상승. 6%+ 위기 = 기회',
      2.5, 8,
      'hy_spread',
      false
    )
  }

  if (data.yieldCurve10Y2Y !== null) {
    addIndicator(
      'Yield Curve 10Y-2Y',
      `${data.yieldCurve10Y2Y > 0 ? '+' : ''}${data.yieldCurve10Y2Y.toFixed(2)}%`,
      data.yieldCurve10Y2Y,
      normalizeScore(data.yieldCurve10Y2Y, -1, 2),
      'macro',
      '-1% ~ +2%',
      '정상(+)일수록 매력 상승. 역전(-) = 침체 우려',
      -1, 2,
      'yield_curve_10y2y',
      false
    )
  }

  if (data.yieldCurve10Y3M !== null) {
    addIndicator(
      'Yield Curve 10Y-3M',
      `${data.yieldCurve10Y3M > 0 ? '+' : ''}${data.yieldCurve10Y3M.toFixed(2)}%`,
      data.yieldCurve10Y3M,
      normalizeScore(data.yieldCurve10Y3M, -1, 2),
      'macro',
      '-1% ~ +2%',
      '연준 중시 지표. 정상(+)일수록 매력 상승',
      -1, 2,
      'yield_curve_10y3m',
      false
    )
  }

  if (data.initialClaims) {
    addIndicator(
      'Initial Claims',
      `${(data.initialClaims.value / 1000).toFixed(0)}K`,
      data.initialClaims.value,
      normalizeScore(data.initialClaims.value, 200000, 400000, false),
      'macro',
      '200K-400K',
      '높을수록(실업 증가) 매력 상승. 바닥 신호 = 반등 기대',
      200000, 400000,
      'initial_claims',
      false
    )
  }

  return scores
}

// History 전체에서 Timing Score 시계열 계산. 시간순(오름차순) 입력 가정.
// v4: drawdown_ath p10y + margin/SPY lagged p10y 결합
const calculateScoresFromHistory = (history: MarketHistoryRecord[]): number[] => {
  return calculateTimingScoreSeries(
    history.map(h => ({ spy_price: h.spy_price, margin_debt: h.margin_debt }))
  )
}

// HYG drawdown: 직전 52주 고점 대비 현재가
const calculateHygDrawdown = (history: MarketHistoryRecord[], selectedIdx: number): number | null => {
  const start = Math.max(0, selectedIdx - 52)
  const prices = history.slice(start, selectedIdx + 1).map(h => h.hyg_price).filter((p): p is number => p !== null && p !== undefined && Number.isFinite(p))
  if (prices.length < 13) return null
  const peak = Math.max(...prices)
  const current = prices[prices.length - 1]
  if (peak <= 0 || !Number.isFinite(current)) return null
  return current / peak - 1
}

const calculateRiskFromIndicators = (
  data: MarketIndicators,
  history: MarketHistoryRecord[] = [],
  selectedIdx: number = -1,
): RiskSignal => {
  const idx = selectedIdx >= 0 ? selectedIdx : history.length - 1
  const hygDd = history.length > 0 && idx >= 0 ? calculateHygDrawdown(history, idx) : null
  return calculateRiskSignal({
    vix: data.vix,
    hySpread: data.highYieldSpread,
    hygDrawdown: hygDd,
  })
}

type InvestmentStance = 'aggressive_plus' | 'aggressive' | 'moderate_aggressive' | 'neutral' | 'moderate_defensive' | 'defensive' | 'unknown'

// 임계값: scripts/long_horizon_analysis.py 결과 기반
// 분포가 거의 균등(0-100 percentile) 이므로 동일 간격 + 위기 시 80+ 자동 도달
const determineInvestmentStance = (avgScore: number): InvestmentStance => {
  if (!Number.isFinite(avgScore)) return 'unknown'
  if (avgScore >= 90) return 'aggressive_plus'
  if (avgScore >= 75) return 'aggressive'
  if (avgScore >= 60) return 'moderate_aggressive'
  if (avgScore >= 40) return 'neutral'
  if (avgScore >= 20) return 'moderate_defensive'
  return 'defensive'
}

const getStanceInfo = (stance: InvestmentStance) => {
  const info = {
    aggressive_plus: {
      label: '매수 적기',
      color: '#059669',
      description: 'S&P500이 ATH 대비 큰 폭으로 빠진 상태. 지난 10년 분포에서 상위 10% 수준의 매력. 1996~2026 데이터에서 이 점수대 진입 후 10년 보유 시 단 한 번도 손실 없었고 평균 CAGR +12.4%/yr (vs 평소 +6.9%/yr). 1년 후 손실 비율 4.3%.',
      allocation: { stocks: '90%', bonds: '10%', cash: '0%' },
      action: '목돈이 있다면 지금 투자를 적극 고려하세요',
    },
    aggressive: {
      label: '매수 우위',
      color: '#16a34a',
      description: 'ATH 대비 의미있는 조정 구간. 지난 10년 분포에서 상위 15~25%. 10년 보유 시 평균 CAGR +11.5%/yr (vs 평소 +6.9%/yr). 1년 후 손실 비율 13.2%.',
      allocation: { stocks: '80%', bonds: '15%', cash: '5%' },
      action: '목돈 투자를 고려해볼 만한 시점입니다',
    },
    moderate_aggressive: {
      label: '소폭 매수 우위',
      color: '#22c55e',
      description: '약간의 조정 구간. 지난 10년 분포에서 상위 25~40%. 10년 CAGR +11.1%/yr. 1년 후 손실 비율 9.0%.',
      allocation: { stocks: '70%', bonds: '20%', cash: '10%' },
      action: '목돈은 2~3회 분할 매수를 권장합니다',
    },
    neutral: {
      label: '중립',
      color: '#f59e0b',
      description: '평균적 매력도. 큰 조정도 아니고 ATH도 아닌 어정쩡한 구간. 10년 CAGR +8.6%/yr. 1년 후 손실 비율 21.6%로 가장 높은 변동성.',
      allocation: { stocks: '60%', bonds: '25%', cash: '15%' },
      action: '적립식 유지, 목돈은 더 좋은 기회를 기다리세요',
    },
    moderate_defensive: {
      label: '소폭 방어 우위',
      color: '#f97316',
      description: 'ATH 근처지만 약간 빠진 상태. 의외로 1년 후 손실 비율 31.4% (가장 높음) — 단기 침체 진입 가능성. 10년 CAGR은 +9.6%/yr로 나쁘진 않으나 단기 변동성이 큼.',
      allocation: { stocks: '50%', bonds: '25%', cash: '25%' },
      action: '목돈 투자는 보류, 분할 매수 또는 대기',
    },
    defensive: {
      label: '방어 우위',
      color: '#ef4444',
      description: 'ATH 근처(현재가 ≈ 최고가). 강세장 한가운데로, 단기 추가 상승 여력은 있으나 큰 조정 위험. 10년 CAGR +10.3%/yr (장기 보유는 OK). 새 자금 진입에는 매력적이지 않은 구간.',
      allocation: { stocks: '40%', bonds: '20%', cash: '40%' },
      action: '신규 진입은 보류, 조정을 기다리세요',
    },
    unknown: {
      label: '판단 불가',
      color: '#6b7280',
      description: '현재 시장 데이터가 충분하지 않아 정확한 판단이 어렵습니다.',
      allocation: { stocks: '-', bonds: '-', cash: '-' },
      action: '-',
    },
  }
  return info[stance]
}

// 실측값: scripts/long_horizon_analysis.py 출력
// 1996~2026 weekly data, drawdown_ath p10y score 기반
// 1년 hit rate + 평균 / 10년 CAGR + 누적
const getStanceProbability = (stance: InvestmentStance) => {
  const probabilities: Record<InvestmentStance, {
    year1: { up: number; avgUp: number; avgDown: number; avg: number };
    year10: { up: number; cagr: number; totalReturn: number };
  }> = {
    // 90+ 점 (n_1y=93, n_10y=36)
    aggressive_plus: {
      year1:  { up: 96, avgUp: 23.5,  avgDown: -3.5,  avg: 22.9 },
      year10: { up: 100, cagr: 12.4, totalReturn: 221.7 },
    },
    // 75-90 (n_1y≈80, n_10y≈30 추정)
    aggressive: {
      year1:  { up: 87, avgUp: 22.0,  avgDown: -7.0,  avg: 21.9 },
      year10: { up: 100, cagr: 11.5, totalReturn: 198.4 },
    },
    // 60-75 (n_1y=133)
    moderate_aggressive: {
      year1:  { up: 91, avgUp: 16.5,  avgDown: -10.0, avg: 15.5 },
      year10: { up: 100, cagr: 11.1, totalReturn: 187.6 },
    },
    // 40-60 (n_1y=241)
    neutral: {
      year1:  { up: 78, avgUp: 11.0,  avgDown: -13.5, avg: 5.7 },
      year10: { up: 100, cagr: 8.6,  totalReturn: 137.5 },
    },
    // 20-40 (n_1y=354) — 의외로 가장 안 좋은 단기 hit rate
    moderate_defensive: {
      year1:  { up: 69, avgUp: 11.2,  avgDown: -12.0, avg: 3.9 },
      year10: { up: 100, cagr: 9.6,  totalReturn: 158.7 },
    },
    // 0-20 (n_1y=278) — ATH 근처, 강세장 한가운데
    defensive: {
      year1:  { up: 80, avgUp: 12.0,  avgDown: -4.5,  avg: 8.7 },
      year10: { up: 100, cagr: 10.3, totalReturn: 168.4 },
    },
    unknown: {
      year1:  { up: 0, avgUp: 0, avgDown: 0, avg: 0 },
      year10: { up: 0, cagr: 0, totalReturn: 0 },
    },
  }
  return probabilities[stance]
}

const indicatorToHistoryField: Record<string, keyof MarketHistoryRecord> = {
  'Fear & Greed': 'fear_greed',
  'VIX': 'vix',
  'S&P vs 200MA': 'spy_vs_200ma',
  'Buffett Indicator': 'buffett_indicator',
  'Equity Risk Premium': 'erp',
  'Fed Balance Sheet': 'fed_balance_sheet_yoy',
  'M2 Growth': 'm2_growth_yoy',
  'HY Spread': 'hy_spread',
  'Yield Curve 10Y-2Y': 'yield_curve_10y2y',
  'Yield Curve 10Y-3M': 'yield_curve_10y3m',
  'Initial Claims': 'initial_claims',
}

const indicatorKoreanName: Record<string, string> = {
  'Fear & Greed': '공포탐욕지수',
  'VIX': '변동성지수',
  'S&P vs 200MA': 'S&P 200일선 대비',
  'Buffett Indicator': '버핏지표',
  'Equity Risk Premium': '주식위험프리미엄',
  'Fed Balance Sheet': '연준 대차대조표',
  'M2 Growth': 'M2 통화량',
  'HY Spread': '하이일드 스프레드',
  'Yield Curve 10Y-2Y': '장단기금리차 10Y-2Y',
  'Yield Curve 10Y-3M': '장단기금리차 10Y-3M',
  'Initial Claims': '신규실업수당청구',
}

// 지표의 의미 설명 (투자 타이밍 탭에서 사용)
const indicatorMeaning: Record<string, string> = {
  'Fear & Greed': 'CNN이 제공하는 시장 심리 지수. 투자자들의 감정 상태를 0(극단적 공포)~100(극단적 탐욕)으로 측정',
  'VIX': 'S&P 500 옵션 가격에서 산출되는 향후 30일 예상 변동성. 시장 불안감의 척도',
  'S&P vs 200MA': 'S&P 500 지수가 200일 이동평균선 대비 얼마나 위/아래에 있는지를 나타냄',
  'Buffett Indicator': '미국 주식시장 총 시가총액을 GDP로 나눈 비율. 워런 버핏이 선호하는 밸류에이션 지표',
  'Equity Risk Premium': '주식 기대수익률에서 무위험 채권 수익률을 뺀 값. 주식 투자의 위험 보상 수준',
  'Fed Balance Sheet': '연준 자산 규모의 연간 변화율. 양적완화(QE) 또는 긴축(QT) 상태를 보여줌',
  'M2 Growth': '광의통화(현금+예금+MMF 등) 공급량의 연간 변화율. 시중 유동성 수준을 나타냄',
  'HY Spread': '고수익(정크) 채권 수익률과 국채 수익률의 차이. 기업 신용 리스크 척도',
  'Yield Curve 10Y-2Y': '10년물 국채 수익률에서 2년물을 뺀 차이. 역전 시 경기침체 신호로 해석',
  'Yield Curve 10Y-3M': '10년물 국채 수익률에서 3개월물을 뺀 차이. 연준이 중시하는 경기 선행 지표',
  'Initial Claims': '처음으로 실업수당을 신청한 주간 인원수. 노동시장 건강 상태를 실시간으로 반영',
}

const generateExtremeIndicatorCommentary = (
  coreIndicators: IndicatorScore[],
  marketHistory: MarketHistoryRecord[],
  indicatorWeights: Record<string, number>
): string[] => {
  const commentaries: string[] = []

  const sortedIndicators = [...coreIndicators].sort(
    (a, b) => (indicatorWeights[b.name] || 0) - (indicatorWeights[a.name] || 0)
  )

  for (const indicator of sortedIndicators) {
    const historyField = indicatorToHistoryField[indicator.name]
    if (!historyField) continue

    const historyValues = marketHistory
      .map(h => h[historyField] as number | null)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b)

    if (historyValues.length < 10) continue

    const currentValue = indicator.rawValue
    const koreanName = indicatorKoreanName[indicator.name]

    const rank = historyValues.filter(v => v <= currentValue).length
    const percentile = Math.round((rank / historyValues.length) * 100)

    if (percentile <= 20 || percentile >= 80) {
      const isExtremeLow = percentile <= 20
      const extremeLabel = isExtremeLow ? `하위 ${percentile}%` : `상위 ${100 - percentile}%`

      if (indicator.name === 'Equity Risk Premium') {
        if (isExtremeLow) {
          commentaries.push(`${koreanName}가 ${indicator.value}로 ${extremeLabel} 수준입니다. 채권 대비 주식의 기대 초과수익이 매우 낮아, 역사적으로 후속 12개월 수익이 부진했던 구간입니다.`)
        } else {
          commentaries.push(`${koreanName}가 ${indicator.value}로 ${extremeLabel} 수준입니다. 채권 대비 주식의 위험 보상이 매우 두꺼운 구간으로, 역사적으로 매력적인 진입 시점이었습니다.`)
        }
      } else if (indicator.name === 'Buffett Indicator') {
        if (isExtremeLow) {
          commentaries.push(`${koreanName}가 ${indicator.value}로 ${extremeLabel} 수준입니다. 시총/GDP 비율이 역사적 저점 근처로, 장기 보유 기준 저평가 구간입니다.`)
        } else {
          commentaries.push(`${koreanName}가 ${indicator.value}로 ${extremeLabel} 수준입니다. 시총/GDP 비율이 역사적 고점 근처로, 장기 기대수익률이 낮은 구간입니다.`)
        }
      }
    }

    if (commentaries.length >= 2) break
  }

  return commentaries
}

// 채팅 메시지 타입
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export default function Market() {
  const [marketData, setMarketData] = useState<MarketIndicators | null>(null)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketError, setMarketError] = useState<string | null>(null)
  const [marketHistory, setMarketHistory] = useState<MarketHistoryRecord[]>([])
  const [selectedDateIndex, setSelectedDateIndex] = useState<number | null>(null)
  const [highlightStance, setHighlightStance] = useState<InvestmentStance | null>(null)

  // 채팅 관련 상태
  const [marketChatOpen, setMarketChatOpen] = useState(false)
  const [marketChatMessages, setMarketChatMessages] = useState<ChatMessage[]>([])
  const [marketChatInput, setMarketChatInput] = useState('')
  const [marketChatLoading, setMarketChatLoading] = useState(false)
  const [expandedIndicator, setExpandedIndicator] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'global' | 'macro' | 'kr-macro' | 'timing'>('overview')
  const [expandedMacroCard, setExpandedMacroCard] = useState<string | null>(null)
  const [chartPeriod, setChartPeriod] = useState<'1y' | '3y' | '5y' | '10y' | 'all'>('3y')

  // 날짜 기반 필터링을 위한 cutoff 날짜 계산
  const chartCutoffDate = useMemo(() => {
    const days = chartPeriod === '1y' ? 365 : chartPeriod === '3y' ? 365 * 3 : chartPeriod === '5y' ? 365 * 5 : chartPeriod === '10y' ? 365 * 10 : 365 * 100
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  }, [chartPeriod])

  // 글로벌 지수 데이터
  const [globalIndices, setGlobalIndices] = useState<{
    symbol: string
    name: string
    price: number
    change: number
    changePercent: number
    region: string
  }[]>([])
  const [globalLoading, setGlobalLoading] = useState(false)
  const [globalHistory, setGlobalHistory] = useState<{
    symbol: string
    name: string
    region: string
    date: string
    close_price: number
  }[]>([])
  const [selectedGlobalSymbol, setSelectedGlobalSymbol] = useState<string | null>(null)

  // 시장 데이터 로드
  useEffect(() => {
    if (!marketData && !marketLoading) {
      setMarketLoading(true)
      setMarketError(null)

      const fetchData = async () => {
        try {
          // 2번에 나눠서 가져오기 (Supabase 기본 limit 1000)
          const { data: batch1, error: error1 } = await supabase
            .from('market_indicators_history')
            .select('*')
            .order('date', { ascending: true })
            .range(0, 999)

          const { data: batch2, error: error2 } = await supabase
            .from('market_indicators_history')
            .select('*')
            .order('date', { ascending: true })
            .range(1000, 1999)

          if (error1) throw error1
          if (error2) throw error2

          const historyData = [...(batch1 || []), ...(batch2 || [])]

          if (historyData.length > 0) {
            setMarketHistory(historyData)
            const latest = historyData[historyData.length - 1]

            const transformed: MarketIndicators = {
              fearGreed: latest.fear_greed !== null ? {
                value: latest.fear_greed,
                rating: latest.fear_greed <= 25 ? 'Extreme Fear' :
                        latest.fear_greed <= 45 ? 'Fear' :
                        latest.fear_greed <= 55 ? 'Neutral' :
                        latest.fear_greed <= 75 ? 'Greed' : 'Extreme Greed',
                previousClose: latest.fear_greed,
                oneWeekAgo: latest.fear_greed,
                oneMonthAgo: latest.fear_greed,
                oneYearAgo: latest.fear_greed,
              } : null,
              vix: latest.vix,
              spyVs200MA: latest.spy_vs_200ma !== null ? {
                currentPrice: 0,
                ma200: 0,
                percentAbove: latest.spy_vs_200ma,
              } : null,
              buffettIndicator: latest.buffett_indicator !== null ? {
                value: latest.buffett_indicator,
                gdp: 0,
                marketCap: 0,
              } : null,
              fedBalanceSheet: latest.fed_balance_sheet_yoy !== null ? {
                value: 0,
                yoyChange: latest.fed_balance_sheet_yoy,
              } : null,
              m2Growth: latest.m2_growth_yoy !== null ? {
                value: 0,
                yoyChange: latest.m2_growth_yoy,
              } : null,
              highYieldSpread: latest.hy_spread,
              yieldCurve10Y2Y: latest.yield_curve_10y2y,
              yieldCurve10Y3M: latest.yield_curve_10y3m,
              initialClaims: latest.initial_claims !== null ? {
                value: latest.initial_claims,
                fourWeekAvg: latest.initial_claims,
              } : null,
              erp: latest.erp,
              treasury3m: latest.treasury_3m,
              lastUpdated: latest.date,
            }
            setMarketData(transformed)
          }
        } catch (err) {
          console.error('Market data fetch error:', err)
          setMarketError(err instanceof Error ? err.message : '데이터 로드 실패')
        } finally {
          setMarketLoading(false)
        }
      }

      fetchData()
    }
  }, [marketData, marketLoading])

  // 글로벌 지수 데이터 로드 (DB에서)
  const [globalFetched, setGlobalFetched] = useState(false)

  useEffect(() => {
    if (activeTab === 'global' && !globalFetched && !globalLoading) {
      setGlobalLoading(true)

      const fetchGlobalIndices = async () => {
        try {
          const allData: typeof globalHistory = []
          const batchSize = 1000
          let offset = 0
          let hasMore = true

          while (hasMore) {
            const { data: batchData, error: batchError } = await supabase
              .from('global_indices_history')
              .select('symbol, name, region, date, close_price')
              .order('date', { ascending: true })
              .range(offset, offset + batchSize - 1)

            if (batchError) throw batchError

            if (batchData && batchData.length > 0) {
              allData.push(...batchData)
              offset += batchSize
              hasMore = batchData.length === batchSize
            } else {
              hasMore = false
            }
          }

          if (allData.length > 0) {
            setGlobalHistory(allData)

            const symbols = [...new Set(allData.map(d => d.symbol))]
            const results: typeof globalIndices = []

            for (const symbol of symbols) {
              const symbolData = allData.filter(d => d.symbol === symbol)
              if (symbolData.length < 2) continue

              const latest = symbolData[symbolData.length - 1]
              const prev = symbolData[symbolData.length - 2]
              const change = latest.close_price - prev.close_price
              const changePercent = (change / prev.close_price) * 100

              results.push({
                symbol: latest.symbol,
                name: latest.name,
                price: latest.close_price,
                change,
                changePercent,
                region: latest.region,
              })
            }

            setGlobalIndices(results)
          }
        } catch (err) {
          console.error('Failed to fetch global indices:', err)
        } finally {
          setGlobalFetched(true)
          setGlobalLoading(false)
        }
      }

      fetchGlobalIndices()
    }
  }, [activeTab, globalFetched, globalLoading])

  // 선택된 날짜의 데이터
  const selectedMarketData = useMemo(() => {
    if (marketHistory.length === 0) return marketData

    const index = selectedDateIndex ?? marketHistory.length - 1
    const record = marketHistory[index]
    if (!record) return marketData

    return {
      fearGreed: record.fear_greed !== null ? {
        value: record.fear_greed,
        rating: record.fear_greed <= 25 ? 'Extreme Fear' :
                record.fear_greed <= 45 ? 'Fear' :
                record.fear_greed <= 55 ? 'Neutral' :
                record.fear_greed <= 75 ? 'Greed' : 'Extreme Greed',
        previousClose: record.fear_greed,
        oneWeekAgo: record.fear_greed,
        oneMonthAgo: record.fear_greed,
        oneYearAgo: record.fear_greed,
      } : null,
      vix: record.vix,
      spyVs200MA: record.spy_vs_200ma !== null ? {
        currentPrice: 0,
        ma200: 0,
        percentAbove: record.spy_vs_200ma,
      } : null,
      buffettIndicator: record.buffett_indicator !== null ? {
        value: record.buffett_indicator,
        gdp: 0,
        marketCap: 0,
      } : null,
      fedBalanceSheet: record.fed_balance_sheet_yoy !== null ? {
        value: 0,
        yoyChange: record.fed_balance_sheet_yoy,
      } : null,
      m2Growth: record.m2_growth_yoy !== null ? {
        value: 0,
        yoyChange: record.m2_growth_yoy,
      } : null,
      highYieldSpread: record.hy_spread,
      yieldCurve10Y2Y: record.yield_curve_10y2y,
      yieldCurve10Y3M: record.yield_curve_10y3m,
      initialClaims: record.initial_claims !== null ? {
        value: record.initial_claims,
        fourWeekAvg: record.initial_claims,
      } : null,
      erp: record.erp,
      treasury3m: record.treasury_3m,
      lastUpdated: record.date,
    } as MarketIndicators
  }, [marketHistory, selectedDateIndex, marketData])

  // Timing Score 시계열 (drawdown_ath rolling 10y percentile)
  // history 전체에 대해 한 번 계산. 각 인덱스의 score는 해당 시점까지의 history만으로 산출됨.
  const timingScoreSeries = useMemo(() => {
    if (marketHistory.length === 0) return []
    return calculateScoresFromHistory(marketHistory)
  }, [marketHistory])

  // 현재(또는 선택된) 시점의 score
  const selectedScore = useMemo(() => {
    if (timingScoreSeries.length === 0) return NaN
    const idx = selectedDateIndex ?? timingScoreSeries.length - 1
    return timingScoreSeries[idx] ?? NaN
  }, [timingScoreSeries, selectedDateIndex])

  // 채팅 전송
  const handleMarketChatSend = async () => {
    if (!marketChatInput.trim() || marketChatLoading || !selectedMarketData) return

    const userMessage = marketChatInput.trim()
    setMarketChatInput('')
    setMarketChatMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setMarketChatLoading(true)

    try {
      const scores = calculateIndicatorScores(selectedMarketData, marketHistory)
      const scoreValid = Number.isFinite(selectedScore)
      const avgScore = scoreValid ? Math.round(selectedScore) : NaN
      const stance = determineInvestmentStance(avgScore)
      const stanceInfo = getStanceInfo(stance)

      // 투자 타이밍 지표
      const indicatorSummary = scores.map(s =>
        `${s.name}: ${s.value} (${Math.round(s.score)}점)`
      ).join('\n')

      // 매크로 지표 요약
      const latestRecord = marketHistory[marketHistory.length - 1]
      const macroSummary = latestRecord ? `
성장: GDP ${latestRecord.gdp_growth_qoq?.toFixed(1) ?? 'N/A'}%, ISM제조 ${latestRecord.ism_manufacturing?.toFixed(1) ?? 'N/A'}, ISM서비스 ${latestRecord.ism_services?.toFixed(1) ?? 'N/A'}
물가: CPI ${latestRecord.cpi_yoy?.toFixed(1) ?? 'N/A'}%, Core CPI ${latestRecord.core_cpi_yoy?.toFixed(1) ?? 'N/A'}%, PCE ${latestRecord.pce_yoy?.toFixed(1) ?? 'N/A'}%
고용: 실업률 ${latestRecord.unemployment_rate?.toFixed(1) ?? 'N/A'}%, 노동참가 ${latestRecord.labor_participation?.toFixed(1) ?? 'N/A'}%
금리: 10Y ${latestRecord.treasury_10y?.toFixed(2) ?? 'N/A'}%, 2Y ${latestRecord.treasury_2y?.toFixed(2) ?? 'N/A'}%, 달러 ${latestRecord.dollar_index?.toFixed(1) ?? 'N/A'}` : ''

      // 글로벌 지수 요약
      const globalSummary = globalIndices.length > 0 ? `
글로벌지수: ${globalIndices.slice(0, 6).map(idx => `${idx.name} ${idx.changePercent >= 0 ? '+' : ''}${idx.changePercent.toFixed(1)}%`).join(', ')}` : ''

      // 전체 지표 텍스트
      const indicatorsText = `투자매력도: ${scoreValid ? `${avgScore}점` : '데이터 부족'} (${stanceInfo.label})
${indicatorSummary}
${macroSummary}
${globalSummary}
권장배분: 주식 ${stanceInfo.allocation.stocks}, 채권 ${stanceInfo.allocation.bonds}, 현금 ${stanceInfo.allocation.cash}`

      const response = await fetch('/api/market-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: userMessage,
          marketContext: {
            date: selectedMarketData.lastUpdated,
            indicators: indicatorsText,
          },
        }),
      })

      const data = await response.json()
      setMarketChatMessages(prev => [...prev, { role: 'assistant', content: data.answer }])
    } catch (error) {
      console.error('Chat error:', error)
      setMarketChatMessages(prev => [...prev, {
        role: 'assistant',
        content: '죄송합니다. 응답을 생성하는 중 오류가 발생했습니다.'
      }])
    } finally {
      setMarketChatLoading(false)
    }
  }

  // 지표 분류
  const leadingIndicators = ['Yield Curve 10Y-2Y', 'Yield Curve 10Y-3M', 'HY Spread', 'Fed Balance Sheet', 'M2 Growth']
  const coincidentIndicators = ['VIX', 'S&P vs 200MA', 'Initial Claims', 'Equity Risk Premium']
  const laggingIndicators = ['Fear & Greed', 'Buffett Indicator']

  return (
    <div className="calculator-container">
      <header className="calc-header">
        <h1 className="calc-title">글로벌 시장 환경 진단</h1>
        <p className="calc-subtitle">
          1996~2026 30년 분석. S&P500 ATH 대비 drawdown의 10년 percentile로 매력도 산출, VIX·HY는 리스크 신호로 별도 표시
        </p>
      </header>

      {/* 탭 네비게이션 */}
      <div className="calc-tabs">
        <button
          className={`calc-tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          종합
        </button>
        <button
          className={`calc-tab ${activeTab === 'global' ? 'active' : ''}`}
          onClick={() => setActiveTab('global')}
        >
          글로벌 지수
        </button>
        <button
          className={`calc-tab ${activeTab === 'macro' ? 'active' : ''}`}
          onClick={() => setActiveTab('macro')}
        >
          미국 매크로 지표
        </button>
        <button
          className={`calc-tab ${activeTab === 'kr-macro' ? 'active' : ''}`}
          onClick={() => setActiveTab('kr-macro')}
        >
          한국 매크로 지표
        </button>
        <button
          className={`calc-tab ${activeTab === 'timing' ? 'active' : ''}`}
          onClick={() => setActiveTab('timing')}
        >
          투자 타이밍 지표
        </button>
      </div>

      {/* 글로벌 지수 탭 */}
      {activeTab === 'global' && (
        <div className="calc-section">
          <div className="market-timing-dashboard">
            <div className="market-timing-header">
              <h2 className="market-timing-title">글로벌 주요 지수</h2>
              <p className="market-timing-desc">전세계 주요 주식시장 지수 추이</p>
            </div>
            <div className="chart-period-selector">
              {(['1y', '3y', '5y', '10y', 'all'] as const).map(period => (
                <button
                  key={period}
                  className={`period-btn ${chartPeriod === period ? 'active' : ''}`}
                  onClick={() => setChartPeriod(period)}
                >
                  {period === '1y' ? '1년' : period === '3y' ? '3년' : period === '5y' ? '5년' : period === '10y' ? '10년' : '전체'}
                </button>
              ))}
            </div>

            {globalLoading && (
              <div className="market-loading">
                <div className="market-spinner"></div>
                <p>글로벌 지수 데이터를 불러오는 중...</p>
              </div>
            )}

            {!globalLoading && globalIndices.length > 0 && (
              <>
                {['미국', '유럽', '아시아', '기타'].map(region => {
                  const regionIndices = globalIndices.filter(i => i.region === region)
                  if (regionIndices.length === 0) return null
                  return (
                    <div key={region} className="global-region-section">
                      <h3 className="global-region-title">{region}</h3>
                      <div className="global-indices-grid">
                        {regionIndices.map(idx => {
                          // 날짜 기반 필터링: 1년=365일, 3년=1095일, 5년=1825일, 10년=3650일
                          const periodDays = chartPeriod === '1y' ? 365 : chartPeriod === '3y' ? 365 * 3 : chartPeriod === '5y' ? 365 * 5 : chartPeriod === '10y' ? 365 * 10 : 365 * 100
                          const cutoffDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000)
                          const symbolHistory = globalHistory
                            .filter(h => h.symbol === idx.symbol && new Date(h.date) >= cutoffDate)
                          const isExpanded = selectedGlobalSymbol === idx.symbol
                          // 전일 대비 색상
                          const chartColor = idx.change >= 0 ? '#22c55e' : '#ef4444'

                          return (
                            <div
                              key={idx.symbol}
                              className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                              onClick={() => setSelectedGlobalSymbol(isExpanded ? null : idx.symbol)}
                              style={{ cursor: 'pointer' }}
                            >
                              <div className="global-index-header">
                                <span className="global-index-name">{idx.name}</span>
                                <span className="global-index-symbol">{idx.symbol}</span>
                              </div>
                              <div className="global-index-price">
                                {idx.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </div>
                              <div className={`global-index-change ${idx.change >= 0 ? 'up' : 'down'}`}>
                                <span className="global-change-label">주간</span>
                                <span className="global-change-value">
                                  {idx.change >= 0 ? '+' : ''}{idx.change.toFixed(2)}
                                </span>
                                <span className="global-change-percent">
                                  ({idx.changePercent >= 0 ? '+' : ''}{idx.changePercent.toFixed(2)}%)
                                </span>
                              </div>

                              {/* 미니 차트 (확장 시 숨김) */}
                              {!isExpanded && symbolHistory.length > 5 && (
                                <div className="global-mini-chart">
                                  <Line
                                    data={{
                                      labels: symbolHistory.map(h => h.date),
                                      datasets: [{
                                        data: symbolHistory.map(h => h.close_price),
                                        borderColor: chartColor,
                                        borderWidth: 1.5,
                                        backgroundColor: `${chartColor}15`,
                                        fill: true,
                                        tension: 0.3,
                                        pointRadius: 0,
                                      }],
                                    }}
                                    options={{
                                      responsive: true,
                                      maintainAspectRatio: false,
                                      plugins: { legend: { display: false }, tooltip: { enabled: false } },
                                      scales: { x: { display: false }, y: { display: false } },
                                    }}
                                  />
                                </div>
                              )}

                              {/* 확장 시 상세 차트 */}
                              {isExpanded && symbolHistory.length > 5 && (
                                <div className="global-detail-chart" onClick={(e) => e.stopPropagation()}>
                                  <div className="global-chart-header">
                                    <span>{chartPeriod === '1y' ? '1년' : chartPeriod === '3y' ? '3년' : chartPeriod === '5y' ? '5년' : chartPeriod === '10y' ? '10년' : '전체'} 추이</span>
                                    <span className="global-chart-range">
                                      {symbolHistory[0]?.date} ~ {symbolHistory[symbolHistory.length - 1]?.date}
                                    </span>
                                  </div>
                                  <Line
                                    data={{
                                      labels: symbolHistory.map(h => {
                                        const d = new Date(h.date)
                                        return `${d.getFullYear()}.${d.getMonth() + 1}`
                                      }),
                                      datasets: [{
                                        label: idx.name,
                                        data: symbolHistory.map(h => h.close_price),
                                        borderColor: chartColor,
                                        borderWidth: 2,
                                        backgroundColor: `${chartColor}20`,
                                        fill: true,
                                        tension: 0.3,
                                        pointRadius: 0,
                                        pointHoverRadius: 4,
                                      }],
                                    }}
                                    options={{
                                      responsive: true,
                                      maintainAspectRatio: false,
                                      interaction: {
                                        mode: 'index',
                                        intersect: false,
                                      },
                                      plugins: {
                                        legend: { display: false },
                                        tooltip: {
                                          callbacks: {
                                            label: (ctx) => ctx.parsed.y?.toLocaleString() ?? '',
                                          },
                                        },
                                      },
                                      scales: {
                                        x: {
                                          ticks: { maxTicksLimit: 12, font: { size: 10 } },
                                          grid: { display: false },
                                        },
                                        y: {
                                          ticks: {
                                            font: { size: 10 },
                                            callback: (v) => Number(v).toLocaleString(),
                                          },
                                          grid: { color: '#f1f5f9' },
                                        },
                                      },
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            {!globalLoading && globalIndices.length === 0 && (
              <div className="market-error">
                <p>글로벌 지수 데이터를 불러오지 못했습니다.</p>
                <button onClick={() => setGlobalIndices([])}>다시 시도</button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="calc-section" style={{ display: activeTab === 'global' ? 'none' : 'block' }}>
        {/* 날짜 선택 슬라이더 - overview 탭에서만 표시 */}
        {activeTab === 'overview' && marketHistory.length > 0 && (
          <div className="market-date-slider">
            <div className="market-date-slider-header">
              <span className="market-date-slider-label">조회 날짜</span>
              <span className="market-date-slider-value">
                {marketHistory[selectedDateIndex ?? marketHistory.length - 1]?.date || ''}
                {(selectedDateIndex === null || selectedDateIndex === marketHistory.length - 1) && (
                  <span className="market-date-latest-badge">최신</span>
                )}
              </span>
            </div>
            <input
              key={`slider-${marketHistory.length}`}
              type="range"
              min={0}
              max={marketHistory.length - 1}
              value={selectedDateIndex !== null ? selectedDateIndex : marketHistory.length - 1}
              onChange={(e) => {
                const idx = parseInt(e.target.value)
                setSelectedDateIndex(idx === marketHistory.length - 1 ? null : idx)
              }}
              className="market-date-slider-input"
            />
            <div className="market-date-slider-range">
              <span>{marketHistory[0]?.date}</span>
              <span>{marketHistory[marketHistory.length - 1]?.date}</span>
            </div>
          </div>
        )}

        {marketLoading && (
          <div className="market-loading">
            <div className="market-spinner"></div>
            <p>시장 데이터를 불러오는 중...</p>
          </div>
        )}

        {marketError && (
          <div className="market-error">
            <p>데이터를 불러오는데 실패했습니다: {marketError}</p>
            <button onClick={() => { setMarketData(null); setMarketError(null); }}>
              다시 시도
            </button>
          </div>
        )}

        {selectedMarketData && (() => {
          const scores = calculateIndicatorScores(selectedMarketData, marketHistory)
          const scoreValid = Number.isFinite(selectedScore)
          const avgScore = scoreValid ? Math.round(selectedScore) : NaN
          const stance = determineInvestmentStance(avgScore)
          const stanceInfo = getStanceInfo(stance)
          const missingTimingInputs: string[] = []
          if (selectedMarketData.lastUpdated && !scoreValid) {
            missingTimingInputs.push('SPY 10년 이력')
          }

          // 새 Timing Score는 단일 SPY 시계열만 사용. "핵심 지표" 라벨은 더 이상 적용 안 됨.
          // 모든 11개 지표는 참고 정보로 표시.
          const indicatorWeightsDisplay: Record<string, number> = {}
          const coreIndicators: typeof scores = []
          const refIndicators = scores

          // 시계열에서 valid score만 추출해 ranking 계산
          const validHistoryScores = timingScoreSeries.filter(s => Number.isFinite(s))
          const totalCount = validHistoryScores.length
          const rankInAll = scoreValid ? validHistoryScores.filter(s => s > avgScore).length + 1 : 0

          const oneYearAgo = new Date()
          oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
          const oneYearScores = marketHistory
            .map((h, i) => ({ date: h.date, score: timingScoreSeries[i] }))
            .filter(item => new Date(item.date) >= oneYearAgo && Number.isFinite(item.score))
            .map(item => item.score)
          const oneYearCount = oneYearScores.length
          const rankIn1Y = scoreValid ? oneYearScores.filter(s => s > avgScore).length + 1 : 0

          // 탭별 지표 필터링
          const getIndicatorsByTiming = (timing: 'leading' | 'coincident' | 'lagging') => {
            const timingMap: Record<string, string[]> = {
              leading: leadingIndicators,
              coincident: coincidentIndicators,
              lagging: laggingIndicators,
            }
            return scores.filter(s => timingMap[timing].includes(s.name))
          }

          return (
            <>
              {/* 종합 탭 */}
              {activeTab === 'overview' && (
                <>
                  {/* 투자 매력도 기반 자산배분 가이드 */}
                  <div className="market-phase-card" style={{ borderColor: stanceInfo.color }}>
                <div className="market-phase-header">
                  <div className="market-phase-badge" style={{ backgroundColor: stanceInfo.color }}>
                    {stanceInfo.label}
                  </div>
                  <div className="market-phase-score">
                    <span className="market-score-label">투자 매력도</span>
                    <span className="market-score-value">{scoreValid ? avgScore : '—'}</span>
                    <span className="market-score-max">/100</span>
                  </div>
                </div>
                {scoreValid ? (
                  <div className="market-percentile-info">
                    <span className="market-percentile-item">
                      1년 내 {rankIn1Y}위 / {oneYearCount}건
                    </span>
                    <span className="market-percentile-divider">|</span>
                    <span className="market-percentile-item">
                      10년 내 {rankInAll}위 / {totalCount}건
                    </span>
                  </div>
                ) : (
                  <div className="market-percentile-info">
                    <span className="market-percentile-item" style={{ color: '#dc2626' }}>
                      {missingTimingInputs.length > 0
                        ? `데이터 부족: ${missingTimingInputs.join(', ')} 누락`
                        : '데이터 부족'}
                    </span>
                  </div>
                )}

                {/* 표준정규분포 곡선 (점수 산출 불가 시 숨김) */}
                {scoreValid && (() => {
                  const actualMean = TIMING_SCORE_DISTRIBUTION.mean
                  const actualStdDev = TIMING_SCORE_DISTRIBUTION.std
                  const currentZScore = (avgScore - actualMean) / actualStdDev

                  const normalPDF = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)

                  const points = 60
                  const zMin = -3
                  const zMax = 3
                  const step = (zMax - zMin) / points

                  const width = 360
                  const height = 100
                  const topPadding = 30
                  const maxPDF = normalPDF(0)

                  let pathD = ''
                  for (let i = 0; i <= points; i++) {
                    const z = zMin + i * step
                    const x = (i / points) * width
                    const y = topPadding + height - (normalPDF(z) / maxPDF) * (height - 10)
                    pathD += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`
                  }

                  const clampedZ = Math.max(zMin, Math.min(zMax, currentZScore))
                  const currentX = ((clampedZ - zMin) / (zMax - zMin)) * width
                  const currentY = topPadding + height - (normalPDF(clampedZ) / maxPDF) * (height - 10)

                  const cdf = (z: number) => {
                    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741
                    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
                    const sign = z < 0 ? -1 : 1
                    const absZ = Math.abs(z)
                    const t = 1 / (1 + p * absZ)
                    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absZ * absZ / 2)
                    return 0.5 * (1 + sign * y)
                  }
                  const cdfValue = cdf(currentZScore)
                  const isAboveMedian = currentZScore >= 0
                  const percentileLabel = isAboveMedian
                    ? `상위 ${Math.round((1 - cdfValue) * 100)}%`
                    : `하위 ${Math.round(cdfValue * 100)}%`

                  // stance 경계와 일치하는 점수 라벨 (90/75/60/40/20)
                  const stanceBoundaries = [
                    { z: (90 - actualMean) / actualStdDev, label: '90' },
                    { z: (75 - actualMean) / actualStdDev, label: '75' },
                    { z: (60 - actualMean) / actualStdDev, label: '60' },
                    { z: 0, label: '50' },
                    { z: (40 - actualMean) / actualStdDev, label: '40' },
                    { z: (20 - actualMean) / actualStdDev, label: '20' },
                  ]

                  return (
                    <div className="market-distribution">
                      <div className="market-distribution-header">
                        <span className="market-distribution-title">역사적 분포 내 위치</span>
                        <span className="market-distribution-stats">
                          Z = {currentZScore >= 0 ? '+' : ''}{currentZScore.toFixed(2)} ({percentileLabel})
                        </span>
                      </div>
                      <div className="market-normal-curve">
                        <svg viewBox={`0 0 ${width} ${topPadding + height + 35}`} preserveAspectRatio="xMidYMid meet">
                          <defs>
                            <linearGradient id="curveGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
                              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.05" />
                            </linearGradient>
                          </defs>
                          <path
                            d={`${pathD} L ${width} ${topPadding + height} L 0 ${topPadding + height} Z`}
                            fill="url(#curveGradient)"
                          />
                          <path d={pathD} fill="none" stroke="#94a3b8" strokeWidth="2" />

                          {stanceBoundaries.map(({ z, label }) => {
                            const x = ((z - zMin) / (zMax - zMin)) * width
                            const lineY = topPadding + height - (normalPDF(z) / maxPDF) * (height - 10)
                            return (
                              <g key={z}>
                                <line
                                  x1={x}
                                  y1={lineY}
                                  x2={x}
                                  y2={topPadding + height}
                                  stroke="#cbd5e1"
                                  strokeWidth="1"
                                  strokeDasharray="2,2"
                                />
                                <text
                                  x={x}
                                  y={topPadding - 8}
                                  textAnchor="middle"
                                  fontSize="9"
                                  fill="#64748b"
                                >
                                  {label}점
                                </text>
                              </g>
                            )
                          })}

                          <line
                            x1={currentX}
                            y1={currentY}
                            x2={currentX}
                            y2={topPadding + height}
                            stroke="#3b82f6"
                            strokeWidth="2.5"
                            strokeDasharray="4,2"
                          />
                          <circle cx={currentX} cy={currentY} r="6" fill="#3b82f6" />
                          <text
                            x={currentX}
                            y={currentY - 12}
                            textAnchor="middle"
                            fontSize="12"
                            fontWeight="600"
                            fill="#3b82f6"
                          >
                            {avgScore}점
                          </text>

                          {[-3, -2, -1, 0, 1, 2, 3].map((z) => {
                            const x = ((z - zMin) / (zMax - zMin)) * width
                            return (
                              <text
                                key={z}
                                x={x}
                                y={topPadding + height + 14}
                                textAnchor="middle"
                                fontSize="10"
                                fill="#94a3b8"
                              >
                                {z === 0 ? '0' : z > 0 ? `+${z}` : z}
                              </text>
                            )
                          })}

                          {stanceBoundaries.filter(b => b.z !== 0).map(({ z }) => {
                            const x = ((z - zMin) / (zMax - zMin)) * width
                            const zLabel = z.toFixed(1)
                            return (
                              <text
                                key={`z-${z}`}
                                x={x}
                                y={topPadding + height + 26}
                                textAnchor="middle"
                                fontSize="8"
                                fill="#94a3b8"
                              >
                                z={z > 0 ? `+${zLabel}` : zLabel}
                              </text>
                            )
                          })}
                        </svg>
                      </div>
                      <div className="market-distribution-legend">
                        <span>평균 = 50점 (Z=0)</span>
                        <span>실제 분포 std: 약 7점</span>
                      </div>
                    </div>
                  )
                })()}

                <div className="market-insight-section">
                  <div className="market-insight-box">
                    <div className="market-insight-header">
                      <span className="market-insight-icon">i</span>
                      <span className="market-insight-title">현재 시장 상황</span>
                    </div>
                    <p className="market-insight-content">{stanceInfo.description}</p>
                    {(() => {
                      const extremeComments = generateExtremeIndicatorCommentary(coreIndicators, marketHistory, indicatorWeightsDisplay)
                      if (extremeComments.length === 0) return null
                      return (
                        <div className="market-extreme-commentary">
                          {extremeComments.map((comment, idx) => (
                            <p key={idx} className="market-extreme-comment">{comment}</p>
                          ))}
                        </div>
                      )
                    })()}
                  </div>

                  <div className="market-recommendation-row">
                    <div className="market-action-box">
                      <span className="market-action-label">권장 행동</span>
                      <p className="market-action-content">{stanceInfo.action}</p>
                    </div>

                    <div className="market-allocation-box">
                      <span className="market-allocation-label-title">권장 자산배분</span>
                      <div className="market-allocation-bars">
                        <div className="market-allocation-bar-item">
                          <div className="market-allocation-bar-header">
                            <span>주식</span>
                            <span>{stanceInfo.allocation.stocks}</span>
                          </div>
                          <div className="market-allocation-bar-track">
                            <div
                              className="market-allocation-bar-fill stocks"
                              style={{ width: `${parseInt(stanceInfo.allocation.stocks) || 50}%` }}
                            />
                          </div>
                        </div>
                        <div className="market-allocation-bar-item">
                          <div className="market-allocation-bar-header">
                            <span>채권</span>
                            <span>{stanceInfo.allocation.bonds}</span>
                          </div>
                          <div className="market-allocation-bar-track">
                            <div
                              className="market-allocation-bar-fill bonds"
                              style={{ width: `${parseInt(stanceInfo.allocation.bonds) || 30}%` }}
                            />
                          </div>
                        </div>
                        <div className="market-allocation-bar-item">
                          <div className="market-allocation-bar-header">
                            <span>현금</span>
                            <span>{stanceInfo.allocation.cash}</span>
                          </div>
                          <div className="market-allocation-bar-track">
                            <div
                              className="market-allocation-bar-fill cash"
                              style={{ width: `${parseInt(stanceInfo.allocation.cash) || 10}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 1년 hit rate + 10년 CAGR */}
                  {(() => {
                    const prob = getStanceProbability(stance)
                    return (
                      <div className="market-probability-box">
                        <span className="market-probability-title">지금 투자하면? (1996~2026 30년 백테스트 기준)</span>
                        <div className="market-probability-grid">
                          <div className="market-probability-period">
                            <span className="market-probability-label">1년 후 (단기)</span>
                            <div className="market-probability-bars">
                              <div className="market-probability-bar-row">
                                <span className="market-probability-direction up">상승 확률</span>
                                <div className="market-probability-bar-track">
                                  <div
                                    className="market-probability-bar-fill up"
                                    style={{ width: `${prob.year1.up}%` }}
                                  />
                                </div>
                                <span className="market-probability-value">{prob.year1.up}%</span>
                                <span className="market-probability-avg">(+{prob.year1.avgUp.toFixed(1)}%)</span>
                              </div>
                              <div className="market-probability-bar-row">
                                <span className="market-probability-direction down">하락 시</span>
                                <div className="market-probability-bar-track">
                                  <div
                                    className="market-probability-bar-fill down"
                                    style={{ width: `${100 - prob.year1.up}%` }}
                                  />
                                </div>
                                <span className="market-probability-value">{100 - prob.year1.up}%</span>
                                <span className="market-probability-avg">({prob.year1.avgDown.toFixed(1)}%)</span>
                              </div>
                              <div style={{ marginTop: '8px', fontSize: '12px', color: '#475569' }}>
                                평균 수익률: <strong>{prob.year1.avg >= 0 ? '+' : ''}{prob.year1.avg.toFixed(1)}%</strong>
                              </div>
                            </div>
                          </div>
                          <div className="market-probability-period">
                            <span className="market-probability-label">10년 후 (장기)</span>
                            <div className="market-probability-bars">
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                <div style={{ fontSize: '13px' }}>
                                  CAGR: <strong style={{ color: prob.year10.cagr >= 9 ? '#059669' : '#475569', fontSize: '16px' }}>
                                    +{prob.year10.cagr.toFixed(1)}%/yr
                                  </strong>
                                  <span style={{ color: '#94a3b8', fontSize: '11px', marginLeft: '6px' }}>(시장 평균 +6.9%/yr)</span>
                                </div>
                                <div style={{ fontSize: '13px' }}>
                                  10년 누적: <strong>+{prob.year10.totalReturn.toFixed(0)}%</strong>
                                  <span style={{ color: '#94a3b8', fontSize: '11px', marginLeft: '6px' }}>(1천만원 → {(10000 * (1 + prob.year10.totalReturn / 100)).toFixed(0)}만원)</span>
                                </div>
                                <div style={{ fontSize: '13px' }}>
                                  손실 확률: <strong style={{ color: prob.year10.up === 100 ? '#059669' : '#475569' }}>
                                    {100 - prob.year10.up}%
                                  </strong>
                                  <span style={{ color: '#94a3b8', fontSize: '11px', marginLeft: '6px' }}>(시장 평균 10%)</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                </div>
              </div>

              {/* 점수 구성요소 카드 (drawdown + margin/SPY) */}
              {(() => {
                const histIdx = selectedDateIndex ?? marketHistory.length - 1
                if (histIdx < 0 || histIdx >= marketHistory.length) return null
                const histToHere = marketHistory.slice(0, histIdx + 1)
                if (histToHere.length === 0) return null
                const prices = histToHere.map(h => h.spy_price).filter((p): p is number => p !== null)
                if (prices.length === 0) return null
                const currentSpy = prices[prices.length - 1]
                const ath = Math.max(...prices)
                const dd = ath > 0 ? (currentSpy / ath - 1) * 100 : 0

                // 52w high
                const last52 = prices.slice(-52)
                const high52 = Math.max(...last52)
                const dd52 = high52 > 0 ? (currentSpy / high52 - 1) * 100 : 0

                // Margin/SPY ratio + percentile
                const currentRec = marketHistory[histIdx]
                const margin = currentRec.margin_debt
                const marginPerSpy = margin && currentSpy > 0 ? margin / currentSpy : null
                const ddP10y = scoreValid ? Math.round(avgScore * 0.8 * 100) / 100 : null
                void ddP10y

                return (
                  <div className="market-phase-card" style={{ borderColor: '#cbd5e1', marginTop: '16px' }}>
                    <div className="market-phase-header">
                      <div className="market-phase-badge" style={{ backgroundColor: '#64748b' }}>
                        점수 구성요소
                      </div>
                      <div className="market-phase-score">
                        <span className="market-score-label">S&P500</span>
                        <span className="market-score-value" style={{ fontSize: '18px' }}>
                          ${currentSpy.toFixed(0)}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '12px' }}>
                      <div>
                        <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '4px' }}>현재가 / 전 기간 ATH</div>
                        <div style={{ fontSize: '16px', fontWeight: 600, color: dd <= -10 ? '#16a34a' : dd <= -5 ? '#f59e0b' : '#475569' }}>
                          {dd.toFixed(1)}%
                        </div>
                        <div style={{ fontSize: '11px', color: '#94a3b8' }}>(80% 가중치)</div>
                      </div>
                      <div>
                        <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '4px' }}>52주 고점 대비</div>
                        <div style={{ fontSize: '16px', fontWeight: 600 }}>{dd52.toFixed(1)}%</div>
                        <div style={{ fontSize: '11px', color: '#94a3b8' }}>(참고)</div>
                      </div>
                      {marginPerSpy !== null && (
                        <div style={{ gridColumn: '1 / -1' }}>
                          <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '4px' }}>
                            FINRA Margin Debt / SPY price (레버리지 사이클)
                          </div>
                          <div style={{ fontSize: '16px', fontWeight: 600 }}>
                            {marginPerSpy.toFixed(0)}
                            <span style={{ fontSize: '11px', color: '#94a3b8', marginLeft: '6px' }}>
                              ($M / share) — 1.5개월 lag 적용, 20% 가중치
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* 리스크 신호 (VIX + HY Spread) */}
              {(() => {
                const risk = calculateRiskFromIndicators(selectedMarketData, marketHistory, selectedDateIndex ?? marketHistory.length - 1)
                const levelMeta: Record<typeof risk.level, { label: string; color: string; desc: string }> = {
                  normal:   { label: '정상',     color: '#22c55e', desc: '변동성·신용 스트레스 정상 범위.' },
                  elevated: { label: '주의',     color: '#f59e0b', desc: '평소보다 변동성/신용 스트레스 상승. 분할 매수 권장.' },
                  high:     { label: '경계',     color: '#f97316', desc: '시장 스트레스 높음. 신규 진입은 보수적으로.' },
                  extreme:  { label: '극단',     color: '#ef4444', desc: '역사적 상위 5% 스트레스 구간. 큰 변동성 동반.' },
                }
                const meta = levelMeta[risk.level]
                const fmt = (v: number | null) => v === null ? '—' : v.toFixed(2)
                return (
                  <div className="market-phase-card" style={{ borderColor: meta.color, marginTop: '16px' }}>
                    <div className="market-phase-header">
                      <div className="market-phase-badge" style={{ backgroundColor: meta.color }}>
                        리스크 {meta.label}
                      </div>
                      <div className="market-phase-score">
                        <span className="market-score-label">VIX / HY</span>
                        <span className="market-score-value" style={{ fontSize: '20px' }}>
                          {fmt(risk.vix.value)} / {fmt(risk.hy.value)}
                        </span>
                      </div>
                    </div>
                    <div className="market-percentile-info">
                      <span className="market-percentile-item">VIX: {risk.vix.level}</span>
                      <span className="market-percentile-divider">|</span>
                      <span className="market-percentile-item">HY Spread: {risk.hy.level}</span>
                      {risk.hyg.value !== null && (
                        <>
                          <span className="market-percentile-divider">|</span>
                          <span className="market-percentile-item">
                            HYG dd ({(risk.hyg.value * 100).toFixed(1)}%): {risk.hyg.level}
                          </span>
                        </>
                      )}
                    </div>
                    <p style={{ marginTop: '12px', fontSize: '13px', color: '#475569', lineHeight: 1.5 }}>
                      {meta.desc} 타이밍 점수와 함께 보세요 — 점수가 높아도 리스크 극단이면 진입을 분할하는 게 안전합니다.
                    </p>
                  </div>
                )
              })()}

              {/* 투자 매력도 vs S&P500 차트 */}
              {marketHistory.length > 0 && (() => {
                const periodMonths = { '1y': 12, '3y': 36, '5y': 60, '10y': 120, 'all': 999 }
                const targetMonths = periodMonths[chartPeriod]
                const startDate = new Date()
                startDate.setMonth(startDate.getMonth() - targetMonths)

                // filteredHistory + 일치하는 timingScoreSeries 인덱스 추출
                const filteredIndices: number[] = []
                marketHistory.forEach((h, i) => {
                  if (chartPeriod === 'all' || new Date(h.date) >= startDate) {
                    filteredIndices.push(i)
                  }
                })
                if (filteredIndices.length === 0) return null
                const filteredHistory = filteredIndices.map(i => marketHistory[i])
                const compositeScores = filteredIndices.map(i => timingScoreSeries[i])
                const validScores = compositeScores.filter(s => !isNaN(s) && isFinite(s))
                if (validScores.length === 0) return null

                const minScore = Math.min(...validScores)
                const maxScore = Math.max(...validScores)
                const scorePadding = (maxScore - minScore) * 0.1
                const scoreYMin = Math.floor((minScore - scorePadding) / 5) * 5
                const scoreYMax = Math.ceil((maxScore + scorePadding) / 5) * 5

                const spyPrices = filteredHistory.map((d) => d.spy_price)
                const validSpyPrices = spyPrices.filter((p): p is number => p !== null)
                const hasSpyData = validSpyPrices.length > 0

                const spyMin = hasSpyData ? Math.min(...validSpyPrices) : 0
                const spyMax = hasSpyData ? Math.max(...validSpyPrices) : 100
                const spyPadding = (spyMax - spyMin) * 0.1
                const spyYMin = Math.floor((spyMin - spyPadding) / 10) * 10
                const spyYMax = Math.ceil((spyMax + spyPadding) / 10) * 10

                const periodLabels = { '1y': '1년', '3y': '3년', '5y': '5년', '10y': '10년', 'all': '전체' }

                const stanceRanges: { stance: InvestmentStance; label: string; min: number; max: number; color: string }[] = [
                  { stance: 'aggressive_plus', label: '매수 적기', min: 90, max: 101, color: '#059669' },
                  { stance: 'aggressive', label: '매수 우위', min: 75, max: 90, color: '#16a34a' },
                  { stance: 'moderate_aggressive', label: '소폭 매수', min: 60, max: 75, color: '#22c55e' },
                  { stance: 'neutral', label: '중립', min: 40, max: 60, color: '#f59e0b' },
                  { stance: 'moderate_defensive', label: '소폭 방어', min: 20, max: 40, color: '#f97316' },
                  { stance: 'defensive', label: '방어 우위', min: 0, max: 20, color: '#ef4444' },
                ]

                return (
                  <div className="market-history-chart">
                    <div className="market-chart-header">
                      <h3 className="market-chart-title">투자 매력도 vs S&P500 추이</h3>
                      <div className="market-period-selector">
                        {(['1y', '3y', '5y', '10y', 'all'] as const).map((period) => (
                          <button
                            key={period}
                            className={`market-period-btn ${chartPeriod === period ? 'active' : ''}`}
                            onClick={() => setChartPeriod(period)}
                          >
                            {periodLabels[period]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="market-stance-filter">
                      <button
                        className={`market-stance-btn ${highlightStance === null ? 'active' : ''}`}
                        onClick={() => setHighlightStance(null)}
                      >
                        전체
                      </button>
                      {stanceRanges.map(({ stance, label, color }) => (
                        <button
                          key={stance}
                          className={`market-stance-btn ${highlightStance === stance ? 'active' : ''}`}
                          style={{
                            '--stance-color': color,
                            borderColor: highlightStance === stance ? color : undefined,
                            background: highlightStance === stance ? `${color}15` : undefined,
                          } as React.CSSProperties}
                          onClick={() => setHighlightStance(highlightStance === stance ? null : stance)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="market-chart-range">
                      매력도: {Math.round(minScore)} ~ {Math.round(maxScore)}점
                      {hasSpyData && ` | S&P500: $${Math.round(spyMin)} ~ $${Math.round(spyMax)}`}
                    </p>
                    <div className="market-chart-container">
                      {(() => {
                        const selectedRange = highlightStance
                          ? stanceRanges.find(r => r.stance === highlightStance)
                          : null

                        const pointColors = selectedRange
                          ? compositeScores.map(score =>
                              score >= selectedRange.min && score < selectedRange.max
                                ? selectedRange.color
                                : 'transparent'
                            )
                          : compositeScores.map(() => 'transparent')

                        const pointRadii = selectedRange
                          ? compositeScores.map(score =>
                              score >= selectedRange.min && score < selectedRange.max ? 3 : 0
                            )
                          : compositeScores.map(() => 0)

                        return (
                          <Line
                            data={{
                              labels: filteredHistory.map(d => d.date),
                              datasets: [
                                {
                                  label: '투자 매력도',
                                  data: compositeScores,
                                  borderColor: '#3b82f6',
                                  backgroundColor: '#3b82f620',
                                  borderWidth: 2,
                                  fill: false,
                                  tension: 0.3,
                                  pointRadius: pointRadii,
                                  pointBackgroundColor: pointColors,
                                  pointBorderColor: pointColors,
                                  yAxisID: 'y',
                                },
                                ...(hasSpyData ? [{
                                  label: 'S&P500',
                                  data: spyPrices,
                                  borderColor: '#94a3b8',
                                  backgroundColor: 'transparent',
                                  borderWidth: 1.5,
                                  borderDash: [5, 5],
                                  fill: false,
                                  tension: 0.3,
                                  pointRadius: 0,
                                  yAxisID: 'y1',
                                }] : []),
                              ],
                            }}
                            options={{
                              responsive: true,
                              maintainAspectRatio: false,
                              interaction: {
                                mode: 'index',
                                intersect: false,
                              },
                              plugins: {
                                legend: {
                                  display: true,
                                  position: 'top',
                                  labels: { font: { size: 11 }, boxWidth: 12 },
                                },
                                tooltip: {
                                  callbacks: {
                                    label: (context) => {
                                      const label = context.dataset.label || ''
                                      const value = context.parsed.y
                                      if (value === null || value === undefined) return ''
                                      if (label === '투자 매력도') {
                                        return `${label}: ${value.toFixed(1)}점`
                                      }
                                      return `${label}: $${value.toFixed(2)}`
                                    },
                                  },
                                },
                              },
                              scales: {
                                x: {
                                  ticks: {
                                    maxTicksLimit: 12,
                                    font: { size: 10 },
                                  },
                                  grid: { display: false },
                                },
                                y: {
                                  type: 'linear',
                                  display: true,
                                  position: 'left',
                                  min: scoreYMin,
                                  max: scoreYMax,
                                  title: {
                                    display: true,
                                    text: '매력도',
                                    font: { size: 10 },
                                  },
                                  ticks: { font: { size: 10 } },
                                  grid: { color: '#f1f5f9' },
                                },
                                ...(hasSpyData ? {
                                  y1: {
                                    type: 'linear' as const,
                                    display: true,
                                    position: 'right' as const,
                                    min: spyYMin,
                                    max: spyYMax,
                                    title: {
                                      display: true,
                                      text: 'S&P500',
                                      font: { size: 10 },
                                    },
                                    ticks: { font: { size: 10 } },
                                    grid: { drawOnChartArea: false },
                                  },
                                } : {}),
                              },
                            }}
                          />
                        )
                      })()}
                    </div>
                  </div>
                )
              })()}

              {/* 지표별 상세 - 참고 지표 (Timing Score는 SPY drawdown 단일 산출, 별도 표시 불필요) */}
              <div className="market-indicators">
                {/* 핵심 지표 섹션은 새 구조에서 의미 없음 — 모든 11개 지표를 참고로 통합 */}
                <div className="market-category" style={{ display: 'none' }}>
                  <div className="market-category-header">
                    <h3 className="market-category-title">핵심 지표</h3>
                    <span className="market-category-subtitle"></span>
                  </div>
                  <div className="market-category-items">
                    {coreIndicators
                      .sort((a, b) => (indicatorWeightsDisplay[b.name] || 0) - (indicatorWeightsDisplay[a.name] || 0))
                      .map((item) => {
                        const scoreColor = item.score >= 60 ? '#22c55e' : item.score >= 40 ? '#f59e0b' : '#ef4444'
                        const rangePosition = ((item.rawValue - item.min) / (item.max - item.min)) * 100
                        const clampedPosition = Math.max(0, Math.min(100, rangePosition))
                        const isExpanded = expandedIndicator === item.name
                        const historyField = indicatorToHistoryField[item.name]
                        const weight = indicatorWeightsDisplay[item.name] || 0

                        const indicatorHistory = historyField ? marketHistory
                          .filter(h => h[historyField] !== null)
                          .map(h => ({
                            date: h.date,
                            value: h[historyField] as number,
                          })) : []

                        return (
                          <div key={item.name} className={`market-indicator-row ${isExpanded ? 'expanded' : ''}`}>
                            <div
                              className="market-indicator-header"
                              onClick={() => setExpandedIndicator(isExpanded ? null : item.name)}
                              style={{ cursor: 'pointer' }}
                            >
                              <span className="market-indicator-name">
                                <span className="market-indicator-toggle">{isExpanded ? '-' : '+'}</span>
                                {item.name} ({indicatorKoreanName[item.name]})
                                <span className="market-indicator-weight">{weight.toFixed(1)}%</span>
                              </span>
                              <span className="market-indicator-score" style={{ color: scoreColor }}>{Math.round(item.score)}점</span>
                            </div>
                            <div className="market-indicator-progress">
                              <div className="market-indicator-bar">
                                <div
                                  className="market-indicator-fill"
                                  style={{
                                    width: `${clampedPosition}%`,
                                    backgroundColor: scoreColor,
                                  }}
                                />
                                <span
                                  className="market-indicator-marker"
                                  style={{ left: `${clampedPosition}%` }}
                                >
                                  {item.value}
                                </span>
                              </div>
                            </div>
                            <div className="market-indicator-meta">
                              <span className="market-indicator-range">{item.range}</span>
                              <span className="market-indicator-desc">{item.description}</span>
                            </div>

                            {isExpanded && indicatorHistory.length > 0 && (() => {
                              const values = indicatorHistory.map(h => h.value)
                              const minVal = Math.min(...values)
                              const maxVal = Math.max(...values)
                              const padding = (maxVal - minVal) * 0.1 || 1
                              const yMin = item.name === 'Fear & Greed' ? Math.max(0, minVal - padding) : minVal - padding
                              const yMax = item.name === 'Fear & Greed' ? Math.min(100, maxVal + padding) : maxVal + padding

                              return (
                                <div className="market-indicator-chart">
                                  <Line
                                    data={{
                                      labels: indicatorHistory.map(h => {
                                        const d = new Date(h.date)
                                        return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`
                                      }),
                                      datasets: [{
                                        label: item.name,
                                        data: values,
                                        borderColor: scoreColor,
                                        backgroundColor: `${scoreColor}20`,
                                        fill: true,
                                        tension: 0.3,
                                        pointRadius: 0,
                                        pointHoverRadius: 4,
                                      }],
                                    }}
                                    options={{
                                      responsive: true,
                                      maintainAspectRatio: false,
                                      plugins: {
                                        legend: { display: false },
                                        tooltip: {
                                          callbacks: {
                                            title: (items) => {
                                              const idx = items[0].dataIndex
                                              return indicatorHistory[idx]?.date || ''
                                            },
                                            label: (context) => {
                                              const val = context.parsed.y
                                              if (val === null || val === undefined) return ''
                                              if (item.name === 'Initial Claims') {
                                                return `${(val / 1000).toFixed(0)}K`
                                              }
                                              return val.toFixed(2)
                                            },
                                          },
                                        },
                                      },
                                      scales: {
                                        x: {
                                          ticks: { maxTicksLimit: 8, font: { size: 9 } },
                                          grid: { display: false },
                                        },
                                        y: {
                                          min: yMin,
                                          max: yMax,
                                          ticks: { font: { size: 9 } },
                                          grid: { color: '#f1f5f9' },
                                        },
                                      },
                                    }}
                                  />
                                </div>
                              )
                            })()}
                          </div>
                        )
                      })}
                  </div>
                </div>

                {/* 참고 지표 (점수에 미반영) */}
                <div className="market-category market-category-ref">
                  <div className="market-category-header">
                    <h3 className="market-category-title">참고 지표</h3>
                    <span className="market-category-subtitle">점수에 미반영 (음수/무상관)</span>
                  </div>
                  <div className="market-category-items">
                    {refIndicators.map((item) => {
                      const grayColor = '#94a3b8'
                      const activeColor = item.score >= 60 ? '#22c55e' : item.score >= 40 ? '#f59e0b' : '#ef4444'
                      const rangePosition = ((item.rawValue - item.min) / (item.max - item.min)) * 100
                      const clampedPosition = Math.max(0, Math.min(100, rangePosition))
                      const isExpanded = expandedIndicator === item.name
                      const historyField = indicatorToHistoryField[item.name]
                      const displayColor = isExpanded ? activeColor : grayColor

                      const indicatorHistory = historyField ? marketHistory
                        .filter(h => h[historyField] !== null)
                        .map(h => ({
                          date: h.date,
                          value: h[historyField] as number,
                        })) : []

                      return (
                        <div key={item.name} className={`market-indicator-row market-indicator-ref ${isExpanded ? 'expanded' : ''}`}>
                          <div
                            className="market-indicator-header"
                            onClick={() => setExpandedIndicator(isExpanded ? null : item.name)}
                            style={{ cursor: 'pointer' }}
                          >
                            <span className="market-indicator-name">
                              <span className="market-indicator-toggle">{isExpanded ? '-' : '+'}</span>
                              {item.name} ({indicatorKoreanName[item.name]})
                            </span>
                            <span className="market-indicator-score" style={{ color: displayColor }}>{Math.round(item.score)}점</span>
                          </div>
                          <div className="market-indicator-progress">
                            <div className="market-indicator-bar">
                              <div
                                className="market-indicator-fill"
                                style={{
                                  width: `${clampedPosition}%`,
                                  backgroundColor: displayColor,
                                }}
                              />
                              <span
                                className="market-indicator-marker"
                                style={{ left: `${clampedPosition}%` }}
                              >
                                {item.value}
                              </span>
                            </div>
                          </div>
                          <div className="market-indicator-meta">
                            <span className="market-indicator-range">{item.range}</span>
                            <span className="market-indicator-desc">{item.description}</span>
                          </div>

                          {isExpanded && indicatorHistory.length > 0 && (() => {
                            const values = indicatorHistory.map(h => h.value)
                            const minVal = Math.min(...values)
                            const maxVal = Math.max(...values)
                            const padding = (maxVal - minVal) * 0.1 || 1
                            const yMin = minVal - padding
                            const yMax = maxVal + padding

                            return (
                              <div className="market-indicator-chart">
                                <Line
                                  data={{
                                    labels: indicatorHistory.map(h => {
                                      const d = new Date(h.date)
                                      return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`
                                    }),
                                    datasets: [{
                                      label: item.name,
                                      data: values,
                                      borderColor: displayColor,
                                      backgroundColor: `${displayColor}20`,
                                      fill: true,
                                      tension: 0.3,
                                      pointRadius: 0,
                                      pointHoverRadius: 4,
                                    }],
                                  }}
                                  options={{
                                    responsive: true,
                                    maintainAspectRatio: false,
                                    plugins: {
                                      legend: { display: false },
                                      tooltip: {
                                        callbacks: {
                                          title: (items) => {
                                            const idx = items[0].dataIndex
                                            return indicatorHistory[idx]?.date || ''
                                          },
                                          label: (context) => {
                                            const val = context.parsed.y
                                            if (val === null || val === undefined) return ''
                                            if (item.name === 'Initial Claims') {
                                              return `${(val / 1000).toFixed(0)}K`
                                            }
                                            return val.toFixed(2)
                                          },
                                        },
                                      },
                                    },
                                    scales: {
                                      x: {
                                        ticks: { maxTicksLimit: 8, font: { size: 9 } },
                                        grid: { display: false },
                                      },
                                      y: {
                                        min: yMin,
                                        max: yMax,
                                        ticks: { font: { size: 9 } },
                                        grid: { color: '#f1f5f9' },
                                      },
                                    },
                                  }}
                                />
                              </div>
                            )
                          })()}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

                </>
              )}

              {/* 투자 타이밍 지표 탭 - 선행/동행/후행 통합 */}
              {activeTab === 'timing' && (
                <div className="market-timing-dashboard">
                  <div className="market-timing-header">
                    <h2 className="market-timing-title">투자 타이밍 지표</h2>
                    <p className="market-timing-desc">선행, 동행, 후행 지표를 통한 시장 타이밍 분석</p>
                  </div>
                  <div className="chart-period-selector">
                    {(['1y', '3y', '5y', '10y', 'all'] as const).map(period => (
                      <button
                        key={period}
                        className={`period-btn ${chartPeriod === period ? 'active' : ''}`}
                        onClick={() => setChartPeriod(period)}
                      >
                        {period === '1y' ? '1년' : period === '3y' ? '3년' : period === '5y' ? '5년' : period === '10y' ? '10년' : '전체'}
                      </button>
                    ))}
                  </div>
                  {/* 선행 지표 섹션 */}
                  <div className="market-timing-header">
                    <h2 className="market-timing-title">선행 지표</h2>
                    <p className="market-timing-desc">미래 경기와 시장 방향을 예측하는 지표들</p>
                  </div>
                  <div className="global-indices-grid">
                    {getIndicatorsByTiming('leading').map((item) => {
                      const scoreColor = item.score >= 60 ? '#22c55e' : item.score >= 40 ? '#f59e0b' : '#ef4444'
                      const historyField = indicatorToHistoryField[item.name]
                      const indicatorHistory = historyField ? marketHistory
                        .filter(h => h[historyField] !== null && new Date(h.date) >= chartCutoffDate)
                        .map(h => ({
                          date: h.date,
                          value: h[historyField] as number,
                        })) : []
                      const isExpanded = expandedMacroCard === `timing-${item.name}`

                      return (
                        <div
                          key={item.name}
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : `timing-${item.name}`)}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">{item.name}</span>
                            <span className="global-index-region">{indicatorKoreanName[item.name]}</span>
                          </div>
                          <div className="global-index-price">
                            {item.value}
                          </div>
                          <p className="global-index-desc">{indicatorMeaning[item.name]}</p>
                          {indicatorHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: indicatorHistory.map(h => h.date),
                                  datasets: [{
                                    data: indicatorHistory.map(h => h.value),
                                    borderColor: scoreColor,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${scoreColor}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* 동행 지표 섹션 */}
                  <div className="market-timing-header" style={{ marginTop: '32px' }}>
                    <h2 className="market-timing-title">동행 지표</h2>
                    <p className="market-timing-desc">현재 시장 상황을 실시간으로 반영하는 지표들</p>
                  </div>
                  <div className="global-indices-grid">
                    {getIndicatorsByTiming('coincident').map((item) => {
                      const scoreColor = item.score >= 60 ? '#22c55e' : item.score >= 40 ? '#f59e0b' : '#ef4444'
                      const historyField = indicatorToHistoryField[item.name]
                      const indicatorHistory = historyField ? marketHistory
                        .filter(h => h[historyField] !== null && new Date(h.date) >= chartCutoffDate)
                        .map(h => ({
                          date: h.date,
                          value: h[historyField] as number,
                        })) : []
                      const isExpanded = expandedMacroCard === `timing-${item.name}`

                      return (
                        <div
                          key={item.name}
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : `timing-${item.name}`)}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">{item.name}</span>
                            <span className="global-index-region">{indicatorKoreanName[item.name]}</span>
                          </div>
                          <div className="global-index-price">
                            {item.value}
                          </div>
                          <p className="global-index-desc">{indicatorMeaning[item.name]}</p>
                          {indicatorHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: indicatorHistory.map(h => h.date),
                                  datasets: [{
                                    data: indicatorHistory.map(h => h.value),
                                    borderColor: scoreColor,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${scoreColor}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* 후행 지표 섹션 */}
                  <div className="market-timing-header" style={{ marginTop: '32px' }}>
                    <h2 className="market-timing-title">후행 지표</h2>
                    <p className="market-timing-desc">시장 추세를 확인하고 검증하는 지표들</p>
                  </div>
                  <div className="global-indices-grid">
                    {getIndicatorsByTiming('lagging').map((item) => {
                      const scoreColor = item.score >= 60 ? '#22c55e' : item.score >= 40 ? '#f59e0b' : '#ef4444'
                      const historyField = indicatorToHistoryField[item.name]
                      const indicatorHistory = historyField ? marketHistory
                        .filter(h => h[historyField] !== null && new Date(h.date) >= chartCutoffDate)
                        .map(h => ({
                          date: h.date,
                          value: h[historyField] as number,
                        })) : []
                      const isExpanded = expandedMacroCard === `timing-${item.name}`

                      return (
                        <div
                          key={item.name}
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : `timing-${item.name}`)}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">{item.name}</span>
                            <span className="global-index-region">{indicatorKoreanName[item.name]}</span>
                          </div>
                          <div className="global-index-price">
                            {item.value}
                          </div>
                          <p className="global-index-desc">{indicatorMeaning[item.name]}</p>
                          {indicatorHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: indicatorHistory.map(h => h.date),
                                  datasets: [{
                                    data: indicatorHistory.map(h => h.value),
                                    borderColor: scoreColor,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${scoreColor}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* 매크로 지표 탭 - 성장/물가/고용/통화정책 통합 */}
              {activeTab === 'macro' && (
                <div className="market-timing-dashboard">
                  <div className="market-timing-header">
                    <h2 className="market-timing-title">매크로 지표</h2>
                    <p className="market-timing-desc">성장, 물가, 고용, 통화정책 등 거시경제 지표</p>
                  </div>
                  <div className="chart-period-selector">
                    {(['1y', '3y', '5y', '10y', 'all'] as const).map(period => (
                      <button
                        key={period}
                        className={`period-btn ${chartPeriod === period ? 'active' : ''}`}
                        onClick={() => setChartPeriod(period)}
                      >
                        {period === '1y' ? '1년' : period === '3y' ? '3년' : period === '5y' ? '5년' : period === '10y' ? '10년' : '전체'}
                      </button>
                    ))}
                  </div>
                  {/* 성장 지표 섹션 */}
                  <div className="market-timing-header">
                    <h2 className="market-timing-title">성장 지표</h2>
                    <p className="market-timing-desc">경제의 기초 체력을 보여주는 지표들</p>
                  </div>
                  <div className="global-indices-grid">
                    {/* GDP 성장률 */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const gdpHistory = marketHistory.filter(h => h.gdp_growth_qoq !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'gdp'
                      const color = (latestData?.gdp_growth_qoq ?? 0) >= 2 ? '#22c55e' : (latestData?.gdp_growth_qoq ?? 0) >= 0 ? '#f59e0b' : '#ef4444'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'gdp')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">GDP Growth (QoQ)</span>
                            <span className="global-index-region">GDP 성장률</span>
                          </div>
                          <div className="global-index-price" style={{ color }}>
                            {latestData?.gdp_growth_qoq != null ? `${latestData.gdp_growth_qoq.toFixed(1)}%` : 'N/A'}
                          </div>
                          <p className="global-index-desc">분기별 연율화 GDP 성장률. 2% 이상이면 건강한 성장</p>
                          {gdpHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: gdpHistory.map(h => h.date),
                                  datasets: [{
                                    data: gdpHistory.map(h => h.gdp_growth_qoq),
                                    borderColor: color,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${color}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* ISM 제조업 */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const ismHistory = marketHistory.filter(h => h.ism_manufacturing !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'ism'
                      const color = '#6366f1'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'ism')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">Manufacturing Employment</span>
                            <span className="global-index-region">제조업 고용</span>
                          </div>
                          <div className="global-index-price" style={{ color }}>
                            {latestData?.ism_manufacturing != null ? `${(latestData.ism_manufacturing / 1000).toFixed(1)}M` : 'N/A'}
                          </div>
                          <p className="global-index-desc">제조업 부문 고용자 수 (백만명)</p>
                          {ismHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: ismHistory.map(h => h.date),
                                  datasets: [{
                                    data: ismHistory.map(h => h.ism_manufacturing),
                                    borderColor: color,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${color}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* 소매 판매 YoY */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const retailHistory = marketHistory.filter(h => h.retail_sales_yoy !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'retail'
                      const color = (latestData?.retail_sales_yoy ?? 0) >= 3 ? '#22c55e' : (latestData?.retail_sales_yoy ?? 0) >= 0 ? '#f59e0b' : '#ef4444'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'retail')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">Retail Sales YoY</span>
                            <span className="global-index-region">소매 판매</span>
                          </div>
                          <div className="global-index-price" style={{ color }}>
                            {latestData?.retail_sales_yoy != null ? `${latestData.retail_sales_yoy.toFixed(1)}%` : 'N/A'}
                          </div>
                          <p className="global-index-desc">미국 경제의 70%를 차지하는 소비의 건전성 지표</p>
                          {retailHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: retailHistory.map(h => h.date),
                                  datasets: [{
                                    data: retailHistory.map(h => h.retail_sales_yoy),
                                    borderColor: color,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${color}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>

                  {/* 물가 지표 섹션 */}
                  <div className="market-timing-header" style={{ marginTop: '32px' }}>
                    <h2 className="market-timing-title">물가 지표</h2>
                    <p className="market-timing-desc">중앙은행이 금리를 결정할 때 주시하는 데이터</p>
                  </div>
                  <div className="global-indices-grid">
                    {/* CPI YoY */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const cpiHistory = marketHistory.filter(h => h.cpi_yoy !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'cpi'
                      const value = latestData?.cpi_yoy ?? 0
                      const color = value <= 2 ? '#22c55e' : value <= 4 ? '#f59e0b' : '#ef4444'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'cpi')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">CPI YoY</span>
                            <span className="global-index-region">소비자물가지수</span>
                          </div>
                          <div className="global-index-price" style={{ color }}>
                            {latestData?.cpi_yoy != null ? `${latestData.cpi_yoy.toFixed(1)}%` : 'N/A'}
                          </div>
                          <p className="global-index-desc">소비자가 체감하는 물가. 시장이 가장 민감하게 반응</p>
                          {cpiHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: cpiHistory.map(h => h.date),
                                  datasets: [{
                                    data: cpiHistory.map(h => h.cpi_yoy),
                                    borderColor: color,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${color}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Core CPI YoY */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const coreCpiHistory = marketHistory.filter(h => h.core_cpi_yoy !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'coreCpi'
                      const value = latestData?.core_cpi_yoy ?? 0
                      const color = value <= 2 ? '#22c55e' : value <= 4 ? '#f59e0b' : '#ef4444'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'coreCpi')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">Core CPI YoY</span>
                            <span className="global-index-region">근원 소비자물가</span>
                          </div>
                          <div className="global-index-price" style={{ color }}>
                            {latestData?.core_cpi_yoy != null ? `${latestData.core_cpi_yoy.toFixed(1)}%` : 'N/A'}
                          </div>
                          <p className="global-index-desc">식품/에너지 제외. 기조적 인플레 판단에 핵심</p>
                          {coreCpiHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: coreCpiHistory.map(h => h.date),
                                  datasets: [{
                                    data: coreCpiHistory.map(h => h.core_cpi_yoy),
                                    borderColor: color,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${color}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Core PCE YoY */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const pceHistory = marketHistory.filter(h => h.core_pce_yoy !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'corePce'
                      const value = latestData?.core_pce_yoy ?? 0
                      const color = value <= 2 ? '#22c55e' : value <= 3 ? '#f59e0b' : '#ef4444'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'corePce')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">Core PCE YoY</span>
                            <span className="global-index-region">근원 개인소비지출</span>
                          </div>
                          <div className="global-index-price" style={{ color }}>
                            {latestData?.core_pce_yoy != null ? `${latestData.core_pce_yoy.toFixed(1)}%` : 'N/A'}
                          </div>
                          <p className="global-index-desc">연준의 공식 물가 목표치(2%) 산정 기준 지표</p>
                          {pceHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: pceHistory.map(h => h.date),
                                  datasets: [{
                                    data: pceHistory.map(h => h.core_pce_yoy),
                                    borderColor: color,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${color}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* PPI YoY */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const ppiHistory = marketHistory.filter(h => h.ppi_yoy !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'ppi'
                      const value = latestData?.ppi_yoy ?? 0
                      const color = value <= 2 ? '#22c55e' : value <= 5 ? '#f59e0b' : '#ef4444'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'ppi')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">PPI YoY</span>
                            <span className="global-index-region">생산자물가지수</span>
                          </div>
                          <div className="global-index-price" style={{ color }}>
                            {latestData?.ppi_yoy != null ? `${latestData.ppi_yoy.toFixed(1)}%` : 'N/A'}
                          </div>
                          <p className="global-index-desc">기업의 비용 부담. CPI의 선행 지표 역할</p>
                          {ppiHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: ppiHistory.map(h => h.date),
                                  datasets: [{
                                    data: ppiHistory.map(h => h.ppi_yoy),
                                    borderColor: color,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${color}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>

                  {/* 고용 지표 섹션 */}
                  <div className="market-timing-header" style={{ marginTop: '32px' }}>
                    <h2 className="market-timing-title">고용 지표</h2>
                    <p className="market-timing-desc">경기 침체의 결정적 증거를 보여주는 지표들</p>
                  </div>
                  <div className="global-indices-grid">
                    {/* 비농업 고용 MoM */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const payrollsHistory = marketHistory.filter(h => h.nonfarm_payrolls_mom !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'payrolls'
                      const value = latestData?.nonfarm_payrolls_mom ?? 0
                      const color = value >= 150000 ? '#22c55e' : value >= 0 ? '#f59e0b' : '#ef4444'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'payrolls')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">Non-farm Payrolls</span>
                            <span className="global-index-region">비농업 고용자 수</span>
                          </div>
                          <div className="global-index-price" style={{ color }}>
                            {latestData?.nonfarm_payrolls_mom != null ? `${latestData.nonfarm_payrolls_mom > 0 ? '+' : ''}${(latestData.nonfarm_payrolls_mom / 1000).toFixed(0)}K` : 'N/A'}
                          </div>
                          <p className="global-index-desc">월간 고용 변화. 시장에 가장 큰 충격을 주는 지표</p>
                          {payrollsHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: payrollsHistory.map(h => h.date),
                                  datasets: [{
                                    data: payrollsHistory.map(h => h.nonfarm_payrolls_mom),
                                    borderColor: '#6366f1',
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: '#6366f115',
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* 실업률 */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const unemploymentHistory = marketHistory.filter(h => h.unemployment_rate !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'unemployment'
                      const value = latestData?.unemployment_rate ?? 0
                      const color = value <= 4 ? '#22c55e' : value <= 6 ? '#f59e0b' : '#ef4444'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'unemployment')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">Unemployment Rate</span>
                            <span className="global-index-region">실업률</span>
                          </div>
                          <div className="global-index-price" style={{ color }}>
                            {latestData?.unemployment_rate !== null ? `${latestData.unemployment_rate?.toFixed(1)}%` : 'N/A'}
                          </div>
                          <p className="global-index-desc">노동 시장의 수급 불균형 파악. 4% 이하가 완전고용</p>
                          {unemploymentHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: unemploymentHistory.map(h => h.date),
                                  datasets: [{
                                    data: unemploymentHistory.map(h => h.unemployment_rate),
                                    borderColor: color,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${color}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* 경제활동참가율 */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const laborHistory = marketHistory.filter(h => h.labor_participation !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'labor'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'labor')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">Labor Participation</span>
                            <span className="global-index-region">경제활동참가율</span>
                          </div>
                          <div className="global-index-price" style={{ color: '#6366f1' }}>
                            {latestData?.labor_participation !== null ? `${latestData.labor_participation?.toFixed(1)}%` : 'N/A'}
                          </div>
                          <p className="global-index-desc">노동시장 참여 의지. 실업률과 함께 분석 필요</p>
                          {laborHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: laborHistory.map(h => h.date),
                                  datasets: [{
                                    data: laborHistory.map(h => h.labor_participation),
                                    borderColor: '#6366f1',
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: '#6366f115',
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* 신규 실업수당 청구 */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const claimsHistory = marketHistory.filter(h => h.initial_claims !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'claims'
                      const value = latestData?.initial_claims ?? 0
                      const color = value <= 250000 ? '#22c55e' : value <= 350000 ? '#f59e0b' : '#ef4444'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'claims')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">Initial Claims</span>
                            <span className="global-index-region">신규 실업수당 청구</span>
                          </div>
                          <div className="global-index-price" style={{ color }}>
                            {latestData?.initial_claims !== null ? `${(latestData.initial_claims / 1000).toFixed(0)}K` : 'N/A'}
                          </div>
                          <p className="global-index-desc">매주 발표. 고용 시장의 균열을 가장 빠르게 포착</p>
                          {claimsHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: claimsHistory.map(h => h.date),
                                  datasets: [{
                                    data: claimsHistory.map(h => h.initial_claims),
                                    borderColor: color,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${color}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>

                  {/* 통화정책 지표 섹션 */}
                  <div className="market-timing-header" style={{ marginTop: '32px' }}>
                    <h2 className="market-timing-title">통화정책 지표</h2>
                    <p className="market-timing-desc">금리와 통화 흐름을 보여주는 가격 지표</p>
                  </div>
                  <div className="global-indices-grid">
                    {/* 10년물 금리 */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const t10yHistory = marketHistory.filter(h => h.treasury_10y !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 't10y'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 't10y')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">10Y Treasury</span>
                            <span className="global-index-region">10년물 국채 금리</span>
                          </div>
                          <div className="global-index-price" style={{ color: '#6366f1' }}>
                            {latestData?.treasury_10y !== null ? `${latestData.treasury_10y?.toFixed(2)}%` : 'N/A'}
                          </div>
                          <p className="global-index-desc">장기 성장/물가 전망을 반영. 모기지 금리의 기준</p>
                          {t10yHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: t10yHistory.map(h => h.date),
                                  datasets: [{
                                    data: t10yHistory.map(h => h.treasury_10y),
                                    borderColor: '#6366f1',
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: '#6366f115',
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* 2년물 금리 */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const t2yHistory = marketHistory.filter(h => h.treasury_2y !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 't2y'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 't2y')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">2Y Treasury</span>
                            <span className="global-index-region">2년물 국채 금리</span>
                          </div>
                          <div className="global-index-price" style={{ color: '#6366f1' }}>
                            {latestData?.treasury_2y !== null ? `${latestData.treasury_2y?.toFixed(2)}%` : 'N/A'}
                          </div>
                          <p className="global-index-desc">통화정책에 가장 민감. 연준 금리 인상 기대 반영</p>
                          {t2yHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: t2yHistory.map(h => h.date),
                                  datasets: [{
                                    data: t2yHistory.map(h => h.treasury_2y),
                                    borderColor: '#6366f1',
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: '#6366f115',
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* 장단기 금리차 10Y-2Y */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const spreadHistory = marketHistory.filter(h => h.yield_curve_10y2y !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'yieldcurve'
                      const value = latestData?.yield_curve_10y2y ?? 0
                      const color = value >= 0 ? '#22c55e' : '#ef4444'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'yieldcurve')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">Yield Curve 10Y-2Y</span>
                            <span className="global-index-region">장단기 금리차</span>
                          </div>
                          <div className="global-index-price" style={{ color }}>
                            {latestData?.yield_curve_10y2y !== null ? `${latestData.yield_curve_10y2y?.toFixed(2)}%` : 'N/A'}
                          </div>
                          <p className="global-index-desc">역전(음수) 시 경기 침체의 강력한 신호</p>
                          {spreadHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: spreadHistory.map(h => h.date),
                                  datasets: [{
                                    data: spreadHistory.map(h => h.yield_curve_10y2y),
                                    borderColor: color,
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: `${color}15`,
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* 달러 인덱스 */}
                    {(() => {
                      const latestData = marketHistory[marketHistory.length - 1]
                      const dxyHistory = marketHistory.filter(h => h.dollar_index !== null && new Date(h.date) >= chartCutoffDate)
                      const isExpanded = expandedMacroCard === 'dxy'
                      return (
                        <div
                          className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedMacroCard(isExpanded ? null : 'dxy')}
                        >
                          <div className="global-index-header">
                            <span className="global-index-name">Dollar Index (DXY)</span>
                            <span className="global-index-region">달러 인덱스</span>
                          </div>
                          <div className="global-index-price" style={{ color: '#6366f1' }}>
                            {latestData?.dollar_index !== null ? latestData.dollar_index?.toFixed(1) : 'N/A'}
                          </div>
                          <p className="global-index-desc">글로벌 자금 흐름. 강세 시 신흥국 자산에 하방 압력</p>
                          {dxyHistory.length > 0 && (
                            <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                              <Line
                                data={{
                                  labels: dxyHistory.map(h => h.date),
                                  datasets: [{
                                    data: dxyHistory.map(h => h.dollar_index),
                                    borderColor: '#6366f1',
                                    borderWidth: isExpanded ? 2 : 1.5,
                                    backgroundColor: '#6366f115',
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: isExpanded ? 2 : 0,
                                  }],
                                }}
                                options={{
                                  responsive: true,
                                  maintainAspectRatio: false,
                                  interaction: { mode: 'index', intersect: false },
                                  plugins: { legend: { display: false } },
                                  scales: {
                                    x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                    y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                  },
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>
              )}

              {activeTab === 'kr-macro' && (() => {
                if (marketHistory.length === 0) return null

                // 가장 최근 valid 값 찾기 (월간 지표는 발표 lag 때문에 latest record에 없을 수 있음)
                const latestValid = <K extends keyof MarketHistoryRecord>(field: K): { value: number | null; date: string } => {
                  for (let i = marketHistory.length - 1; i >= 0; i--) {
                    const v = marketHistory[i][field]
                    if (v !== null && v !== undefined && Number.isFinite(v as number)) {
                      return { value: v as number, date: marketHistory[i].date }
                    }
                  }
                  return { value: null, date: '' }
                }

                // YoY: 가장 최근 valid 값 기준 52주 전 동일 필드 값 대비 변화율
                const yoyForField = (field: keyof MarketHistoryRecord): number | null => {
                  // 가장 최근 valid record의 index 찾기
                  let curIdx = -1
                  for (let i = marketHistory.length - 1; i >= 0; i--) {
                    const v = marketHistory[i][field]
                    if (v !== null && v !== undefined && Number.isFinite(v as number)) { curIdx = i; break }
                  }
                  if (curIdx < 52) return null
                  const cur = marketHistory[curIdx][field] as number
                  const old = marketHistory[curIdx - 52][field] as number | null | undefined
                  if (old == null || old === 0) return null
                  return (cur / old - 1) * 100
                }

                interface KRCardConfig {
                  field: keyof MarketHistoryRecord
                  name: string
                  ko: string
                  desc: string
                  format: (v: number) => string
                  colorRule?: (v: number) => string
                  showYoy?: boolean
                  alt?: string  // 부가 정보 (예: 신용스프레드)
                }

                const sections: { title: string; subtitle: string; cards: KRCardConfig[] }[] = [
                  {
                    title: '금리', subtitle: '한국은행 기준금리 및 시장금리',
                    cards: [
                      { field: 'kr_base_rate', name: 'BOK Base Rate', ko: '한국은행 기준금리',
                        desc: '한국은행이 결정하는 정책금리. 경제 전반 금리의 기준',
                        format: v => `${v.toFixed(2)}%`, colorRule: (v: number) => v >= 3 ? '#ef4444' : v >= 2 ? '#f59e0b' : '#22c55e' },
                      { field: 'kr_treasury_10y', name: 'KTB 10Y', ko: '국고채 10년',
                        desc: '장기 국채 수익률. 경기 및 인플레 기대 반영',
                        format: v => `${v.toFixed(2)}%`, colorRule: () => '#6366f1' },
                      { field: 'kr_treasury_3y', name: 'KTB 3Y', ko: '국고채 3년',
                        desc: '중기 국채 수익률. 한은 정책 전망 반영',
                        format: v => `${v.toFixed(2)}%`, colorRule: () => '#6366f1' },
                      { field: 'kr_call_rate', name: 'Call Rate', ko: '콜금리 1일',
                        desc: '은행간 1일 단기자금 금리. 기준금리 근처에서 움직임',
                        format: v => `${v.toFixed(2)}%`, colorRule: () => '#94a3b8' },
                    ],
                  },
                  {
                    title: '신용', subtitle: '회사채 시장 신용 위험',
                    cards: [
                      { field: 'kr_corp_aa_3y', name: 'Corp AA- 3Y', ko: '회사채 AA- 3년',
                        desc: '우량 회사채 수익률. 국고채 대비 신용 프리미엄',
                        format: v => `${v.toFixed(2)}%`, colorRule: () => '#0ea5e9' },
                      { field: 'kr_corp_bbb_3y', name: 'Corp BBB- 3Y', ko: '회사채 BBB- 3년',
                        desc: '투기등급 회사채 수익률. 신용 스트레스 척도',
                        format: v => `${v.toFixed(2)}%`,
                        colorRule: (v: number) => v >= 12 ? '#ef4444' : v >= 8 ? '#f59e0b' : '#0ea5e9' },
                    ],
                  },
                  {
                    title: '물가', subtitle: '소비자/생산자 물가',
                    cards: [
                      { field: 'kr_cpi', name: 'CPI Index', ko: '소비자물가지수',
                        desc: '소비자물가지수 (2020=100). YoY 변화로 인플레율 산출',
                        format: v => v.toFixed(2), showYoy: true,
                        colorRule: () => '#a855f7' },
                      { field: 'kr_ppi', name: 'PPI Index', ko: '생산자물가지수',
                        desc: '생산자물가지수 (2020=100). 소비자물가 선행 신호',
                        format: v => v.toFixed(2), showYoy: true,
                        colorRule: () => '#a855f7' },
                    ],
                  },
                  {
                    title: '외환', subtitle: '환율 및 외환보유고',
                    cards: [
                      { field: 'usd_krw', name: 'USD/KRW', ko: '원/달러 환율',
                        desc: '미국 달러 대비 원화 환율. 한국 자산 가치의 기준',
                        format: v => `₩${v.toFixed(0)}`,
                        colorRule: (v: number) => v >= 1400 ? '#ef4444' : v >= 1300 ? '#f59e0b' : '#22c55e' },
                      { field: 'kr_forex_reserves', name: 'FX Reserves', ko: '외환보유고',
                        desc: '한국이 보유한 외환 (백만달러). 위기 대응 여력',
                        format: v => `$${(v / 1000).toFixed(1)}B`, colorRule: () => '#0ea5e9' },
                    ],
                  },
                  {
                    title: '생산', subtitle: '경제 활동 수준',
                    cards: [
                      { field: 'kr_industrial_production', name: 'Industrial Production', ko: '전산업생산지수',
                        desc: '전산업 생산지수 (2020=100). 광공업+서비스업 포함',
                        format: v => v.toFixed(1), showYoy: true,
                        colorRule: () => '#22c55e' },
                      { field: 'kr_mining_manufacturing', name: 'Mfg Production', ko: '광공업생산지수',
                        desc: '광공업 생산지수. 제조업 경기의 직접 신호',
                        format: v => v.toFixed(1), showYoy: true,
                        colorRule: () => '#22c55e' },
                    ],
                  },
                  {
                    title: '고용', subtitle: '노동시장 상태',
                    cards: [
                      { field: 'kr_employment', name: 'Employed', ko: '취업자수',
                        desc: '취업자 수 (천명). 고용 시장 활력 지표',
                        format: v => `${(v / 1000).toFixed(2)}M`, showYoy: true,
                        colorRule: () => '#22c55e' },
                      { field: 'kr_econ_active_pop', name: 'Labor Force', ko: '경제활동인구',
                        desc: '경제활동인구 (천명). 취업자+실업자',
                        format: v => `${(v / 1000).toFixed(2)}M`,
                        colorRule: () => '#94a3b8' },
                    ],
                  },
                  {
                    title: '무역', subtitle: '국제수지 및 수출입',
                    cards: [
                      { field: 'kr_current_account', name: 'Current Account', ko: '경상수지',
                        desc: '경상수지 (백만달러). 흑자 = 외화 유입',
                        format: v => `$${(v / 1000).toFixed(2)}B`,
                        colorRule: (v: number) => v >= 0 ? '#22c55e' : '#ef4444' },
                      { field: 'kr_trade_balance', name: 'Trade Balance', ko: '상품수지',
                        desc: '상품수지 (백만달러). 수출-수입',
                        format: v => `$${(v / 1000).toFixed(2)}B`,
                        colorRule: (v: number) => v >= 0 ? '#22c55e' : '#ef4444' },
                      { field: 'kr_exports', name: 'Exports', ko: '수출',
                        desc: '월간 상품수출 (백만달러)',
                        format: v => `$${(v / 1000).toFixed(2)}B`, showYoy: true,
                        colorRule: () => '#22c55e' },
                      { field: 'kr_imports', name: 'Imports', ko: '수입',
                        desc: '월간 상품수입 (백만달러)',
                        format: v => `$${(v / 1000).toFixed(2)}B`, showYoy: true,
                        colorRule: () => '#f59e0b' },
                    ],
                  },
                  {
                    title: '심리 및 주식', subtitle: '소비자 심리 + 한국 주식',
                    cards: [
                      { field: 'kr_consumer_sentiment', name: 'Consumer Sentiment', ko: '소비자심리지수',
                        desc: '소비자 현재생활형편 CSI. 100 이상 = 낙관',
                        format: v => v.toFixed(0),
                        colorRule: (v: number) => v >= 100 ? '#22c55e' : v >= 90 ? '#f59e0b' : '#ef4444' },
                      { field: 'kospi_price', name: 'KOSPI', ko: 'KOSPI 종가',
                        desc: '한국 종합주가지수. 대형주 중심',
                        format: v => v.toFixed(2),
                        colorRule: () => '#3b82f6' },
                      { field: 'kosdaq_price', name: 'KOSDAQ', ko: 'KOSDAQ 종가',
                        desc: '코스닥 지수. 중소형 기술주 중심',
                        format: v => v.toFixed(2),
                        colorRule: () => '#8b5cf6' },
                    ],
                  },
                ]

                return (
                  <div className="market-timing-dashboard">
                    <div className="market-timing-header">
                      <h2 className="market-timing-title">한국 매크로 지표</h2>
                      <p className="market-timing-desc">한국은행 ECOS API + KOSPI/KOSDAQ. 금리/물가/외환/생산/고용/무역/심리</p>
                    </div>
                    <div className="chart-period-selector">
                      {(['1y', '3y', '5y', '10y', 'all'] as const).map(period => (
                        <button
                          key={period}
                          className={`period-btn ${chartPeriod === period ? 'active' : ''}`}
                          onClick={() => setChartPeriod(period)}
                        >
                          {period === '1y' ? '1년' : period === '3y' ? '3년' : period === '5y' ? '5년' : period === '10y' ? '10년' : '전체'}
                        </button>
                      ))}
                    </div>

                    {sections.map(section => (
                      <div key={section.title}>
                        <div className="market-timing-header">
                          <h2 className="market-timing-title">{section.title}</h2>
                          <p className="market-timing-desc">{section.subtitle}</p>
                        </div>
                        <div className="global-indices-grid">
                          {section.cards.map(card => {
                            const { value: val, date: valDate } = latestValid(card.field)
                            const yoy = card.showYoy ? yoyForField(card.field) : null
                            const history = marketHistory.filter(h => {
                              const v = h[card.field]
                              return v !== null && v !== undefined && new Date(h.date) >= chartCutoffDate
                            })
                            const cardKey = `kr-${card.field}`
                            const isExpanded = expandedMacroCard === cardKey
                            const color = val != null && card.colorRule ? card.colorRule(val) : '#94a3b8'
                            return (
                              <div
                                key={cardKey}
                                className={`global-index-card ${isExpanded ? 'expanded' : ''}`}
                                onClick={() => setExpandedMacroCard(isExpanded ? null : cardKey)}
                              >
                                <div className="global-index-header">
                                  <span className="global-index-name">{card.name}</span>
                                  <span className="global-index-region">{card.ko}</span>
                                </div>
                                <div className="global-index-price" style={{ color }}>
                                  {val != null ? card.format(val) : 'N/A'}
                                </div>
                                {valDate && (
                                  <div style={{ fontSize: '10px', color: '#94a3b8' }}>as of {valDate}</div>
                                )}
                                {yoy !== null && (
                                  <div style={{ fontSize: '12px', color: yoy >= 0 ? '#22c55e' : '#ef4444', marginTop: '4px' }}>
                                    YoY: {yoy >= 0 ? '+' : ''}{yoy.toFixed(1)}%
                                  </div>
                                )}
                                <p className="global-index-desc">{card.desc}</p>
                                {history.length > 0 && (
                                  <div className={isExpanded ? 'global-detail-chart' : 'global-mini-chart'}>
                                    <Line
                                      data={{
                                        labels: history.map(h => h.date),
                                        datasets: [{
                                          data: history.map(h => h[card.field] as number),
                                          borderColor: color,
                                          borderWidth: isExpanded ? 2 : 1.5,
                                          backgroundColor: `${color}15`,
                                          fill: true,
                                          tension: 0.3,
                                          pointRadius: isExpanded ? 2 : 0,
                                        }],
                                      }}
                                      options={{
                                        responsive: true,
                                        maintainAspectRatio: false,
                                        interaction: { mode: 'index', intersect: false },
                                        plugins: { legend: { display: false } },
                                        scales: {
                                          x: { display: isExpanded, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
                                          y: { display: isExpanded, ticks: { font: { size: 10 } } },
                                        },
                                      }}
                                    />
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })()}

              <div className="market-footer">
                <p>마지막 업데이트: {new Date(selectedMarketData.lastUpdated).toLocaleString('ko-KR')}</p>
                <p className="market-disclaimer">* 본 자료는 참고용이며, 투자 판단의 책임은 본인에게 있습니다.</p>
              </div>
            </>
          )
        })()}
      </div>

      {/* Gemini 채팅 패널 */}
      {selectedMarketData && createPortal(
        <div
          className={`market-chat-panel ${marketChatOpen ? 'open' : ''}`}
          onClick={() => !marketChatOpen && setMarketChatOpen(true)}
        >
          <div className="market-chat-header">
            <span className="market-chat-title">AI 시장 분석</span>
            <button
              className="market-chat-toggle"
              onClick={(e) => {
                e.stopPropagation()
                setMarketChatOpen(!marketChatOpen)
              }}
            >
              {marketChatOpen ? 'X' : 'AI'}
            </button>
          </div>

          {marketChatOpen && (
            <>
              <div className="market-chat-messages">
                {marketChatMessages.length === 0 && (
                  <div className="market-chat-empty">
                    <p>시장 상황에 대해 질문해보세요.</p>
                    <div className="market-chat-suggestions">
                      <button onClick={() => setMarketChatInput('지금 주식 사도 될까요?')}>
                        지금 주식 사도 될까요?
                      </button>
                      <button onClick={() => setMarketChatInput('현재 시장의 주요 리스크는?')}>
                        현재 시장의 주요 리스크는?
                      </button>
                      <button onClick={() => setMarketChatInput('채권 비중을 늘려야 할까요?')}>
                        채권 비중을 늘려야 할까요?
                      </button>
                    </div>
                  </div>
                )}
                {marketChatMessages.map((msg, idx) => (
                  <div key={idx} className={`market-chat-message ${msg.role}`}>
                    <div className="market-chat-message-content">{msg.content}</div>
                  </div>
                ))}
                {marketChatLoading && (
                  <div className="market-chat-message assistant">
                    <div className="market-chat-message-content loading">
                      <span className="loading-dot"></span>
                      <span className="loading-dot"></span>
                      <span className="loading-dot"></span>
                    </div>
                  </div>
                )}
              </div>
              <form className="market-chat-input-form" onSubmit={(e) => { e.preventDefault(); handleMarketChatSend(); }}>
                <input
                  type="text"
                  value={marketChatInput}
                  onChange={(e) => setMarketChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleMarketChatSend()}
                  placeholder="질문을 입력하세요..."
                  disabled={marketChatLoading}
                />
                <button
                  type="submit"
                  disabled={!marketChatInput.trim() || marketChatLoading}
                >
                  전송
                </button>
              </form>
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
