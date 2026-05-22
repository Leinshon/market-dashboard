#!/usr/bin/env python3
"""
3-카테고리 구조 재산출:
- Timing Score: ERP + Buffett (Z-score weighted, 0-100)
- Risk Signal: VIX + HY Spread (percentile based)
- Macro Context: Initial Claims, Fed BS YoY, YC 10Y-2Y (UI 표시용, 점수 합산 X)

산출:
1. ERP/Buffett mean/std (Timing Score용 Z-score 통계)
2. VIX/HY 분포 percentile (Risk Signal threshold)
3. Timing Score 점수 구간별 hit rate (stance probability 재산출)
"""

import json
import numpy as np
from pathlib import Path

with open(Path("/tmp/market_data_full.json")) as f:
    raw = json.load(f)

n = len(raw)
print(f"기간: {raw[0]['date']} ~ {raw[-1]['date']} ({n}개)\n")

spy = np.array([d['spy_price'] if d['spy_price'] is not None else np.nan for d in raw], dtype=float)

def fwd_ret(prices, lag):
    out = np.full(len(prices), np.nan)
    for i in range(len(prices) - lag):
        if prices[i] and prices[i] > 0 and not np.isnan(prices[i+lag]):
            out[i] = prices[i + lag] / prices[i] - 1
    return out

# Timing 의사결정의 핵심은 4-12주가 아니라 6-12개월
ret_4w  = fwd_ret(spy, 4)
ret_12w = fwd_ret(spy, 13)
ret_6m  = fwd_ret(spy, 26)
ret_12m = fwd_ret(spy, 52)

# ============================================================
# 1. Timing Score 통계 (ERP + Buffett)
# ============================================================
print("="*90)
print("[1] Timing Score 구성: ERP(67%) + Buffett(33%)")
print("    분석에서 robustness 통과 + edge 가장 큰 2개")
print("="*90)

erp = np.array([d['erp'] if d['erp'] is not None else np.nan for d in raw], dtype=float)
buf = np.array([d['buffett_indicator'] if d['buffett_indicator'] is not None else np.nan for d in raw], dtype=float)

# 방향: ERP는 높을수록 매력 (invert=False), Buffett은 낮을수록 매력 (invert=True → 부호 반전)
erp_signed = erp
buf_signed = -buf

stats = {
    'erp':            {'mean': np.nanmean(erp_signed), 'std': np.nanstd(erp_signed), 'invert': False, 'weight': 0.6673},
    'buffett':        {'mean': np.nanmean(buf_signed), 'std': np.nanstd(buf_signed), 'invert': True,  'weight': 0.3327},
}

print(f"{'지표':<14}{'mean':>14}{'std':>14}{'invert':>10}{'weight':>10}")
print("-"*62)
for k, s in stats.items():
    print(f"{k:<14}{s['mean']:>14.4f}{s['std']:>14.4f}{str(s['invert']):>10}{s['weight']:>10.4f}")

# Timing Score 계산
def timing_score(erp_val, buf_val):
    sum_z = 0
    sum_w = 0
    if not np.isnan(erp_val):
        z = (erp_val - stats['erp']['mean']) / stats['erp']['std']
        sum_z += z * stats['erp']['weight']
        sum_w += stats['erp']['weight']
    if not np.isnan(buf_val):
        v = -buf_val
        z = (v - stats['buffett']['mean']) / stats['buffett']['std']
        sum_z += z * stats['buffett']['weight']
        sum_w += stats['buffett']['weight']
    if sum_w == 0: return np.nan
    z_avg = sum_z / sum_w
    return max(0, min(100, z_avg * 10 + 50))

ts = np.array([timing_score(erp[i], buf[i]) for i in range(n)])
valid = ~np.isnan(ts)
print(f"\nTiming Score 분포: 평균 {np.mean(ts[valid]):.1f}, std {np.std(ts[valid]):.1f}, "
      f"min {np.min(ts[valid]):.1f}, max {np.max(ts[valid]):.1f}, 유효 {valid.sum()}/{n}")

# ============================================================
# 2. Risk Signal 통계 (VIX + HY Spread)
# ============================================================
print("\n" + "="*90)
print("[2] Risk Signal: VIX & HY Spread 분포 percentile")
print("    → 별도 뱃지로 표시: normal / elevated / high / extreme")
print("="*90)

vix = np.array([d['vix'] if d['vix'] is not None else np.nan for d in raw], dtype=float)
hy  = np.array([d['hy_spread'] if d['hy_spread'] is not None else np.nan for d in raw], dtype=float)

for name, arr in [('VIX', vix), ('HY Spread', hy)]:
    v = arr[~np.isnan(arr)]
    pcts = [50, 70, 85, 95]
    print(f"\n{name}: median={np.median(v):.2f}, p70={np.percentile(v, 70):.2f}, "
          f"p85={np.percentile(v, 85):.2f}, p95={np.percentile(v, 95):.2f}, "
          f"max={np.max(v):.2f}")

print("\n→ 임계값 제안:")
print(f"  VIX:  normal<{np.percentile(vix[~np.isnan(vix)], 70):.1f}, "
      f"elevated<{np.percentile(vix[~np.isnan(vix)], 85):.1f}, "
      f"high<{np.percentile(vix[~np.isnan(vix)], 95):.1f}, "
      f"extreme≥{np.percentile(vix[~np.isnan(vix)], 95):.1f}")
print(f"  HY:   normal<{np.percentile(hy[~np.isnan(hy)], 70):.2f}, "
      f"elevated<{np.percentile(hy[~np.isnan(hy)], 85):.2f}, "
      f"high<{np.percentile(hy[~np.isnan(hy)], 95):.2f}, "
      f"extreme≥{np.percentile(hy[~np.isnan(hy)], 95):.2f}")

# ============================================================
# 3. Timing Score 구간별 hit rate (stance probability 재산출)
# ============================================================
print("\n" + "="*90)
print("[3] Timing Score 구간별 실제 forward return")
print("    → getStanceProbability() 의 실제 데이터 기반 재산출")
print("="*90)

ranges = [
    ('aggressive_plus',     60, 101, '매수 적기'),
    ('aggressive',          55, 60,  '매수 우위'),
    ('moderate_aggressive', 50, 55,  '소폭 매수'),
    ('neutral',             45, 50,  '중립'),
    ('moderate_defensive',  41, 45,  '소폭 방어'),
    ('defensive',           0,  41,  '방어 우위'),
]

for h_label, r in [('4주', ret_4w), ('12주', ret_12w), ('6개월', ret_6m), ('12개월', ret_12m)]:
    print(f"\n--- {h_label} forward return ---")
    print(f"{'stance':<24}{'점수구간':<10}{'n':>6}{'hit%':>8}{'avgUp%':>9}{'avgDn%':>9}{'avg%':>8}")
    for key, lo, hi, label in ranges:
        m = (~np.isnan(ts)) & (~np.isnan(r)) & (ts >= lo) & (ts < hi)
        if m.sum() < 5:
            print(f"  {key:<22}{lo}-{hi:<8}{m.sum():>6}  데이터 부족")
            continue
        rr = r[m] * 100
        up = rr[rr > 0]
        dn = rr[rr <= 0]
        hit = len(up) / len(rr) * 100
        avg_up = np.mean(up) if len(up) else 0
        avg_dn = np.mean(dn) if len(dn) else 0
        avg = np.mean(rr)
        print(f"  {key:<22}{lo}-{hi:<8}{m.sum():>6}{hit:>7.1f}%{avg_up:>8.2f}%{avg_dn:>8.2f}%{avg:>7.2f}%")

# ============================================================
# 4. TypeScript용 코드 출력
# ============================================================
print("\n" + "="*90)
print("[4] TypeScript용 상수")
print("="*90)
print("""
// 투자 타이밍 점수 통계 (1996~2026, 30년 데이터)
// Z-score 기반: (현재값 - mean) / std
// invert=true 지표는 부호 반전 후 계산
export const TIMING_INDICATOR_STATS = {""")
for k, s in stats.items():
    name = {'erp': 'ERP', 'buffett': 'Buffett'}[k]
    print(f"  '{name}': {{ mean: {s['mean']:.4f}, std: {s['std']:.4f}, invert: {str(s['invert']).lower()}, weight: {s['weight']:.4f} }},")
print("}")

print("""
// 리스크 신호 threshold (분포 percentile 기반)
export const RISK_SIGNAL_THRESHOLDS = {""")
for name, arr in [('vix', vix), ('hySpread', hy)]:
    v = arr[~np.isnan(arr)]
    p70, p85, p95 = np.percentile(v, [70, 85, 95])
    print(f"  {name}: {{ elevated: {p70:.2f}, high: {p85:.2f}, extreme: {p95:.2f} }},")
print("}")
