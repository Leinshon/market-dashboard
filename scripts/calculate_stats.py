#!/usr/bin/env python3
"""
핵심 지표별 역사적 평균/표준편차 계산
- Z-score 기반 점수 계산을 위한 통계치 산출
- 1996년~현재 30년 데이터 기반
"""

import json
import numpy as np
from pathlib import Path

# 데이터 로드
data_path = Path("/tmp/market_data_full.json")
with open(data_path, 'r') as f:
    raw_data = json.load(f)

print(f"총 데이터 수: {len(raw_data)}개")
print(f"기간: {raw_data[0]['date']} ~ {raw_data[-1]['date']}")

# 핵심 지표 (양수 strength를 가진 5개)
# 점수 계산 시 방향: 높을수록 미래 수익률이 높다
core_indicators = {
    'hy_spread': {
        'name': 'HY Spread',
        'invert': False,  # 높을수록 공포 = 미래수익 높음
        'weight': 0.2810
    },
    'vix': {
        'name': 'VIX',
        'invert': False,  # 높을수록 공포 = 미래수익 높음
        'weight': 0.2569
    },
    'initial_claims': {
        'name': 'Initial Claims',
        'invert': False,  # 높을수록 불황 = 바닥 매수
        'weight': 0.2351
    },
    'spy_vs_200ma': {
        'name': 'S&P vs 200MA',
        'invert': True,   # 높을수록 과열 = 반전 필요
        'weight': 0.1628
    },
    'yield_curve_10y2y': {
        'name': 'Yield Curve 10Y-2Y',
        'invert': False,  # 높을수록 정상 = 좋음
        'weight': 0.0629
    },
}

print("\n" + "="*100)
print(f"{'지표':<25} {'평균':>12} {'표준편차':>12} {'최소':>12} {'최대':>12} {'invert':>8} {'weight':>8}")
print("="*100)

stats = {}

for field, config in core_indicators.items():
    values = np.array([d[field] if d[field] is not None else np.nan for d in raw_data], dtype=float)

    # 반전이 필요한 지표는 부호 변경
    if config['invert']:
        values_for_score = -values
    else:
        values_for_score = values

    mean_val = np.nanmean(values_for_score)
    std_val = np.nanstd(values_for_score)
    min_val = np.nanmin(values_for_score)
    max_val = np.nanmax(values_for_score)

    # 원본 값 기준 통계도 계산 (UI 표시용)
    raw_mean = np.nanmean(values)
    raw_std = np.nanstd(values)

    stats[field] = {
        'name': config['name'],
        'mean': mean_val,
        'std': std_val,
        'raw_mean': raw_mean,
        'raw_std': raw_std,
        'invert': config['invert'],
        'weight': config['weight']
    }

    print(f"{config['name']:<25} {mean_val:>12.4f} {std_val:>12.4f} {min_val:>12.4f} {max_val:>12.4f} {str(config['invert']):>8} {config['weight']:>8.2%}")

print("="*100)

# TypeScript용 상수 출력
print("\n\n=== TypeScript용 상수 코드 ===")
print("// 핵심 지표별 역사적 통계 (1996-2025, 30년 데이터 기반)")
print("// Z-score 계산용: (현재값 - mean) / std")
print("// invert=true인 지표는 부호 반전 후 계산")
print("const INDICATOR_STATS: Record<string, { mean: number; std: number; invert: boolean; weight: number }> = {")
for field, s in stats.items():
    print(f"  '{s['name']}': {{ mean: {s['mean']:.4f}, std: {s['std']:.4f}, invert: {str(s['invert']).lower()}, weight: {s['weight']:.4f} }},")
print("}")

# 원본 값 기준 통계 (UI 바 표시용)
print("\n// 원본 값 기준 통계 (UI 범위 바 표시용)")
print("const INDICATOR_RAW_STATS: Record<string, { mean: number; std: number }> = {")
for field, s in stats.items():
    print(f"  '{s['name']}': {{ mean: {s['raw_mean']:.4f}, std: {s['raw_std']:.4f} }},")
print("}")

# Composite Z-score 분포 검증
print("\n\n=== Composite Z-score 분포 검증 ===")

composite_zscores = []
for i, d in enumerate(raw_data):
    zscore_sum = 0
    weight_sum = 0

    for field, config in core_indicators.items():
        value = d[field]
        if value is None:
            continue

        s = stats[field]
        # Z-score 계산
        if config['invert']:
            value_for_zscore = -value
        else:
            value_for_zscore = value

        zscore = (value_for_zscore - s['mean']) / s['std']
        zscore_sum += zscore * config['weight']
        weight_sum += config['weight']

    if weight_sum > 0:
        composite_zscore = zscore_sum / weight_sum
        # 0-100 스케일로 변환 (Z-score * 10 + 50, 클램프 0-100)
        score_100 = max(0, min(100, composite_zscore * 10 + 50))
        composite_zscores.append(score_100)

composite_arr = np.array(composite_zscores)
print(f"Composite Score 분포 (0-100 스케일):")
print(f"  평균: {np.mean(composite_arr):.2f}")
print(f"  표준편차: {np.std(composite_arr):.2f}")
print(f"  최소: {np.min(composite_arr):.2f}")
print(f"  최대: {np.max(composite_arr):.2f}")
print(f"  중앙값: {np.median(composite_arr):.2f}")

# 백분위
percentiles = [5, 10, 25, 50, 75, 90, 95]
print(f"\n백분위:")
for p in percentiles:
    print(f"  {p}%: {np.percentile(composite_arr, p):.2f}")
