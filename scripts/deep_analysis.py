#!/usr/bin/env python3
"""
타이밍 적합성 깊은 분석 v2

이전 분석의 함정:
- Long-run mean/std → regime change 무시 (Buffett 110% → 185%)
- Pearson 상관 → 극단 신호 vs 평균 신호 구분 못함
- Hit rate → 크기 무시
- 한 시기(GFC) 시그널이 전체 backtest를 inflate

이번 분석의 원칙:
1. **Regime-aware transformation**: rolling 5y/10y percentile + rolling z-score
2. **Magnitude metric**: 분위별 E[r], Sharpe, avg downside, max drawdown when invested
3. **Sub-period robustness**: top-bottom quintile E[r] gap이 시기별로 일관되는가
4. **신규 feature**: SPY 52w/all-time drawdown (이미 있는 spy_price로 계산)
5. **다중 horizon**: 3m / 6m / 12m / 24m
"""

import json
import numpy as np
from pathlib import Path

with open("/tmp/market_data_full.json") as f:
    raw = json.load(f)

n = len(raw)
dates = np.array([d['date'] for d in raw])
date64 = np.array(dates, dtype='datetime64[D]')
spy = np.array([d['spy_price'] if d['spy_price'] is not None else np.nan for d in raw], dtype=float)

print(f"기간: {dates[0]} ~ {dates[-1]}, n={n}")

# ============================================================
# Forward returns (multiple horizons)
# ============================================================
def fwd_ret(prices, lag):
    out = np.full(len(prices), np.nan)
    for i in range(len(prices) - lag):
        if prices[i] and prices[i] > 0 and not np.isnan(prices[i+lag]):
            out[i] = prices[i + lag] / prices[i] - 1
    return out

# 데이터는 주간(weekly) 단위라고 가정 (1726 rows / 30년 ≈ 57.5/yr)
# 더 정확히는 평균 약 57.5 rows/yr 인데, 데이터 보면 영업일이 아니라 weekly close 인 듯
# 1m=4, 3m=13, 6m=26, 12m=52, 24m=104
HORIZONS = {'3m': 13, '6m': 26, '12m': 52, '24m': 104}
returns = {h: fwd_ret(spy, lag) for h, lag in HORIZONS.items()}

# Forward path stats (max drawdown during holding period)
def fwd_max_dd(prices, lag):
    """투자 후 lag 기간 동안 겪는 최대 낙폭"""
    out = np.full(len(prices), np.nan)
    for i in range(len(prices) - lag):
        if prices[i] and prices[i] > 0:
            path = prices[i:i+lag+1]
            if np.any(np.isnan(path)): continue
            running_max = np.maximum.accumulate(path)
            dd = (path - running_max) / running_max
            out[i] = np.min(dd)
    return out

# 12m max drawdown 만 사용 (계산 무거움)
maxdd_12m = fwd_max_dd(spy, 52)

# ============================================================
# 신규 feature: SPY 자체 기반 (regime-free)
# ============================================================
def rolling_drawdown(prices, window):
    """현재가 / 최근 window 기간 최고가 - 1"""
    out = np.full(len(prices), np.nan)
    for i in range(window, len(prices)):
        win = prices[i-window:i+1]
        if np.all(np.isnan(win)): continue
        peak = np.nanmax(win)
        if peak and peak > 0 and not np.isnan(prices[i]):
            out[i] = prices[i] / peak - 1
    return out

def rolling_drawdown_all(prices):
    """현재가 / 전 기간 ATH - 1"""
    out = np.full(len(prices), np.nan)
    for i in range(len(prices)):
        if i < 26: continue
        peak = np.nanmax(prices[:i+1])
        if peak and peak > 0 and not np.isnan(prices[i]):
            out[i] = prices[i] / peak - 1
    return out

drawdown_52w = rolling_drawdown(spy, 52)
drawdown_ath = rolling_drawdown_all(spy)

# ============================================================
# Rolling transformations for existing indicators
# ============================================================
def rolling_percentile(values, window):
    """각 시점 i에서 직전 window 기간 분포의 percentile (0~1)"""
    out = np.full(len(values), np.nan)
    for i in range(window, len(values)):
        win = values[i-window:i]
        win_valid = win[~np.isnan(win)]
        if len(win_valid) < window * 0.5: continue
        if np.isnan(values[i]): continue
        out[i] = np.sum(win_valid <= values[i]) / len(win_valid)
    return out

def rolling_zscore(values, window):
    """직전 window 기간 mean/std 기반 z-score"""
    out = np.full(len(values), np.nan)
    for i in range(window, len(values)):
        win = values[i-window:i]
        win_valid = win[~np.isnan(win)]
        if len(win_valid) < window * 0.5: continue
        mu, sigma = np.mean(win_valid), np.std(win_valid)
        if sigma == 0 or np.isnan(values[i]): continue
        out[i] = (values[i] - mu) / sigma
    return out

# 11 후보 + 2 신규 = 13개 feature
# 방향: invert=True 면 "낮을수록 매력" → 부호 반전해서 "높을수록 매력" 통일
indicators = {
    'fear_greed':            {'invert': True,  'label': 'Fear&Greed'},
    'vix':                   {'invert': False, 'label': 'VIX'},
    'spy_vs_200ma':          {'invert': True,  'label': 'S&P200MA'},
    'buffett_indicator':     {'invert': True,  'label': 'Buffett'},
    'fed_balance_sheet_yoy': {'invert': True,  'label': 'FedBS'},
    'm2_growth_yoy':         {'invert': True,  'label': 'M2'},
    'hy_spread':             {'invert': False, 'label': 'HY'},
    'yield_curve_10y2y':     {'invert': False, 'label': 'YC2Y'},
    'yield_curve_10y3m':     {'invert': False, 'label': 'YC3M'},
    'initial_claims':        {'invert': False, 'label': 'Claims'},
    'erp':                   {'invert': False, 'label': 'ERP'},
}

# 신규 feature 추가 (drawdown은 낮을수록(더 큰 낙폭일수록) 매력 → invert=True)
new_features = {
    'drawdown_52w': drawdown_52w,
    'drawdown_ath': drawdown_ath,
}

# Feature array 생성 (방향 통일 후)
feature_arrays = {}
for k, cfg in indicators.items():
    arr = np.array([d[k] if d[k] is not None else np.nan for d in raw], dtype=float)
    if cfg['invert']: arr = -arr
    feature_arrays[k] = (cfg['label'], arr)

for k, arr in new_features.items():
    # drawdown은 음수값. 낮을수록(=더 큰 낙폭) 매력 → invert
    feature_arrays[k] = (k.replace('_', ' '), -arr)

WIN_10Y = 52 * 10  # 520 weeks
WIN_5Y = 52 * 5    # 260 weeks

# ============================================================
# 평가 함수: 분위별 E[r], Sharpe, downside
# ============================================================
def quintile_stats(feat, ret, dd=None):
    """5분위로 나눠 각 quintile 의 평균 수익률, 표준편차, Sharpe, 평균 drawdown"""
    m = ~(np.isnan(feat) | np.isnan(ret))
    if m.sum() < 100: return None
    f, r = feat[m], ret[m]
    d = dd[m] if dd is not None else None
    qs = np.quantile(f, [0.2, 0.4, 0.6, 0.8])
    buckets = np.digitize(f, qs)
    stats = []
    for i in range(5):
        mask = buckets == i
        if mask.sum() < 5:
            stats.append(None); continue
        rr = r[mask]
        mean_r = np.mean(rr)
        std_r = np.std(rr)
        sharpe = mean_r / std_r if std_r > 0 else 0
        down = np.mean(rr[rr < 0]) if (rr < 0).any() else 0
        max_dd = np.mean(d[mask]) if d is not None else None
        stats.append({
            'mean': mean_r, 'std': std_r, 'sharpe': sharpe,
            'avg_down': down, 'avg_maxdd': max_dd, 'n': mask.sum()
        })
    return stats

def evaluate_feature(name, feat, transform_label='raw'):
    """6m, 12m forward return으로 평가"""
    results = {}
    for h in ['6m', '12m']:
        st = quintile_stats(feat, returns[h], maxdd_12m if h == '12m' else None)
        if st is None: continue
        results[h] = st
    return results

# ============================================================
# Sub-period robustness
# ============================================================
splits = [
    ('Era1 1996-2007', (date64 >= np.datetime64('1996-01-01')) & (date64 < np.datetime64('2008-01-01'))),
    ('Era2 2008-2015', (date64 >= np.datetime64('2008-01-01')) & (date64 < np.datetime64('2016-01-01'))),
    ('Era3 2016-2026', date64 >= np.datetime64('2016-01-01')),
]

def subperiod_top_bot_gap(feat, ret, masks):
    """각 sub-period에서 top quintile E[r] - bot quintile E[r]"""
    gaps = []
    for label, m in masks:
        f_p = feat[m]; r_p = ret[m]
        mm = ~(np.isnan(f_p) | np.isnan(r_p))
        if mm.sum() < 80:
            gaps.append((label, None)); continue
        f, r = f_p[mm], r_p[mm]
        try:
            q20, q80 = np.quantile(f, [0.2, 0.8])
        except: gaps.append((label, None)); continue
        bot = r[f <= q20]; top = r[f >= q80]
        if len(bot) < 5 or len(top) < 5:
            gaps.append((label, None)); continue
        gaps.append((label, np.mean(top) - np.mean(bot)))
    return gaps

# ============================================================
# 평가 실행: raw / rolling_10y_percentile / rolling_10y_zscore 3가지 transform
# ============================================================
print("\n" + "="*120)
print(f"{'Feature':<14}{'Transform':<14}{'h':<5}{'Q1':>8}{'Q2':>8}{'Q3':>8}{'Q4':>8}{'Q5':>8}{'Q5-Q1':>9}{'Q5_Sharpe':>10}{'Q5_maxDD':>10}{'Mono':>6}")
print("="*120)

transforms = {
    'raw': lambda arr: arr,
    'p10y': lambda arr: rolling_percentile(arr, WIN_10Y),
    'z10y': lambda arr: rolling_zscore(arr, WIN_10Y),
}

# 결과 저장
best_features = []

for fname, (label, arr) in feature_arrays.items():
    for tname, tfunc in transforms.items():
        try:
            tarr = tfunc(arr)
        except Exception:
            continue

        # 12m horizon만 정밀 출력
        st12 = quintile_stats(tarr, returns['12m'], maxdd_12m)
        if st12 is None or any(s is None for s in st12): continue
        means_12 = [s['mean']*100 for s in st12]
        spread_12 = means_12[4] - means_12[0]
        sharpe_top = st12[4]['sharpe']
        maxdd_top = st12[4]['avg_maxdd']*100 if st12[4]['avg_maxdd'] is not None else None
        diffs = np.diff(means_12)
        mono = sum(1 for d in diffs if d > 0)

        # robustness check
        gaps = subperiod_top_bot_gap(tarr, returns['12m'], splits)
        all_positive = all(g[1] is not None and g[1] > 0 for g in gaps)

        # 출력
        means_str = "".join(f"{x:>8.2f}" for x in means_12)
        maxdd_str = f"{maxdd_top:>9.1f}%" if maxdd_top is not None else f"{'N/A':>10}"
        flag = '★' if all_positive and spread_12 > 5 and sharpe_top > 0.4 else ''
        print(f"{label:<14}{tname:<14}{'12m':<5}{means_str}{spread_12:>9.2f}{sharpe_top:>10.2f}{maxdd_str}{mono:>5}/4 {flag}")

        if all_positive and spread_12 > 5:
            best_features.append({
                'feature': label, 'transform': tname,
                'spread_12m': spread_12, 'sharpe_top': sharpe_top,
                'maxdd_top': maxdd_top, 'mono': mono,
                'subperiod_gaps': gaps,
            })

# ============================================================
# Sub-period 상세
# ============================================================
print("\n" + "="*100)
print("[Sub-period robustness 상세] Top20-Bot20 E[12m return] gap")
print("="*100)
print(f"{'Feature':<14}{'Transform':<14}{'1996-2007':>14}{'2008-2015':>14}{'2016-2026':>14}{'Min gap':>10}{'Pos all':>8}")
print("-"*100)

for fname, (label, arr) in feature_arrays.items():
    for tname, tfunc in transforms.items():
        try: tarr = tfunc(arr)
        except: continue
        gaps = subperiod_top_bot_gap(tarr, returns['12m'], splits)
        gap_vals = [g[1] for g in gaps if g[1] is not None]
        if len(gap_vals) < 3: continue
        min_gap = min(gap_vals)
        all_pos = all(g > 0 for g in gap_vals)
        if min_gap > 0.02 or all_pos:  # 최소 +2% 이상
            gaps_str = "".join(f"{g[1]*100:>13.1f}%" if g[1] is not None else f"{'N/A':>14}" for g in gaps)
            flag = '★' if all_pos and min_gap > 0.03 else ''
            print(f"{label:<14}{tname:<14}{gaps_str}{min_gap*100:>9.1f}%{str(all_pos):>8} {flag}")

# ============================================================
# 최고 후보 요약
# ============================================================
print("\n" + "="*100)
print("[★ 최종 후보 — sub-period 모두 양수 + spread > 5% + Sharpe > 0.4]")
print("="*100)
best_features.sort(key=lambda x: -x['sharpe_top'])
for b in best_features[:15]:
    if b['sharpe_top'] > 0.4:
        gaps_str = " / ".join(f"{g[1]*100:+.1f}%" if g[1] is not None else 'N/A' for g in b['subperiod_gaps'])
        print(f"  {b['feature']:<14} {b['transform']:<7} spread={b['spread_12m']:>5.1f}% Sharpe={b['sharpe_top']:.2f} maxDD={b['maxdd_top']:>5.1f}% periods={gaps_str}")

# ============================================================
# 정직한 비교: 지금 ERP+Buffett 옛 결과랑 비교
# ============================================================
print("\n" + "="*100)
print("[현재 모델 진단: 옛 ERP+Buffett raw 점수 결과]")
print("="*100)
def old_score(erp, buf):
    if erp is None or buf is None: return np.nan
    z_e = (erp - 3.4617) / 2.8473
    z_b = (-buf - (-139.3095)) / 45.1758
    return (z_e * 0.6673 + z_b * 0.3327) * 10 + 50

old_arr = np.array([old_score(d['erp'], d['buffett_indicator']) for d in raw])
gaps = subperiod_top_bot_gap(old_arr, returns['12m'], splits)
print(f"  ERP+Buffett raw z-score, 12m gap:")
for label, gap in gaps:
    print(f"    {label}: {gap*100:+.1f}%" if gap is not None else f"    {label}: N/A")

# 또한 score 분포: 시기별
print(f"\n  ERP+Buffett raw 점수 분포 (시기별 평균/std/60+빈도):")
for label, m in splits:
    s = old_arr[m]; s = s[~np.isnan(s)]
    over60 = (s >= 60).sum() / len(s) * 100 if len(s) > 0 else 0
    print(f"    {label}: mean={np.mean(s):.1f}, std={np.std(s):.1f}, max={np.max(s):.1f}, 60+ {over60:.1f}%")
