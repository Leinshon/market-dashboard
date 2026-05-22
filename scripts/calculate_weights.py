#!/usr/bin/env python3
"""
지표별 가중치 계산 스크립트
- 4주/12주 후 SPY 수익률과의 상관계수 계산
- strength = 0.7 * corr_12w + 0.3 * corr_4w
- 양수 strength만 사용하여 가중치 계산
"""

import json
import numpy as np
from pathlib import Path

# 데이터 로드 (1996년~ 30년 데이터, 병합된 전체 데이터)
data_path = Path("/tmp/market_data_full.json")
with open(data_path, 'r') as f:
    raw_data = json.load(f)

print(f"총 데이터 수: {len(raw_data)}개")
print(f"기간: {raw_data[0]['date']} ~ {raw_data[-1]['date']}")

# 지표 목록 및 반전 여부
# 반전 = "높을수록 미래 수익률 낮음" (DB 원본 기준)
# Calculator.tsx의 normalizeScore(value, min, max, true) 사용 지표 = 반전 필요
indicators_config = {
    'fear_greed': True,           # 높음=탐욕 -> 반전 필요
    'vix': False,                 # 높음=공포 -> 그대로 (높으면 미래수익 좋음)
    'spy_vs_200ma': True,         # 높음=과열 -> 반전 필요
    'buffett_indicator': True,    # 높음=고평가 -> 반전 필요
    'fed_balance_sheet_yoy': True, # 높음=유동성과잉 -> 반전 필요 (축소시 매력)
    'm2_growth_yoy': True,        # 높음=유동성과잉 -> 반전 필요 (감소시 매력)
    'hy_spread': False,           # 높음=공포 -> 그대로
    'yield_curve_10y2y': False,   # 높음=정상 -> 그대로
    'yield_curve_10y3m': False,   # 높음=정상 -> 그대로
    'initial_claims': False,      # 높음=불황신호 -> 그대로 (바닥매수)
    'erp': False,                 # 높음=주식매력 -> 그대로
}
indicators = list(indicators_config.keys())

# 데이터를 numpy 배열로 변환
spy_prices = np.array([d['spy_price'] for d in raw_data], dtype=float)

# 4주/12주 후 수익률 계산
spy_ret_4w = np.full(len(spy_prices), np.nan)
spy_ret_12w = np.full(len(spy_prices), np.nan)

for i in range(len(spy_prices) - 4):
    if spy_prices[i] > 0:
        spy_ret_4w[i] = spy_prices[i + 4] / spy_prices[i] - 1

for i in range(len(spy_prices) - 12):
    if spy_prices[i] > 0:
        spy_ret_12w[i] = spy_prices[i + 12] / spy_prices[i] - 1

print(f"\n4주 수익률 유효 데이터: {np.sum(~np.isnan(spy_ret_4w))}개")
print(f"12주 수익률 유효 데이터: {np.sum(~np.isnan(spy_ret_12w))}개")

# 상관계수 계산 함수
def calc_corr(x, y):
    """NaN을 제외하고 상관계수 계산"""
    mask = ~(np.isnan(x) | np.isnan(y))
    if np.sum(mask) < 30:  # 최소 30개 데이터 필요
        return np.nan
    x_valid = x[mask]
    y_valid = y[mask]
    if np.std(x_valid) == 0 or np.std(y_valid) == 0:
        return np.nan
    return np.corrcoef(x_valid, y_valid)[0, 1]

# 각 지표별 상관계수 및 strength 계산
results = []

print("\n" + "="*80)
print(f"{'지표':<25} {'corr_4w':>10} {'corr_12w':>10} {'strength':>10} {'weight':>10}")
print("="*80)

for ind in indicators:
    # 지표 데이터 추출
    values = np.array([d[ind] if d[ind] is not None else np.nan for d in raw_data], dtype=float)

    # 반전이 필요한 지표는 부호 변경
    # "높을수록 미래 수익률이 높다" 방향으로 통일
    if indicators_config[ind]:
        values_used = -values
    else:
        values_used = values

    # 상관계수 계산
    corr_4w = calc_corr(values_used, spy_ret_4w)
    corr_12w = calc_corr(values_used, spy_ret_12w)

    # strength 계산
    if np.isnan(corr_4w) or np.isnan(corr_12w):
        strength = np.nan
    else:
        strength = 0.7 * corr_12w + 0.3 * corr_4w

    results.append({
        'indicator': ind,
        'corr_4w': corr_4w,
        'corr_12w': corr_12w,
        'strength': strength
    })

# 양수 strength만 필터링
positive_results = [r for r in results if not np.isnan(r['strength']) and r['strength'] > 0]
total_positive_strength = sum(r['strength'] for r in positive_results)

# 가중치 계산 및 출력
for r in results:
    if not np.isnan(r['strength']) and r['strength'] > 0:
        weight = r['strength'] / total_positive_strength
    else:
        weight = 0.0
    r['weight'] = weight

    corr_4w_str = f"{r['corr_4w']:.4f}" if not np.isnan(r['corr_4w']) else "N/A"
    corr_12w_str = f"{r['corr_12w']:.4f}" if not np.isnan(r['corr_12w']) else "N/A"
    strength_str = f"{r['strength']:.4f}" if not np.isnan(r['strength']) else "N/A"
    weight_str = f"{weight*100:.1f}%" if weight > 0 else "0.0%"

    print(f"{r['indicator']:<25} {corr_4w_str:>10} {corr_12w_str:>10} {strength_str:>10} {weight_str:>10}")

print("="*80)

# Z-score 정규화 후 Composite Score와 수익률의 상관계수
print("\n\n=== Composite Score 검증 ===")

# Z-score 계산
z_scores = {}
for r in results:
    if r['weight'] > 0:
        values = np.array([d[r['indicator']] if d[r['indicator']] is not None else np.nan for d in raw_data], dtype=float)
        if indicators_config[r['indicator']]:
            values = -values
        mean_val = np.nanmean(values)
        std_val = np.nanstd(values)
        if std_val > 0:
            z_scores[r['indicator']] = (values - mean_val) / std_val
        else:
            z_scores[r['indicator']] = np.zeros_like(values)

# Composite Score 계산
composite = np.zeros(len(raw_data))
for r in results:
    if r['weight'] > 0 and r['indicator'] in z_scores:
        composite += r['weight'] * np.nan_to_num(z_scores[r['indicator']], nan=0)

# Composite와 미래 수익률의 상관계수
corr_comp_4w = calc_corr(composite, spy_ret_4w)
corr_comp_12w = calc_corr(composite, spy_ret_12w)

print(f"Composite vs 4주 수익률 상관계수: {corr_comp_4w:.4f}")
print(f"Composite vs 12주 수익률 상관계수: {corr_comp_12w:.4f}")

# 최종 가중치 요약 (TypeScript 코드용)
print("\n\n=== TypeScript용 가중치 코드 ===")
print("const indicatorWeights: Record<string, number> = {")
for r in sorted(results, key=lambda x: -x['weight']):
    if r['weight'] > 0:
        # 지표명을 UI에서 사용하는 이름으로 매핑
        name_map = {
            'fear_greed': 'Fear & Greed',
            'vix': 'VIX',
            'spy_vs_200ma': 'S&P vs 200MA',
            'buffett_indicator': 'Buffett Indicator',
            'fed_balance_sheet_yoy': 'Fed Balance Sheet',
            'm2_growth_yoy': 'M2 Growth',
            'hy_spread': 'HY Spread',
            'yield_curve_10y2y': 'Yield Curve 10Y-2Y',
            'yield_curve_10y3m': 'Yield Curve 10Y-3M',
            'initial_claims': 'Initial Claims',
            'erp': 'Equity Risk Premium'
        }
        ui_name = name_map.get(r['indicator'], r['indicator'])
        print(f"  '{ui_name}': {r['weight']:.4f},  // strength={r['strength']:.4f}")
print("}")
