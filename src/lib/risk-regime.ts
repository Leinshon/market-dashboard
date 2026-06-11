// 리스크 레짐 + DCA 모델 (scripts/model_validate.py 검증안의 프론트 구현)
//
// 핵심 원칙(검증 결과): 수익률은 예측하지 못한다(cross-index 1y spread 부호 비일관).
// 견고한 가치는 '하락추세에서 노출 축소 → 낙폭 절반'. 따라서 이 지표는
// 수익 예측이 아니라 '리스크 레짐 + 노출 가이드 + DCA 코칭' 용도다.
//
// 레짐 = 추세(200일선) + 12개월 모멘텀 + 실현변동성 의 a-priori 조합 (미튜닝).

export type Regime = 'green' | 'yellow' | 'red' | 'unknown'

export interface RegimePoint {
  date: string
  price: number | null
  ma200: number | null
  mom12: number | null     // 12개월(252거래일) 수익률
  vol: number | null       // 연율화 60일 실현변동성
  volElevated: boolean
  drawdown: number | null  // ATH 대비 낙폭
  regime: Regime
  exposure: number         // 권장 주식 노출 0~1
}

const D1Y = 252
const VOL_WIN = 60
const MA_WIN = 200

function annualizedVol(returns: number[]): number {
  if (returns.length < 2) return NaN
  const m = returns.reduce((s, v) => s + v, 0) / returns.length
  const varr = returns.reduce((s, v) => s + (v - m) ** 2, 0) / returns.length
  return Math.sqrt(varr) * Math.sqrt(252)
}

const EXPOSURE: Record<Regime, number> = { green: 1.0, yellow: 0.7, red: 0.4, unknown: 1.0 }

export function computeRegimeSeries(dates: string[], prices: (number | null)[]): RegimePoint[] {
  const n = prices.length
  // 일별 수익률
  const ret = new Array<number>(n).fill(NaN)
  for (let i = 1; i < n; i++) {
    const a = prices[i - 1], b = prices[i]
    if (a != null && b != null && a > 0) ret[i] = b / a - 1
  }
  // 200일 이동평균 (null 무시)
  const ma200 = new Array<number | null>(n).fill(null)
  for (let i = MA_WIN - 1; i < n; i++) {
    let sum = 0, cnt = 0
    for (let j = i - MA_WIN + 1; j <= i; j++) { const v = prices[j]; if (v != null) { sum += v; cnt++ } }
    if (cnt > MA_WIN * 0.6) ma200[i] = sum / cnt
  }
  // 60일 실현변동성
  const vol = new Array<number | null>(n).fill(null)
  for (let i = VOL_WIN; i < n; i++) {
    const seg: number[] = []
    for (let j = i - VOL_WIN + 1; j <= i; j++) if (Number.isFinite(ret[j])) seg.push(ret[j])
    if (seg.length > VOL_WIN * 0.6) vol[i] = annualizedVol(seg)
  }
  // vol elevated = 현재 vol > 1.25 × 직전 1년 평균 vol
  const volElevated = new Array<boolean>(n).fill(false)
  for (let i = D1Y; i < n; i++) {
    if (vol[i] == null) continue
    let sum = 0, cnt = 0
    for (let j = i - D1Y + 1; j <= i; j++) { const v = vol[j]; if (v != null) { sum += v; cnt++ } }
    if (cnt > D1Y * 0.5) volElevated[i] = (vol[i] as number) > 1.25 * (sum / cnt)
  }
  // ATH drawdown
  const drawdown = new Array<number | null>(n).fill(null)
  let peak = -Infinity
  for (let i = 0; i < n; i++) {
    const v = prices[i]
    if (v == null || v <= 0) continue
    if (v > peak) peak = v
    drawdown[i] = peak > 0 ? v / peak - 1 : null
  }

  const out: RegimePoint[] = []
  for (let i = 0; i < n; i++) {
    const p = prices[i], m = ma200[i]
    let regime: Regime = 'unknown'
    if (p != null && m != null && i >= D1Y && prices[i - D1Y] != null) {
      const trendUp = p > m
      const momPos = (prices[i - D1Y] as number) > 0 && p / (prices[i - D1Y] as number) - 1 > 0
      const calm = !volElevated[i]
      const healthy = (trendUp ? 1 : 0) + (momPos ? 1 : 0) + (calm ? 1 : 0)
      regime = healthy >= 3 ? 'green' : healthy === 2 ? 'yellow' : 'red'
    }
    out.push({
      date: dates[i],
      price: p,
      ma200: m,
      mom12: (p != null && i >= D1Y && prices[i - D1Y] != null && (prices[i - D1Y] as number) > 0)
        ? p / (prices[i - D1Y] as number) - 1 : null,
      vol: vol[i],
      volElevated: volElevated[i],
      drawdown: drawdown[i],
      regime,
      exposure: EXPOSURE[regime],
    })
  }
  return out
}

export interface DcaStratResult {
  contributed: number
  finalValue: number
  multiple: number
  maxDrawdown: number  // 계좌 잔고 기준 최대 낙폭
  cagr: number
}
export interface DcaResult {
  start: string
  end: string
  months: number
  pure: DcaStratResult
  regime: DcaStratResult
  curve: { date: string; pure: number; regime: number; contributed: number }[]
}

// 매월 첫 거래일에 monthly 만큼 적립. 노출 w 만큼만 주식, 나머지 현금(무수익).
function simulate(points: RegimePoint[], monthly: number, useRegime: boolean) {
  let value = 0, contributed = 0, peak = 0, maxDD = 0
  let prevMonth = ''
  const valueSeries: number[] = []
  for (let i = 0; i < points.length; i++) {
    const pt = points[i]
    if (pt.price == null) { valueSeries.push(value); continue }
    // 일별 성장 (직전 노출 적용)
    if (i > 0 && points[i - 1].price != null && (points[i - 1].price as number) > 0) {
      const r = (pt.price as number) / (points[i - 1].price as number) - 1
      const w = useRegime ? points[i - 1].exposure : 1
      value *= 1 + w * r
    }
    // 월초 적립
    const mo = pt.date.slice(0, 7)
    if (mo !== prevMonth) { value += monthly; contributed += monthly; prevMonth = mo }
    valueSeries.push(value)
    if (value > peak) peak = value
    if (peak > 0) maxDD = Math.min(maxDD, value / peak - 1)
  }
  return { value, contributed, valueSeries, maxDD }
}

export function simulateDca(allPoints: RegimePoint[], monthly: number): DcaResult | null {
  // 레짐이 계산 가능한 시점부터 (양 전략 동일 구간)
  const startIdx = allPoints.findIndex(p => p.regime !== 'unknown' && p.price != null)
  if (startIdx < 0) return null
  const points = allPoints.slice(startIdx)
  if (points.length < 252) return null

  const pure = simulate(points, monthly, false)
  const reg = simulate(points, monthly, true)
  const years = points.length / 252
  const mk = (s: ReturnType<typeof simulate>): DcaStratResult => ({
    contributed: s.contributed,
    finalValue: s.value,
    multiple: s.contributed > 0 ? s.value / s.contributed : NaN,
    maxDrawdown: s.maxDD,
    cagr: s.contributed > 0 && years > 0 ? Math.pow(s.value / s.contributed, 1 / years) - 1 : NaN,
  })

  // 차트용 월별 다운샘플
  const curve: DcaResult['curve'] = []
  let prevMonth = ''
  for (let i = 0; i < points.length; i++) {
    const mo = points[i].date.slice(0, 7)
    if (mo !== prevMonth) {
      const contributedSoFar = monthly * (curve.length + 1)
      curve.push({ date: points[i].date, pure: Math.round(pure.valueSeries[i]), regime: Math.round(reg.valueSeries[i]), contributed: contributedSoFar })
      prevMonth = mo
    }
  }
  const months = curve.length
  return { start: points[0].date, end: points[points.length - 1].date, months, pure: mk(pure), regime: mk(reg), curve }
}

// ── 기능3: 레짐 전환 타임라인 ──────────────────────────────
export interface RegimeTransition { date: string; from: Regime; to: Regime }
export interface RegimeTimeline {
  transitions: RegimeTransition[]   // 시간순 (최신이 뒤)
  current: Regime
  since: string                     // 현재 레짐 시작일
  streakDays: number                // 현재 레짐 지속 거래일
  share: Record<'green' | 'yellow' | 'red', number>  // 전체 대비 비율(%)
}
export function regimeTimeline(points: RegimePoint[]): RegimeTimeline | null {
  const valid = points.filter(p => p.regime !== 'unknown')
  if (valid.length === 0) return null
  const transitions: RegimeTransition[] = []
  let prev: Regime = valid[0].regime
  let sinceDate = valid[0].date
  const count = { green: 0, yellow: 0, red: 0 }
  for (const p of valid) {
    if (p.regime === 'green' || p.regime === 'yellow' || p.regime === 'red') count[p.regime]++
    if (p.regime !== prev) {
      transitions.push({ date: p.date, from: prev, to: p.regime })
      sinceDate = p.date
      prev = p.regime
    }
  }
  const total = valid.length
  const streakDays = valid.filter(p => p.date >= sinceDate).length
  return {
    transitions,
    current: prev,
    since: sinceDate,
    streakDays,
    share: {
      green: Math.round(count.green / total * 100),
      yellow: Math.round(count.yellow / total * 100),
      red: Math.round(count.red / total * 100),
    },
  }
}

// ── 기능4: 낙폭 / 회복 맥락 ────────────────────────────────
export interface DrawdownContext {
  current: number              // 현재 ATH 대비 낙폭 (음수)
  currentRankPct: number       // 역대 낙폭 분포에서 현재가 얼마나 깊은가 (0~100, 높을수록 깊음)
  underwaterMonths: number     // 마지막 신고가 이후 경과 (거래월)
  episodes10: number           // -10% 이상 하락 에피소드 수
  episodes20: number           // -20% 이상
  medianRecovery10: number | null  // -10%+ 에피소드 중앙값 회복기간(월)
  worstDepth: number           // 역대 최악 낙폭
  worstRecovery: number | null // 역대 최악 낙폭의 회복기간(월)
}
const TD_PER_MONTH = 21
export function drawdownContext(points: RegimePoint[]): DrawdownContext | null {
  const px = points.map(p => p.price)
  const n = px.length
  const ddAll: number[] = []
  interface Ep { startIdx: number; depth: number; recoverIdx: number | null }
  const eps: Ep[] = []
  let peak = -Infinity, peakIdx = 0
  let cur: Ep | null = null
  for (let i = 0; i < n; i++) {
    const v = px[i]
    if (v == null || v <= 0) continue
    if (v >= peak) {
      if (cur) { cur.recoverIdx = i; eps.push(cur); cur = null }  // 신고가 → 에피소드 종료
      peak = v; peakIdx = i
    } else {
      const dd = v / peak - 1
      ddAll.push(dd)
      if (!cur) cur = { startIdx: peakIdx, depth: dd, recoverIdx: null }
      else cur.depth = Math.min(cur.depth, dd)
    }
  }
  if (cur) eps.push(cur)  // 미회복(현재 진행중) 에피소드
  if (ddAll.length === 0 && eps.length === 0) return null

  const current = points.length ? (points[points.length - 1].drawdown ?? 0) : 0
  // 현재 낙폭의 역대 percentile (깊을수록 높음)
  const deeper = ddAll.filter(d => d <= current).length
  const currentRankPct = ddAll.length ? Math.round(deeper / ddAll.length * 100) : 0
  // 마지막 신고가 이후 경과
  let underwater = 0
  for (let i = n - 1; i >= 0; i--) { if (px[i] != null) { if ((points[i].drawdown ?? 0) < 0) underwater++; else break } }

  const recoveredMonths = (e: Ep) => e.recoverIdx != null ? (e.recoverIdx - e.startIdx) / TD_PER_MONTH : null
  const ep10 = eps.filter(e => e.depth <= -0.10)
  const ep20 = eps.filter(e => e.depth <= -0.20)
  const rec10 = ep10.map(recoveredMonths).filter((m): m is number => m != null).sort((a, b) => a - b)
  const median10 = rec10.length ? rec10[Math.floor(rec10.length / 2)] : null
  const worst = eps.reduce((w, e) => e.depth < w.depth ? e : w, eps[0])
  return {
    current,
    currentRankPct,
    underwaterMonths: Math.round(underwater / TD_PER_MONTH),
    episodes10: ep10.length,
    episodes20: ep20.length,
    medianRecovery10: median10 != null ? Math.round(median10) : null,
    worstDepth: worst.depth,
    worstRecovery: recoveredMonths(worst) != null ? Math.round(recoveredMonths(worst) as number) : null,
  }
}

export const REGIME_INFO: Record<Regime, { label: string; color: string; desc: string; action: string }> = {
  green:  { label: '우호적', color: '#059669', desc: '추세 건강(200일선 위)·모멘텀 양호·변동성 안정', action: '풀투자 유지, 적립 지속' },
  yellow: { label: '주의',   color: '#f59e0b', desc: '추세/모멘텀/변동성 중 일부 악화', action: '적립 유지, 신규 목돈은 분할' },
  red:    { label: '방어',   color: '#ef4444', desc: '하락추세(200일선 아래)·모멘텀 음전·변동성 확대', action: '신규 목돈 보류, 적립은 계속(중단 금지)' },
  unknown:{ label: '판단 불가', color: '#6b7280', desc: '데이터 부족(1년+ 이력 필요)', action: '-' },
}
