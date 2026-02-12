// Z-score 기반 Composite Score 계산 - 공유 모듈
// 모든 파일에서 이 모듈을 import하여 일관된 계산 보장

// 핵심 지표별 역사적 통계 (1996-2025, 30년 데이터 기반)
// Z-score 계산용: (현재값 - mean) / std
// invert=true인 지표는 부호 반전 후 계산 (높을수록 미래 수익률 낮음)
export const INDICATOR_STATS: Record<
  string,
  { mean: number; std: number; invert: boolean; weight: number }
> = {
  'HY Spread': { mean: 5.134, std: 2.5271, invert: false, weight: 0.281 },
  VIX: { mean: 20.097, std: 8.0555, invert: false, weight: 0.2569 },
  'Initial Claims': { mean: 358862.6001, std: 318057.9358, invert: false, weight: 0.2351 },
  'S&P vs 200MA': { mean: 3.4949, std: 7.9576, invert: true, weight: 0.1628 },
  'Yield Curve 10Y-2Y': { mean: 0.9484, std: 0.929, invert: false, weight: 0.0629 },
}

// 지표 데이터 타입 (유연한 키 이름 지원)
export interface CompositeScoreInput {
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

// 값 추출 헬퍼 (다양한 키 이름 지원)
function getValue(data: CompositeScoreInput, ...keys: (keyof CompositeScoreInput)[]): number | null {
  for (const key of keys) {
    const val = data[key]
    if (val !== undefined && val !== null) {
      return val
    }
  }
  return null
}

// 종합 점수 계산 (Z-score 기반)
// 50점 = 역사적 평균, 60점 = 상위 16% (평균 + 1 std), 70점 = 상위 2% (평균 + 2 std)
export function calculateCompositeScore(data: CompositeScoreInput): number {
  let weightedZScore = 0
  let totalWeight = 0

  // HY Spread
  const hySpread = getValue(data, 'hySpread', 'hy_spread')
  if (hySpread !== null) {
    const stat = INDICATOR_STATS['HY Spread']
    const value = stat.invert ? -hySpread : hySpread
    const zscore = (value - stat.mean) / stat.std
    weightedZScore += zscore * stat.weight
    totalWeight += stat.weight
  }

  // VIX
  const vix = getValue(data, 'vix')
  if (vix !== null) {
    const stat = INDICATOR_STATS['VIX']
    const value = stat.invert ? -vix : vix
    const zscore = (value - stat.mean) / stat.std
    weightedZScore += zscore * stat.weight
    totalWeight += stat.weight
  }

  // Initial Claims
  const initialClaims = getValue(data, 'initialClaims', 'initial_claims')
  if (initialClaims !== null) {
    const stat = INDICATOR_STATS['Initial Claims']
    const value = stat.invert ? -initialClaims : initialClaims
    const zscore = (value - stat.mean) / stat.std
    weightedZScore += zscore * stat.weight
    totalWeight += stat.weight
  }

  // S&P vs 200MA
  const spyVs200MA = getValue(data, 'spyVs200MA', 'spyVs200ma', 'spy_vs_200ma')
  if (spyVs200MA !== null) {
    const stat = INDICATOR_STATS['S&P vs 200MA']
    const value = stat.invert ? -spyVs200MA : spyVs200MA
    const zscore = (value - stat.mean) / stat.std
    weightedZScore += zscore * stat.weight
    totalWeight += stat.weight
  }

  // Yield Curve 10Y-2Y
  const yieldCurve10Y2Y = getValue(data, 'yieldCurve10Y2Y', 'yield_curve_10y2y')
  if (yieldCurve10Y2Y !== null) {
    const stat = INDICATOR_STATS['Yield Curve 10Y-2Y']
    const value = stat.invert ? -yieldCurve10Y2Y : yieldCurve10Y2Y
    const zscore = (value - stat.mean) / stat.std
    weightedZScore += zscore * stat.weight
    totalWeight += stat.weight
  }

  if (totalWeight === 0) return 50 // 데이터 없으면 중립

  // 가중 평균 Z-score를 0-100 스케일로 변환
  // Z-score * 10 + 50: Z=0 -> 50점, Z=1 -> 60점, Z=2 -> 70점
  const avgZScore = weightedZScore / totalWeight
  const score = avgZScore * 10 + 50
  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100
}
