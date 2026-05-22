// 투자 타이밍 점수 + 리스크 신호 계산 모듈
//
// 설계 (2026-05 재학습):
// - Timing Score: ERP + Buffett 기반 Z-score (0~100). robustness 검증 통과 + 가장 큰 edge.
// - Risk Signal: VIX + HY Spread 분위 기반 4단계 (normal/elevated/high/extreme).
//
// 데이터: 1996~2026 30년, scripts/analyze_robustness.py 결과.
// 이전 5지표 단일점수 구조는 3개 sub-period 부호 일치 검증을 통과한 지표가 거의 없어 폐기.

// ============================================================
// Timing Score (투자 매력도)
// ============================================================
// invert=true 지표는 부호 반전 후 Z-score 계산 (높을수록 미래 수익률 높다 방향으로 통일)
export const TIMING_INDICATOR_STATS: Record<
  string,
  { mean: number; std: number; invert: boolean; weight: number }
> = {
  ERP:     { mean: 3.4617,    std: 2.8473,  invert: false, weight: 0.6673 },
  Buffett: { mean: -139.3095, std: 45.1758, invert: true,  weight: 0.3327 },
}

export interface TimingScoreInput {
  erp?: number | null
  buffettIndicator?: number | null
  buffett_indicator?: number | null
}

function pick<T extends object>(obj: T, ...keys: (keyof T)[]): number | null {
  for (const k of keys) {
    const v = obj[k] as unknown
    if (v !== undefined && v !== null) return v as number
  }
  return null
}

export function calculateTimingScore(data: TimingScoreInput): number {
  let sumZ = 0
  let sumW = 0

  const erp = pick(data, 'erp')
  if (erp !== null) {
    const s = TIMING_INDICATOR_STATS.ERP
    const v = s.invert ? -erp : erp
    sumZ += ((v - s.mean) / s.std) * s.weight
    sumW += s.weight
  }

  const buf = pick(data, 'buffettIndicator', 'buffett_indicator')
  if (buf !== null) {
    const s = TIMING_INDICATOR_STATS.Buffett
    const v = s.invert ? -buf : buf
    sumZ += ((v - s.mean) / s.std) * s.weight
    sumW += s.weight
  }

  if (sumW === 0) return 50
  const avgZ = sumZ / sumW
  const score = avgZ * 10 + 50
  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100
}

// ============================================================
// Risk Signal (변동성/신용 경고)
// ============================================================
// 분포 percentile 기반 임계값 (1996~2026)
export const RISK_SIGNAL_THRESHOLDS = {
  vix:      { elevated: 22.27, high: 26.58, extreme: 33.35 },
  hySpread: { elevated: 5.46,  high: 7.17,  extreme: 9.04  },
}

export type RiskLevel = 'normal' | 'elevated' | 'high' | 'extreme'

export interface RiskSignalInput {
  vix?: number | null
  hySpread?: number | null
  hy_spread?: number | null
}

export interface RiskSignal {
  level: RiskLevel
  vix: { value: number | null; level: RiskLevel }
  hy: { value: number | null; level: RiskLevel }
}

const RANK: Record<RiskLevel, number> = { normal: 0, elevated: 1, high: 2, extreme: 3 }

function classify(value: number | null, thresholds: { elevated: number; high: number; extreme: number }): RiskLevel {
  if (value === null) return 'normal'
  if (value >= thresholds.extreme) return 'extreme'
  if (value >= thresholds.high) return 'high'
  if (value >= thresholds.elevated) return 'elevated'
  return 'normal'
}

export function calculateRiskSignal(data: RiskSignalInput): RiskSignal {
  const vix = pick(data, 'vix')
  const hy = pick(data, 'hySpread', 'hy_spread')

  const vixLevel = classify(vix, RISK_SIGNAL_THRESHOLDS.vix)
  const hyLevel = classify(hy, RISK_SIGNAL_THRESHOLDS.hySpread)

  const overallRank = Math.max(RANK[vixLevel], RANK[hyLevel])
  const level = (['normal', 'elevated', 'high', 'extreme'] as RiskLevel[])[overallRank]

  return {
    level,
    vix: { value: vix, level: vixLevel },
    hy: { value: hy, level: hyLevel },
  }
}

// ============================================================
// Backwards compat: 옛 calculateCompositeScore 호출부 유지
// (실제로는 새 TimingScore 사용. 옛 5지표 구조는 폐기됨)
// ============================================================
export interface CompositeScoreInput extends TimingScoreInput {
  // 옛 호출부 호환용 - 무시됨
  hySpread?: number | null
  hy_spread?: number | null
  vix?: number | null
  initialClaims?: number | null
  initial_claims?: number | null
  spyVs200MA?: number | null
  spyVs200ma?: number | null
  spy_vs_200ma?: number | null
  yieldCurve10Y2Y?: number | null
  yield_curve_10y2y?: number | null
}

/** @deprecated use calculateTimingScore */
export function calculateCompositeScore(data: CompositeScoreInput): number {
  return calculateTimingScore(data)
}

/** @deprecated use TIMING_INDICATOR_STATS */
export const INDICATOR_STATS = TIMING_INDICATOR_STATS
