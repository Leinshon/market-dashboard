// 투자 타이밍 점수 + 리스크 신호 (v4, 2026-05 multi-factor)
//
// === Timing Score ===
// 0.8 × drawdown_p10y + 0.2 × margin_per_spy_p10y_inverted
//   - drawdown_p10y: SPY ATH 대비 drawdown의 10년 rolling percentile (regime-free cyclic 신호)
//   - margin/SPY p10y_inv: FINRA margin debt / SPY price의 10년 percentile (낮을수록 매력, 레버리지 사이클)
//
// 검증 (scripts/combination_v3.py, lag-adjusted):
//   - Sharpe 1.40 (baseline drawdown only 1.43)
//   - Spread top-bot 14.1% (baseline 10.9%) — 의사결정 차별화 +3.2%
//   - 3 sub-period 모두 양수 (Era1 +35.0%, Era2 +7.5%, Era3 +9.0%)
//   - Era3 (2016~) 에서 baseline 대비 +2.5% 개선 (regime 진화에 대응)
//   - FINRA 1.5개월 release lag 적용 후에도 alpha 유지 검증
//
// === Risk Signal ===
// VIX + HY Spread + HYG drawdown 의 분위 4단계 (normal/elevated/high/extreme)

// 주의: market_indicators_history 는 '일별' 데이터다. window/lag 는 거래일 기준.
// (과거 주간 가정으로 520/6 이 쓰였으나 일별 입력 시 실제 ~2년/6일로 축소되는 버그였음.
//  검증 스크립트의 주간-520(=10년)과 corr 0.994 로 재현되는 일별-2520/30 으로 교정.)
const ROLLING_WINDOW = 2520 // 10년 (거래일, ~252/yr)
const MARGIN_LAG_DAYS = 30 // FINRA release lag ~1.5개월 (6주 × 5거래일)

// 가중치
const W_DRAWDOWN = 0.8
const W_MARGIN = 0.2

// ============================================================
// Helper: rolling percentile (0~100)
// ============================================================
function rollingPercentile(values: number[], window: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN)
  for (let i = window; i < values.length; i++) {
    const current = values[i]
    if (!Number.isFinite(current)) continue
    const win: number[] = []
    for (let j = i - window; j < i; j++) {
      if (Number.isFinite(values[j])) win.push(values[j])
    }
    if (win.length < window * 0.5) continue
    let rank = 0
    for (const v of win) if (v <= current) rank++
    out[i] = (rank / win.length) * 100
  }
  return out
}

// ============================================================
// Drawdown 시계열 (각 시점 i에서 spy[i] / max(spy[0..i]) - 1)
// ============================================================
function computeDrawdownSeries(spyPrices: (number | null)[]): number[] {
  const out: number[] = []
  let peak = -Infinity
  for (const p of spyPrices) {
    if (p === null || !Number.isFinite(p) || p <= 0) { out.push(NaN); continue }
    if (p > peak) peak = p
    out.push(peak > 0 ? p / peak - 1 : NaN)
  }
  return out
}

// ============================================================
// Margin/SPY 비율 + lag 적용
// ============================================================
function computeMarginPerSpy(
  spyPrices: (number | null)[],
  marginDebt: (number | null)[],
): number[] {
  const out: number[] = []
  for (let i = 0; i < spyPrices.length; i++) {
    const s = spyPrices[i]; const m = marginDebt[i]
    if (s === null || m === null || !Number.isFinite(s) || !Number.isFinite(m) || s <= 0) {
      out.push(NaN); continue
    }
    out.push(m / s)
  }
  return out
}

function applyLag(values: number[], lagWeeks: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN)
  for (let i = lagWeeks; i < values.length; i++) out[i] = values[i - lagWeeks]
  return out
}

// ============================================================
// Timing Score 시계열 (chart 용)
// ============================================================
export interface TimingHistoryInput {
  spy_price: number | null
  margin_debt: number | null
}

export function calculateTimingScoreSeries(history: TimingHistoryInput[]): number[] {
  const spyPrices = history.map(h => h.spy_price)
  const marginDebt = history.map(h => h.margin_debt)

  // drawdown_ath p10y
  const drawdowns = computeDrawdownSeries(spyPrices)
  const ddInverted = drawdowns.map(d => Number.isFinite(d) ? -d : NaN)
  const dd_p10y = rollingPercentile(ddInverted, ROLLING_WINDOW)

  // margin/SPY (lagged 6w) p10y inverted (낮을수록 매력)
  const mps = computeMarginPerSpy(spyPrices, marginDebt)
  const mpsLagged = applyLag(mps, MARGIN_LAG_DAYS)
  const mpsInv = mpsLagged.map(v => Number.isFinite(v) ? -v : NaN)
  const mps_p10y = rollingPercentile(mpsInv, ROLLING_WINDOW)

  // 결합: 둘 다 valid한 시점만 (margin 없을 시 drawdown 100% 가중으로 폴백)
  const out: number[] = []
  for (let i = 0; i < history.length; i++) {
    const dd = dd_p10y[i]; const mp = mps_p10y[i]
    if (!Number.isFinite(dd)) { out.push(NaN); continue }
    if (Number.isFinite(mp)) {
      out.push(Math.round((dd * W_DRAWDOWN + mp * W_MARGIN) * 100) / 100)
    } else {
      // margin 데이터 없으면 drawdown 단독 사용 (1996~ 초기 + margin 데이터 누락 시)
      out.push(Math.round(dd * 100) / 100)
    }
  }
  return out
}

// 단일 (마지막) 시점 score
export function calculateTimingScore(history: TimingHistoryInput[]): number {
  const series = calculateTimingScoreSeries(history)
  return series[series.length - 1] ?? NaN
}

// 분포 (10년 percentile 기반, 거의 균등)
export const TIMING_SCORE_DISTRIBUTION = {
  mean: 50,
  std: 28,
}

// Decomposition 디버그용 - 현재 score의 구성 요소
export interface TimingScoreBreakdown {
  total: number
  drawdownComponent: number
  marginComponent: number | null
  drawdownValue: number
  marginValueLagged: number | null
}

export function calculateTimingBreakdown(history: TimingHistoryInput[]): TimingScoreBreakdown {
  const spyPrices = history.map(h => h.spy_price)
  const marginDebt = history.map(h => h.margin_debt)
  const drawdowns = computeDrawdownSeries(spyPrices)
  const dd_p10y = rollingPercentile(drawdowns.map(d => Number.isFinite(d) ? -d : NaN), ROLLING_WINDOW)
  const mps = computeMarginPerSpy(spyPrices, marginDebt)
  const mpsLagged = applyLag(mps, MARGIN_LAG_DAYS)
  const mps_p10y = rollingPercentile(mpsLagged.map(v => Number.isFinite(v) ? -v : NaN), ROLLING_WINDOW)
  const i = history.length - 1
  const ddV = dd_p10y[i] ?? NaN
  const mpV = mps_p10y[i] ?? NaN
  const series = calculateTimingScoreSeries(history)
  return {
    total: series[i] ?? NaN,
    drawdownComponent: ddV,
    marginComponent: Number.isFinite(mpV) ? mpV : null,
    drawdownValue: drawdowns[i] ?? NaN,
    marginValueLagged: Number.isFinite(mpsLagged[i]) ? mpsLagged[i] : null,
  }
}

// ============================================================
// Risk Signal — VIX + HY + HYG drawdown
// ============================================================
export const RISK_SIGNAL_THRESHOLDS = {
  vix:      { elevated: 22.27, high: 26.58, extreme: 33.35 },
  hySpread: { elevated: 5.46,  high: 7.17,  extreme: 9.04  },
  hygDrawdown: { elevated: -0.04, high: -0.08, extreme: -0.15 }, // 음수, 낙폭 클수록 큰 위험
}

export type RiskLevel = 'normal' | 'elevated' | 'high' | 'extreme'

export interface RiskSignalInput {
  vix?: number | null
  hySpread?: number | null
  hy_spread?: number | null
  hygDrawdown?: number | null // HYG drawdown (음수, 옵션)
}

export interface RiskSignal {
  level: RiskLevel
  vix: { value: number | null; level: RiskLevel }
  hy: { value: number | null; level: RiskLevel }
  hyg: { value: number | null; level: RiskLevel }
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

// HYG drawdown은 음수가 위험. 부호 반전해서 classify에 넘김
function classifyHygDrawdown(value: number | null): RiskLevel {
  if (value === null) return 'normal'
  const t = RISK_SIGNAL_THRESHOLDS.hygDrawdown
  if (value <= t.extreme) return 'extreme'
  if (value <= t.high) return 'high'
  if (value <= t.elevated) return 'elevated'
  return 'normal'
}

export function calculateRiskSignal(data: RiskSignalInput): RiskSignal {
  const vix = pickRisk(data, 'vix')
  const hy = pickRisk(data, 'hySpread', 'hy_spread')
  const hyg = pickRisk(data, 'hygDrawdown')
  const vixLevel = classify(vix, RISK_SIGNAL_THRESHOLDS.vix)
  const hyLevel = classify(hy, RISK_SIGNAL_THRESHOLDS.hySpread)
  const hygLevel = classifyHygDrawdown(hyg)
  const overallRank = Math.max(RANK[vixLevel], RANK[hyLevel], RANK[hygLevel])
  const level = (['normal', 'elevated', 'high', 'extreme'] as RiskLevel[])[overallRank]
  return {
    level,
    vix: { value: vix, level: vixLevel },
    hy: { value: hy, level: hyLevel },
    hyg: { value: hyg, level: hygLevel },
  }
}
