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
import { calculateCompositeScore } from './lib/composite-score'
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

const calculateZScoreBasedScore = (data: MarketIndicators): number => {
  return calculateCompositeScore({
    hySpread: data.highYieldSpread,
    vix: data.vix,
    initialClaims: data.initialClaims?.value ?? null,
    spyVs200MA: data.spyVs200MA?.percentAbove ?? null,
    yieldCurve10Y2Y: data.yieldCurve10Y2Y,
  })
}

const calculateZScoreFromHistory = (record: MarketHistoryRecord): number => {
  return calculateCompositeScore({
    hy_spread: record.hy_spread,
    vix: record.vix,
    initial_claims: record.initial_claims,
    spy_vs_200ma: record.spy_vs_200ma,
    yield_curve_10y2y: record.yield_curve_10y2y,
  })
}

type InvestmentStance = 'aggressive_plus' | 'aggressive' | 'moderate_aggressive' | 'neutral' | 'moderate_defensive' | 'defensive' | 'unknown'

const determineInvestmentStance = (avgScore: number): InvestmentStance => {
  if (avgScore >= 60) return 'aggressive_plus'
  if (avgScore >= 55) return 'aggressive'
  if (avgScore >= 50) return 'moderate_aggressive'
  if (avgScore >= 45) return 'neutral'
  if (avgScore >= 41) return 'moderate_defensive'
  if (avgScore >= 0) return 'defensive'
  return 'unknown'
}

const getStanceInfo = (stance: InvestmentStance) => {
  const info = {
    aggressive_plus: {
      label: '매수 적기',
      color: '#059669',
      description: '목돈 투자에 가장 좋은 시기입니다. 2020년 코로나 폭락 때와 유사한 수준으로, 10년에 몇 번 나타나는 드문 기회입니다. 과거 이런 시기에 목돈을 투자하면 3개월 후 100% 상승했고, 평균 +10% 이상의 수익을 기록했습니다.',
      allocation: { stocks: '90%', bonds: '10%', cash: '0%' },
      action: '목돈이 있다면 지금 투자를 적극 고려하세요',
    },
    aggressive: {
      label: '매수 우위',
      color: '#16a34a',
      description: '목돈 투자에 좋은 시기입니다. 시장에 공포심이 퍼져있어 주식이 저렴한 구간입니다. 과거 이런 시기에 3개월 후 89%는 상승해 평균 +6.5% 수익을 거뒀습니다.',
      allocation: { stocks: '80%', bonds: '15%', cash: '5%' },
      action: '목돈 투자를 고려해볼 만한 시점입니다',
    },
    moderate_aggressive: {
      label: '소폭 매수 우위',
      color: '#22c55e',
      description: '목돈 투자에 나쁘지 않은 시기입니다. 과거 이런 시기에 3개월 후 90%는 상승해 평균 +5.3% 수익을 거뒀고, 하락 시에도 손실폭이 제한적이었습니다(-3.5%). 목돈을 넣어도 괜찮은 구간입니다.',
      allocation: { stocks: '70%', bonds: '20%', cash: '10%' },
      action: '목돈은 2~3회 분할 매수를 권장합니다',
    },
    neutral: {
      label: '중립',
      color: '#f59e0b',
      description: '목돈 투자를 서두를 필요가 없는 시기입니다. 과거 이런 시기에 3개월 후 51-67%는 상승했지만, 평균 수익은 0~1%에 불과했습니다. 동전 던지기 수준이라 "지금이 기회다"라고 말하기 어렵습니다.',
      allocation: { stocks: '60%', bonds: '25%', cash: '15%' },
      action: '적립식 투자는 유지하되, 목돈은 더 좋은 기회를 기다리세요',
    },
    moderate_defensive: {
      label: '소폭 방어 우위',
      color: '#f97316',
      description: '목돈 투자에 좋지 않은 시기입니다. 과거 이런 시기에 3개월 후 승률은 58%였지만 평균 수익은 0%입니다. 하락 시 -4.5% 손실이 발생했습니다.',
      allocation: { stocks: '50%', bonds: '25%', cash: '25%' },
      action: '목돈 투자는 보류하고, 더 좋은 기회를 기다리세요',
    },
    defensive: {
      label: '방어 우위',
      color: '#ef4444',
      description: '목돈 투자를 피해야 할 시기입니다. 과거 이런 시기에 3개월 후 승률은 8-37%로 낮았고, 평균 -3% 손실이 발생했습니다. 하락 시 -7% 이상 손실 위험이 있습니다.',
      allocation: { stocks: '40%', bonds: '20%', cash: '40%' },
      action: '목돈은 현금으로 보유하고, 조정을 기다리세요',
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

const getStanceProbability = (stance: InvestmentStance) => {
  const probabilities: Record<InvestmentStance, {
    week4: { up: number; down: number; avgUp: number; avgDown: number };
    week12: { up: number; down: number; avgUp: number; avgDown: number };
  }> = {
    aggressive_plus: {
      week4: { up: 100, down: 0, avgUp: 12.6, avgDown: 0 },
      week12: { up: 100, down: 0, avgUp: 23.0, avgDown: 0 },
    },
    aggressive: {
      week4: { up: 100, down: 0, avgUp: 4.6, avgDown: 0 },
      week12: { up: 88, down: 12, avgUp: 11.8, avgDown: -0.8 },
    },
    moderate_aggressive: {
      week4: { up: 72, down: 28, avgUp: 5.4, avgDown: -6.9 },
      week12: { up: 86, down: 14, avgUp: 7.0, avgDown: -2.5 },
    },
    neutral: {
      week4: { up: 58, down: 42, avgUp: 4.2, avgDown: -4.3 },
      week12: { up: 75, down: 25, avgUp: 7.4, avgDown: -5.7 },
    },
    moderate_defensive: {
      week4: { up: 69, down: 31, avgUp: 2.7, avgDown: -4.6 },
      week12: { up: 67, down: 33, avgUp: 5.5, avgDown: -7.5 },
    },
    defensive: {
      week4: { up: 72, down: 28, avgUp: 1.9, avgDown: -2.2 },
      week12: { up: 84, down: 16, avgUp: 4.1, avgDown: -5.7 },
    },
    unknown: {
      week4: { up: 0, down: 0, avgUp: 0, avgDown: 0 },
      week12: { up: 0, down: 0, avgUp: 0, avgDown: 0 },
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

      if (indicator.name === 'VIX') {
        if (isExtremeLow) {
          commentaries.push(`${koreanName}가 ${indicator.value}로 ${extremeLabel} 수준입니다. 시장 안도감이 높아 조정 가능성에 유의하세요.`)
        } else {
          commentaries.push(`${koreanName}가 ${indicator.value}로 ${extremeLabel} 수준의 공포 구간입니다. 역사적으로 높은 VIX는 매수 기회였습니다.`)
        }
      } else if (indicator.name === 'HY Spread') {
        if (isExtremeLow) {
          commentaries.push(`${koreanName}가 ${indicator.value}로 ${extremeLabel} 수준입니다. 신용 리스크 경계심이 낮아 주의가 필요합니다.`)
        } else {
          commentaries.push(`${koreanName}가 ${indicator.value}로 ${extremeLabel} 수준입니다. 신용 스트레스가 높지만 역발상 매수 기회일 수 있습니다.`)
        }
      } else if (indicator.name === 'Initial Claims') {
        if (isExtremeLow) {
          commentaries.push(`${koreanName}가 ${indicator.value}로 ${extremeLabel} 수준입니다. 고용시장이 과열 상태로 긴축 지속 가능성이 있습니다.`)
        } else {
          commentaries.push(`${koreanName}가 ${indicator.value}로 ${extremeLabel} 수준입니다. 고용 악화는 연준 완화 전환 신호일 수 있습니다.`)
        }
      } else if (indicator.name === 'S&P vs 200MA') {
        if (isExtremeLow) {
          commentaries.push(`S&P500이 200일선 대비 ${indicator.value}로 ${extremeLabel} 수준입니다. 기술적으로 저점 매수 구간입니다.`)
        } else {
          commentaries.push(`S&P500이 200일선 대비 ${indicator.value}로 ${extremeLabel} 수준입니다. 과열 구간으로 추격 매수는 주의하세요.`)
        }
      } else if (indicator.name === 'Yield Curve 10Y-2Y') {
        if (isExtremeLow) {
          commentaries.push(`${koreanName}가 ${indicator.value}로 ${extremeLabel} 수준의 역전 상태입니다. 경기 침체 우려가 있지만 주가는 선반영하는 경향이 있습니다.`)
        } else {
          commentaries.push(`${koreanName}가 ${indicator.value}로 정상화되어 ${extremeLabel} 수준입니다. 경기 회복 기대가 반영되고 있습니다.`)
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
  const [activeTab, setActiveTab] = useState<'overview' | 'global' | 'macro' | 'timing'>('overview')
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
  useEffect(() => {
    if (activeTab === 'global' && globalHistory.length === 0 && !globalLoading) {
      setGlobalLoading(true)

      const fetchGlobalIndices = async () => {
        try {
          // DB에서 히스토리 데이터 가져오기 (여러 배치로 나눠서)
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

          const historyData = allData
          const error = null

          if (error) throw error

          if (historyData && historyData.length > 0) {
            setGlobalHistory(historyData)

            // 최신 데이터로 현재 지수 정보 계산
            const symbols = [...new Set(historyData.map(d => d.symbol))]
            const results: typeof globalIndices = []

            for (const symbol of symbols) {
              const symbolData = historyData.filter(d => d.symbol === symbol)
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
          setGlobalLoading(false)
        }
      }

      fetchGlobalIndices()
    }
  }, [activeTab, globalHistory.length, globalLoading])

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

  // 채팅 전송
  const handleMarketChatSend = async () => {
    if (!marketChatInput.trim() || marketChatLoading || !selectedMarketData) return

    const userMessage = marketChatInput.trim()
    setMarketChatInput('')
    setMarketChatMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setMarketChatLoading(true)

    try {
      const scores = calculateIndicatorScores(selectedMarketData, marketHistory)
      const avgScore = Math.round(calculateZScoreBasedScore(selectedMarketData))
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
      const indicatorsText = `투자매력도: ${avgScore}점 (${stanceInfo.label})
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
          10년 상관분석 기반 5개 핵심 지표로 투자 매력도 산출. 공포/저평가일수록 점수 상승
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
          const avgScore = Math.round(calculateZScoreBasedScore(selectedMarketData))
          const stance = determineInvestmentStance(avgScore)
          const stanceInfo = getStanceInfo(stance)

          const indicatorWeightsDisplay: Record<string, number> = {
            'HY Spread': 28.1,
            'VIX': 25.7,
            'Initial Claims': 23.5,
            'S&P vs 200MA': 16.3,
            'Yield Curve 10Y-2Y': 6.3,
          }
          const coreIndicators = scores.filter(s => indicatorWeightsDisplay[s.name] !== undefined)
          const refIndicators = scores.filter(s => indicatorWeightsDisplay[s.name] === undefined)

          const allScores = marketHistory.map(h => calculateZScoreFromHistory(h)).sort((a, b) => b - a)
          const totalCount = allScores.length
          const rankInAll = allScores.filter(s => s > avgScore).length + 1

          const oneYearAgo = new Date()
          oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
          const oneYearScores = marketHistory
            .filter(h => new Date(h.date) >= oneYearAgo)
            .map(h => calculateZScoreFromHistory(h))
            .sort((a, b) => b - a)
          const oneYearCount = oneYearScores.length
          const rankIn1Y = oneYearScores.filter(s => s > avgScore).length + 1

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
                    <span className="market-score-value">{avgScore}</span>
                    <span className="market-score-max">/100</span>
                  </div>
                </div>
                <div className="market-percentile-info">
                  <span className="market-percentile-item">
                    1년 내 {rankIn1Y}위 / {oneYearCount}건
                  </span>
                  <span className="market-percentile-divider">|</span>
                  <span className="market-percentile-item">
                    10년 내 {rankInAll}위 / {totalCount}건
                  </span>
                </div>

                {/* 표준정규분포 곡선 */}
                {(() => {
                  const actualMean = 50
                  const actualStdDev = 7
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

                  const stanceBoundaries = [
                    { z: (65 - actualMean) / actualStdDev, label: '65' },
                    { z: (57 - actualMean) / actualStdDev, label: '57' },
                    { z: 0, label: '50' },
                    { z: (43 - actualMean) / actualStdDev, label: '43' },
                    { z: (35 - actualMean) / actualStdDev, label: '35' },
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

                  {/* 4주/12주 확률 */}
                  {(() => {
                    const prob = getStanceProbability(stance)
                    return (
                      <div className="market-probability-box">
                        <span className="market-probability-title">지금 투자하면? (2020~2026 백테스트 기준)</span>
                        <div className="market-probability-grid">
                          <div className="market-probability-period">
                            <span className="market-probability-label">4주 후</span>
                            <div className="market-probability-bars">
                              <div className="market-probability-bar-row">
                                <span className="market-probability-direction up">상승</span>
                                <div className="market-probability-bar-track">
                                  <div
                                    className="market-probability-bar-fill up"
                                    style={{ width: `${prob.week4.up}%` }}
                                  />
                                </div>
                                <span className="market-probability-value">{prob.week4.up}%</span>
                                <span className="market-probability-avg">(+{prob.week4.avgUp.toFixed(1)}%)</span>
                              </div>
                              <div className="market-probability-bar-row">
                                <span className="market-probability-direction down">하락</span>
                                <div className="market-probability-bar-track">
                                  <div
                                    className="market-probability-bar-fill down"
                                    style={{ width: `${prob.week4.down}%` }}
                                  />
                                </div>
                                <span className="market-probability-value">{prob.week4.down}%</span>
                                <span className="market-probability-avg">({prob.week4.avgDown.toFixed(1)}%)</span>
                              </div>
                            </div>
                          </div>
                          <div className="market-probability-period">
                            <span className="market-probability-label">12주 후</span>
                            <div className="market-probability-bars">
                              <div className="market-probability-bar-row">
                                <span className="market-probability-direction up">상승</span>
                                <div className="market-probability-bar-track">
                                  <div
                                    className="market-probability-bar-fill up"
                                    style={{ width: `${prob.week12.up}%` }}
                                  />
                                </div>
                                <span className="market-probability-value">{prob.week12.up}%</span>
                                <span className="market-probability-avg">(+{prob.week12.avgUp.toFixed(1)}%)</span>
                              </div>
                              <div className="market-probability-bar-row">
                                <span className="market-probability-direction down">하락</span>
                                <div className="market-probability-bar-track">
                                  <div
                                    className="market-probability-bar-fill down"
                                    style={{ width: `${prob.week12.down}%` }}
                                  />
                                </div>
                                <span className="market-probability-value">{prob.week12.down}%</span>
                                <span className="market-probability-avg">({prob.week12.avgDown.toFixed(1)}%)</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                </div>
              </div>

              {/* 투자 매력도 vs S&P500 차트 */}
              {marketHistory.length > 0 && (() => {
                const periodMonths = { '1y': 12, '3y': 36, '5y': 60, '10y': 120, 'all': 999 }
                const targetMonths = periodMonths[chartPeriod]
                const startDate = new Date()
                startDate.setMonth(startDate.getMonth() - targetMonths)

                const filteredHistory = chartPeriod === 'all' ? marketHistory : marketHistory.filter(h => new Date(h.date) >= startDate)
                if (filteredHistory.length === 0) return null

                const compositeScores = filteredHistory.map(h => calculateZScoreFromHistory(h))
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
                  { stance: 'aggressive_plus', label: '매수 적기', min: 60, max: 100, color: '#059669' },
                  { stance: 'aggressive', label: '매수 우위', min: 55, max: 60, color: '#16a34a' },
                  { stance: 'moderate_aggressive', label: '소폭 매수', min: 50, max: 55, color: '#22c55e' },
                  { stance: 'neutral', label: '중립', min: 45, max: 50, color: '#f59e0b' },
                  { stance: 'moderate_defensive', label: '소폭 방어', min: 41, max: 45, color: '#f97316' },
                  { stance: 'defensive', label: '방어 우위', min: 0, max: 41, color: '#ef4444' },
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

              {/* 지표별 상세 - 핵심 지표 / 참고 지표 */}
              <div className="market-indicators">
                {/* 핵심 지표 (가중치 반영) */}
                <div className="market-category">
                  <div className="market-category-header">
                    <h3 className="market-category-title">핵심 지표</h3>
                    <span className="market-category-subtitle">10년 상관분석 기반 가중 반영</span>
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
