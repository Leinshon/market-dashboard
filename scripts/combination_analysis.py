#!/usr/bin/env python3
"""
Multi-factor 조합 분석.

baseline: drawdown_ath p10y 단일 (Sharpe 1.43, 10.9% spread)

테스트할 조합:
1. drawdown + ERP (둘 다 p10y, 50/50)
2. drawdown + ERP + Buffett (모두 p10y, 33/33/33)
3. drawdown + valuation (ERP+Buffett 평균) 70/30
4. drawdown + valuation 50/50
5. drawdown + ERP (rolling z-score 사용)
6. drawdown + ERP raw 정규화 (어떤 형태가 best인지)
7. weighted by individual Sharpe
8. drawdown + VIX p10y 같은 sentiment 조합

평가 기준:
- 12m Sharpe (높을수록 좋음)
- 12m Top-Bot quintile spread
- Sub-period 모두 양수 spread (robust)
- 1년 hit rate top quintile
- 10년 CAGR top quintile
- Drawdown alone 대비 alpha
"""

import json
import numpy as np

with open("/tmp/market_data_full.json") as f:
    raw = json.load(f)

n = len(raw)
dates = [d['date'] for d in raw]
date64 = np.array(dates, dtype='datetime64[D]')
spy = np.array([d['spy_price'] if d['spy_price'] is not None else np.nan for d in raw], dtype=float)

def fwd_ret(prices, lag):
    out = np.full(len(prices), np.nan)
    for i in range(len(prices) - lag):
        if prices[i] and prices[i] > 0 and not np.isnan(prices[i+lag]):
            out[i] = prices[i + lag] / prices[i] - 1
    return out

returns_1y = fwd_ret(spy, 52)
returns_3y = fwd_ret(spy, 156)
returns_10y = fwd_ret(spy, 520)
returns_12m = fwd_ret(spy, 52)

# ============================================================
# Feature 구성
# ============================================================

# drawdown_ath
def drawdown_ath(prices):
    out = np.full(len(prices), np.nan)
    for i in range(len(prices)):
        if i < 26: continue
        peak = np.nanmax(prices[:i+1])
        if peak and peak > 0 and not np.isnan(prices[i]):
            out[i] = prices[i] / peak - 1
    return out

WIN = 520  # 10y

def rolling_percentile(values, w):
    out = np.full(len(values), np.nan)
    for i in range(w, len(values)):
        win = values[i-w:i]
        win = win[~np.isnan(win)]
        if len(win) < w * 0.5 or np.isnan(values[i]): continue
        out[i] = np.sum(win <= values[i]) / len(win)
    return out * 100

def rolling_zscore(values, w):
    out = np.full(len(values), np.nan)
    for i in range(w, len(values)):
        win = values[i-w:i]
        win = win[~np.isnan(win)]
        if len(win) < w * 0.5 or np.isnan(values[i]): continue
        mu, sd = np.mean(win), np.std(win)
        if sd == 0: continue
        out[i] = (values[i] - mu) / sd
    return out

# 시계열 추출
def get_arr(field, invert=False):
    arr = np.array([d[field] if d[field] is not None else np.nan for d in raw], dtype=float)
    return -arr if invert else arr

dd_ath = drawdown_ath(spy)
dd_p10y = rolling_percentile(-dd_ath, WIN)

erp = get_arr('erp')
erp_p10y = rolling_percentile(erp, WIN)
erp_z10y = rolling_zscore(erp, WIN)
# raw ERP은 0-100 scale에 맞추려면 별도 정규화 필요. 그냥 raw도 시도.

buf = get_arr('buffett_indicator', invert=True)  # higher Buffett = expensive → invert
buf_p10y = rolling_percentile(buf, WIN)
buf_z10y = rolling_zscore(buf, WIN)

vix = get_arr('vix')
vix_p10y = rolling_percentile(vix, WIN)

hy = get_arr('hy_spread')
hy_p10y = rolling_percentile(hy, WIN)

# ============================================================
# 평가 함수
# ============================================================

def evaluate(score, label):
    """단일 score series 평가. 12m Sharpe / spread / sub-period robustness"""
    if score is None: return None
    r = returns_12m
    mask = ~(np.isnan(score) | np.isnan(r))
    if mask.sum() < 100: return None
    s, rr = score[mask], r[mask]

    # 분위별 평균 + Sharpe
    qs = np.quantile(s, [0.2, 0.4, 0.6, 0.8])
    buckets = np.digitize(s, qs)
    bucket_stats = []
    for i in range(5):
        m = buckets == i
        if m.sum() < 5: bucket_stats.append({'mean': 0, 'sharpe': 0, 'n': 0}); continue
        b_r = rr[m]
        bucket_stats.append({
            'mean': np.mean(b_r),
            'sharpe': np.mean(b_r) / np.std(b_r) if np.std(b_r) > 0 else 0,
            'n': len(b_r)
        })

    spread = bucket_stats[4]['mean'] - bucket_stats[0]['mean']
    sharpe_top = bucket_stats[4]['sharpe']

    # Sub-period robustness
    splits = [
        ('Era1', (date64 >= np.datetime64('1996-01-01')) & (date64 < np.datetime64('2008-01-01'))),
        ('Era2', (date64 >= np.datetime64('2008-01-01')) & (date64 < np.datetime64('2016-01-01'))),
        ('Era3', date64 >= np.datetime64('2016-01-01')),
    ]
    sub_gaps = []
    for _, m_split in splits:
        s_p = score[m_split]; r_p = returns_12m[m_split]
        mm = ~(np.isnan(s_p) | np.isnan(r_p))
        if mm.sum() < 80:
            sub_gaps.append(None); continue
        s_v, r_v = s_p[mm], r_p[mm]
        try:
            q20, q80 = np.quantile(s_v, [0.2, 0.8])
        except: sub_gaps.append(None); continue
        top = r_v[s_v >= q80]; bot = r_v[s_v <= q20]
        if len(top) < 5 or len(bot) < 5: sub_gaps.append(None); continue
        sub_gaps.append(np.mean(top) - np.mean(bot))

    sub_all_positive = all(g is not None and g > 0 for g in sub_gaps)
    min_sub_gap = min((g for g in sub_gaps if g is not None), default=None)

    # Top 20% 1y / 10y 평균
    s_full = score[~np.isnan(score)]
    if len(s_full) == 0: return None
    q80_full = np.quantile(s_full, 0.8)

    top_1y_mask = (~np.isnan(score)) & (~np.isnan(returns_1y)) & (score >= q80_full)
    top_1y_mean = np.mean(returns_1y[top_1y_mask]) if top_1y_mask.sum() > 0 else 0
    top_1y_hit = np.mean(returns_1y[top_1y_mask] > 0) * 100 if top_1y_mask.sum() > 0 else 0

    top_10y_mask = (~np.isnan(score)) & (~np.isnan(returns_10y)) & (score >= q80_full)
    if top_10y_mask.sum() > 0:
        top_10y_cagr = np.mean((1 + returns_10y[top_10y_mask]) ** (1/10) - 1) * 100
        top_10y_hit = np.mean(returns_10y[top_10y_mask] > 0) * 100
    else:
        top_10y_cagr = 0; top_10y_hit = 0

    return {
        'label': label,
        'spread': spread * 100,
        'sharpe_top': sharpe_top,
        'sub_gaps': [(g*100 if g is not None else None) for g in sub_gaps],
        'sub_all_pos': sub_all_positive,
        'min_sub_gap': min_sub_gap*100 if min_sub_gap is not None else None,
        'top_1y_mean': top_1y_mean*100,
        'top_1y_hit': top_1y_hit,
        'top_10y_cagr': top_10y_cagr,
        'top_10y_hit': top_10y_hit,
        'quintile_means': [b['mean']*100 for b in bucket_stats],
    }

# ============================================================
# 결합 score 생성
# ============================================================

def weighted_combine(features_and_weights):
    """[(score_array, weight), ...]. NaN 처리: 모두 valid한 시점만 산출"""
    n_pts = len(features_and_weights[0][0])
    out = np.full(n_pts, np.nan)
    for i in range(n_pts):
        s = 0.0
        w = 0.0
        all_valid = True
        for arr, wt in features_and_weights:
            if np.isnan(arr[i]):
                all_valid = False
                break
            s += arr[i] * wt
            w += wt
        if all_valid and w > 0:
            out[i] = s / w
    return out

# 후보 모델들
candidates = {
    '[baseline] drawdown only':           dd_p10y,
    'drawdown + ERP (p10y, 50/50)':       weighted_combine([(dd_p10y, 0.5), (erp_p10y, 0.5)]),
    'drawdown + ERP (p10y, 70/30)':       weighted_combine([(dd_p10y, 0.7), (erp_p10y, 0.3)]),
    'drawdown + Buffett (p10y, 50/50)':   weighted_combine([(dd_p10y, 0.5), (buf_p10y, 0.5)]),
    'drawdown + Buffett (p10y, 70/30)':   weighted_combine([(dd_p10y, 0.7), (buf_p10y, 0.3)]),
    'drawdown + ERP + Buffett (33/33/33)':weighted_combine([(dd_p10y, 1/3), (erp_p10y, 1/3), (buf_p10y, 1/3)]),
    'drawdown + ERP + Buffett (60/20/20)':weighted_combine([(dd_p10y, 0.6), (erp_p10y, 0.2), (buf_p10y, 0.2)]),
    'drawdown + ERP + Buffett (50/25/25)':weighted_combine([(dd_p10y, 0.5), (erp_p10y, 0.25), (buf_p10y, 0.25)]),
    'drawdown + VIX (p10y, 70/30)':       weighted_combine([(dd_p10y, 0.7), (vix_p10y, 0.3)]),
    'drawdown + HY (p10y, 70/30)':        weighted_combine([(dd_p10y, 0.7), (hy_p10y, 0.3)]),
    'drawdown + Val+VIX (50/30/20)':      weighted_combine([(dd_p10y, 0.5), ((erp_p10y+buf_p10y)/2, 0.3), (vix_p10y, 0.2)]),
    'drawdown + Val+VIX+HY (40/30/15/15)':weighted_combine([(dd_p10y, 0.4), ((erp_p10y+buf_p10y)/2, 0.3), (vix_p10y, 0.15), (hy_p10y, 0.15)]),
    'drawdown + Val (50/50)':             weighted_combine([(dd_p10y, 0.5), ((erp_p10y+buf_p10y)/2, 0.5)]),
    'drawdown + Val (70/30)':             weighted_combine([(dd_p10y, 0.7), ((erp_p10y+buf_p10y)/2, 0.3)]),
}

# ============================================================
# 평가 + 출력
# ============================================================

print("="*130)
print(f"{'Model':<48}{'Sharpe':>8}{'Spread':>10}{'Era1':>10}{'Era2':>10}{'Era3':>10}{'AllPos':>8}{'1y Avg':>8}{'10y CAGR':>10}")
print("="*130)

results = []
for label, score_arr in candidates.items():
    r = evaluate(score_arr, label)
    if r is None:
        print(f"{label:<48} (eval failed)")
        continue
    results.append(r)
    g1 = f"{r['sub_gaps'][0]:+5.1f}%" if r['sub_gaps'][0] is not None else 'N/A'
    g2 = f"{r['sub_gaps'][1]:+5.1f}%" if r['sub_gaps'][1] is not None else 'N/A'
    g3 = f"{r['sub_gaps'][2]:+5.1f}%" if r['sub_gaps'][2] is not None else 'N/A'
    pos = '★' if r['sub_all_pos'] else ''
    print(f"{label:<48}{r['sharpe_top']:>8.2f}{r['spread']:>9.2f}%{g1:>10}{g2:>10}{g3:>10}{pos:>8}{r['top_1y_mean']:>7.1f}%{r['top_10y_cagr']:>9.2f}%")

# baseline 대비 alpha
print("\n" + "="*100)
print("[Baseline (drawdown only) 대비 개선분]")
print("="*100)
baseline = next(r for r in results if 'baseline' in r['label'])
print(f"{'Model':<48}{'ΔSharpe':>10}{'ΔSpread':>10}{'Δ1y':>8}{'Δ10y CAGR':>12}")
print("-"*100)
for r in results:
    if 'baseline' in r['label']: continue
    d_sharpe = r['sharpe_top'] - baseline['sharpe_top']
    d_spread = r['spread'] - baseline['spread']
    d_1y = r['top_1y_mean'] - baseline['top_1y_mean']
    d_10y = r['top_10y_cagr'] - baseline['top_10y_cagr']
    print(f"{r['label']:<48}{d_sharpe:>+10.2f}{d_spread:>+9.2f}%{d_1y:>+7.1f}%{d_10y:>+11.2f}%")

# 최고 성과 5개
print("\n" + "="*100)
print("[Sharpe 기준 Top 5]")
print("="*100)
for r in sorted(results, key=lambda x: -x['sharpe_top'])[:6]:
    print(f"  {r['label']:<48} Sharpe {r['sharpe_top']:.2f}, spread {r['spread']:.1f}%, 10y CAGR {r['top_10y_cagr']:.1f}%, sub-pos {r['sub_all_pos']}")
