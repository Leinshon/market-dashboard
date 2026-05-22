// 투자 타이밍 점수 + 리스크 신호 계산 모듈
//
// 설계 (2026-05 v3 재설계):
//
// Timing Score = SPY 의 "ATH 대비 drawdown" 을 "rolling 10년 percentile" 로 변환한 0~100 점수.
//
// 이전 v2 (ERP + Buffett z-score) 가 가진 문제를 해결:
//   - regime change (Buffett 110% → 185%) 에 영구 고평가 판정 → 13년간 60+ 점 0개
//   - long-run mean/std 의존 → 시기별 분포 왜곡
//
// v3 가 우월한 이유 (scripts/deep_analysis.py + long_horizon_analysis.py):
//   - Regime-free: drawdown은 cycle 본성 (peak에서 0%, 위기에서 -30~50%, 회복)
//   - 12개월 Sharpe 1.43 (전체 1위), 3개 sub-period 모두 Top-Bot gap 양수
//   - 7개 역사적 위기 (GFC/유럽/2018/코로나/2022/관세) 모두 60+ 신호 정상 작동
//   - Score 80+ 진입 후 10년 보유 시 손실 0회 (48/48), CAGR +12.2%/yr (baseline +7.7%)
//
// Risk Signal = VIX + HY Spread 분위 4단계 (변경 없음)

// ============================================================
// Timing Score (드로다운 기반 매력도)
// ============================================================

const ROLLING_WINDOW = 520 // 10년 (주간 데이터)

// 시계열 → drawdown_ath 변환 (각 시점 i에서 spy[i] / max(spy[0..i]) - 1)
function computeDrawdownSeries(spyPrices: (number | null)[]): number[] {
  const out: number[] = []
  let peak = -Infinity
  for (const p of spyPrices) {
    if (p === null || !Number.isFinite(p) || p <= 0) {
      out.push(NaN)
      continue
    }
    if (p > peak) peak = p
    out.push(peak > 0 ? p / peak - 1 : NaN)
  }
  return out
}

// drawdown 시계열에 대해 각 시점의 rolling 10년 percentile 계산
// 더 큰 낙폭(더 음수)일수록 더 매력 → -drawdown으로 부호 반전한 값의 percentile
function computePercentileSeries(drawdowns: number[]): number[] {
  const inverted = drawdowns.map((d) => (Number.isFinite(d) ? -d : NaN))
  const out: number[] = []
  for (let i = 0; i < inverted.length; i++) {
    if (i < ROLLING_WINDOW) {
      out.push(NaN)
      continue
    }
    const current = inverted[i]
    if (!Number.isFinite(current)) {
      out.push(NaN)
      continue
    }
    const window = inverted.slice(i - ROLLING_WINDOW, i).filter((v) => Number.isFinite(v))
    if (window.length < ROLLING_WINDOW * 0.5) {
      out.push(NaN)
      continue
    }
    const rank = window.filter((v) => v <= current).length
    out.push((rank / window.length) * 100)
  }
  return out
}

// 시계열 전체에 대해 Timing Score 계산 (chart 용)
export function calculateTimingScoreSeries(spyPrices: (number | null)[]): number[] {
  const drawdowns = computeDrawdownSeries(spyPrices)
  return computePercentileSeries(drawdowns)
}

// 시계열에서 마지막 시점의 Timing Score 단일값 (현재 score)
export function calculateTimingScore(spyPrices: (number | null)[]): number {
  const series = calculateTimingScoreSeries(spyPrices)
  return series[series.length - 1] ?? NaN
}

// Timing Score 분포 통계 (10년 percentile이므로 균등분포 근사)
export const TIMING_SCORE_DISTRIBUTION = {
  mean: 50,
  std: 28, // 균등분포의 std ≈ (max-min)/sqrt(12) ≈ 28.9
}

// ============================================================
// Risk Signal (변경 없음)
// ============================================================
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

function pickRisk(data: RiskSignalInput, ...keys: (keyof RiskSignalInput)[]): number | null {
  for (const k of keys) {
    const v = data[k]
    if (v !== undefined && v !== null) return v
  }
  return null
}

function classify(value: number | null, thresholds: { elevated: number; high: number; extreme: number }): RiskLevel {
  if (value === null) return 'normal'
  if (value >= thresholds.extreme) return 'extreme'
  if (value >= thresholds.high) return 'high'
  if (value >= thresholds.elevated) return 'elevated'
  return 'normal'
}

export function calculateRiskSignal(data: RiskSignalInput): RiskSignal {
  const vix = pickRisk(data, 'vix')
  const hy = pickRisk(data, 'hySpread', 'hy_spread')
  const vixLevel = classify(vix, RISK_SIGNAL_THRESHOLDS.vix)
  const hyLevel = classify(hy, RISK_SIGNAL_THRESHOLDS.hySpread)
  const overallRank = Math.max(RANK[vixLevel], RANK[hyLevel])
  const level = (['normal', 'elevated', 'high', 'extreme'] as RiskLevel[])[overallRank]
  return { level, vix: { value: vix, level: vixLevel }, hy: { value: hy, level: hyLevel } }
}
