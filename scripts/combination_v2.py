#!/usr/bin/env python3
"""
신규 데이터 (SPY volume, VIX9D, VIX3M, HYG, LQD) 포함 multi-factor 분석.

baseline: drawdown_ath p10y (Sharpe 1.43, spread 10.9%)

신규 feature 후보:
- volume_spike: spy_volume / 1년 평균 (panic capitulation)
- vix_term: VIX9D / VIX3M (백워데이션 = 단기 패닉)
- vix9d_p5y: VIX9D rolling 5y percentile
- hyg_drawdown: HYG ATH 대비 drawdown p10y (credit panic)
- hyg_lqd_ratio: HYG/LQD (risk-on 정도)

평가:
1. 각 신규 feature 단독 성능
2. drawdown_ath와 결합 시 alpha
3. 최종 best combination 선정
"""

import json
import numpy as np

with open('/tmp/market_data_enhanced.json') as f:
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

returns_12m = fwd_ret(spy, 52)
returns_1y = returns_12m
returns_10y = fwd_ret(spy, 520)

# ============================================================
# Base features
# ============================================================
def drawdown_ath(prices):
    out = np.full(len(prices), np.nan)
    for i in range(len(prices)):
        if i < 26: continue
        peak = np.nanmax(prices[:i+1])
        if peak > 0 and not np.isnan(prices[i]):
            out[i] = prices[i] / peak - 1
    return out

WIN = 520
WIN5 = 260

def rolling_pct(values, w):
    out = np.full(len(values), np.nan)
    for i in range(w, len(values)):
        win = values[i-w:i]
        win = win[~np.isnan(win)]
        if len(win) < w * 0.5 or np.isnan(values[i]): continue
        out[i] = np.sum(win <= values[i]) / len(win)
    return out * 100

def get_arr(field, invert=False):
    arr = np.array([d.get(field) if d.get(field) is not None else np.nan for d in raw], dtype=float)
    return -arr if invert else arr

# Drawdown 기반
dd_ath = drawdown_ath(spy)
dd_p10y = rolling_pct(-dd_ath, WIN)

# 신규 feature
volume = get_arr('spy_volume_yh')
vix9d = get_arr('vix9d_yh')
vix3m = get_arr('vix3m_yh')
hyg = get_arr('hyg_yh')
lqd = get_arr('lqd_yh')

# Volume spike: 현재 거래량 / 직전 52주 평균 (높을수록 spike)
def rolling_mean(values, w):
    out = np.full(len(values), np.nan)
    for i in range(w, len(values)):
        win = values[i-w:i]
        win = win[~np.isnan(win)]
        if len(win) < w * 0.5: continue
        out[i] = np.mean(win)
    return out

vol_avg_52w = rolling_mean(volume, 52)
volume_spike = np.where(vol_avg_52w > 0, volume / vol_avg_52w, np.nan)
volume_spike_p10y = rolling_pct(volume_spike, WIN)

# VIX term structure: VIX9D / VIX3M. > 1 = 백워데이션 (단기 패닉)
vix_term_ratio = np.where(vix3m > 0, vix9d / vix3m, np.nan)
vix_term_p5y = rolling_pct(vix_term_ratio, WIN5)  # 5y window (데이터 짧음)

# VIX9D 자체 percentile (5y window, 데이터 짧으므로)
vix9d_p5y = rolling_pct(vix9d, WIN5)

# HYG drawdown (credit ETF가 빠질 때 = 신용 패닉)
hyg_dd = drawdown_ath(hyg)
hyg_dd_p5y = rolling_pct(-hyg_dd, WIN5)

# HYG / LQD ratio
hyg_lqd = np.where(lqd > 0, hyg / lqd, np.nan)
hyg_lqd_p5y_inv = rolling_pct(-hyg_lqd, WIN5)  # 낮을수록 risk-off = 매력?

# ============================================================
# 평가
# ============================================================

def evaluate(score, label):
    r = returns_12m
    mask = ~(np.isnan(score) | np.isnan(r))
    if mask.sum() < 80: return None
    s, rr = score[mask], r[mask]
    qs = np.quantile(s, [0.2, 0.4, 0.6, 0.8])
    buckets = np.digitize(s, qs)
    means = []
    sharpes = []
    for i in range(5):
        m = buckets == i
        if m.sum() < 5:
            means.append(0); sharpes.append(0); continue
        b_r = rr[m]
        means.append(np.mean(b_r))
        sharpes.append(np.mean(b_r) / np.std(b_r) if np.std(b_r) > 0 else 0)
    spread = means[4] - means[0]

    splits = [
        ('Era1', (date64 >= np.datetime64('1996-01-01')) & (date64 < np.datetime64('2008-01-01'))),
        ('Era2', (date64 >= np.datetime64('2008-01-01')) & (date64 < np.datetime64('2016-01-01'))),
        ('Era3', date64 >= np.datetime64('2016-01-01')),
    ]
    sub_gaps = []
    for _, m_split in splits:
        sp = score[m_split]; rp = returns_12m[m_split]
        mm = ~(np.isnan(sp) | np.isnan(rp))
        if mm.sum() < 50:
            sub_gaps.append(None); continue
        sv, rv = sp[mm], rp[mm]
        try:
            q20, q80 = np.quantile(sv, [0.2, 0.8])
            top = rv[sv >= q80]; bot = rv[sv <= q20]
            if len(top) < 5 or len(bot) < 5:
                sub_gaps.append(None); continue
            sub_gaps.append(np.mean(top) - np.mean(bot))
        except:
            sub_gaps.append(None)

    sub_all_pos = all(g is not None and g > 0 for g in sub_gaps)

    s_full = score[~np.isnan(score)]
    q80_full = np.quantile(s_full, 0.8)
    top10y = (~np.isnan(score)) & (~np.isnan(returns_10y)) & (score >= q80_full)
    cagr = np.mean((1 + returns_10y[top10y]) ** (1/10) - 1) * 100 if top10y.sum() > 0 else 0
    top1y = (~np.isnan(score)) & (~np.isnan(returns_1y)) & (score >= q80_full)
    top1y_avg = np.mean(returns_1y[top1y]) * 100 if top1y.sum() > 0 else 0

    return {
        'label': label,
        'sharpe_top': sharpes[4],
        'spread': spread * 100,
        'sub_gaps': [(g*100 if g is not None else None) for g in sub_gaps],
        'sub_all_pos': sub_all_pos,
        'top_1y': top1y_avg,
        'top_10y_cagr': cagr,
        'n_valid': mask.sum(),
    }

def weighted(*pairs):
    out = np.full(n, np.nan)
    for i in range(n):
        s = 0.0; w = 0.0; ok = True
        for arr, wt in pairs:
            if np.isnan(arr[i]):
                ok = False; break
            s += arr[i] * wt
            w += wt
        if ok and w > 0:
            out[i] = s / w
    return out

candidates = {
    '[baseline] drawdown only':                          dd_p10y,
    # 단독 신규 feature
    'volume_spike p10y (단독)':                          volume_spike_p10y,
    'VIX9D p5y (단독)':                                  vix9d_p5y,
    'VIX term ratio p5y (단독)':                         vix_term_p5y,
    'HYG drawdown p5y (단독)':                           hyg_dd_p5y,
    'HYG/LQD inverted p5y (단독)':                       hyg_lqd_p5y_inv,
    # drawdown 조합
    'drawdown + volume_spike (70/30)':                   weighted((dd_p10y, 0.7), (volume_spike_p10y, 0.3)),
    'drawdown + volume_spike (50/50)':                   weighted((dd_p10y, 0.5), (volume_spike_p10y, 0.5)),
    'drawdown + VIX9D (70/30)':                          weighted((dd_p10y, 0.7), (vix9d_p5y, 0.3)),
    'drawdown + VIX term (70/30)':                       weighted((dd_p10y, 0.7), (vix_term_p5y, 0.3)),
    'drawdown + HYG drawdown (70/30)':                   weighted((dd_p10y, 0.7), (hyg_dd_p5y, 0.3)),
    'drawdown + HYG drawdown (50/50)':                   weighted((dd_p10y, 0.5), (hyg_dd_p5y, 0.5)),
    'drawdown + volume + VIX (60/20/20)':                weighted((dd_p10y, 0.6), (volume_spike_p10y, 0.2), (vix9d_p5y, 0.2)),
    'drawdown + volume + HYG (60/20/20)':                weighted((dd_p10y, 0.6), (volume_spike_p10y, 0.2), (hyg_dd_p5y, 0.2)),
    'drawdown + volume + VIX + HYG (50/15/15/20)':       weighted((dd_p10y, 0.5), (volume_spike_p10y, 0.15), (vix9d_p5y, 0.15), (hyg_dd_p5y, 0.2)),
    'drawdown + HYG (60/40)':                            weighted((dd_p10y, 0.6), (hyg_dd_p5y, 0.4)),
    'drawdown + VIX term (60/40)':                       weighted((dd_p10y, 0.6), (vix_term_p5y, 0.4)),
}

print('='*135)
print(f"{'Model':<48}{'Sharpe':>8}{'Spread':>9}{'Era1':>9}{'Era2':>9}{'Era3':>9}{'AllPos':>8}{'1y%':>7}{'10y CAGR':>9}{'n':>7}")
print('='*135)
results = []
for label, score_arr in candidates.items():
    r = evaluate(score_arr, label)
    if r is None:
        print(f"{label:<48} (eval failed)")
        continue
    results.append(r)
    g1, g2, g3 = (f"{x:+5.1f}%" if x is not None else 'N/A' for x in r['sub_gaps'])
    pos = '★' if r['sub_all_pos'] else ''
    print(f"{r['label']:<48}{r['sharpe_top']:>8.2f}{r['spread']:>8.1f}%{g1:>9}{g2:>9}{g3:>9}{pos:>8}{r['top_1y']:>6.1f}%{r['top_10y_cagr']:>8.2f}%{r['n_valid']:>7}")

# Baseline 대비
print('\n' + '='*100)
print('[Baseline (drawdown only) 대비 개선분 — Sharpe 기준 정렬]')
print('='*100)
baseline = next(r for r in results if 'baseline' in r['label'])
print(f"{'Model':<48}{'ΔSharpe':>10}{'ΔSpread':>10}{'Δ1y':>8}{'Δ10y':>9}{'AllPos':>8}")
print('-'*100)
sorted_res = sorted(
    (r for r in results if 'baseline' not in r['label']),
    key=lambda x: -(x['sharpe_top'] - baseline['sharpe_top']),
)
for r in sorted_res:
    ds = r['sharpe_top'] - baseline['sharpe_top']
    dsp = r['spread'] - baseline['spread']
    d1y = r['top_1y'] - baseline['top_1y']
    d10y = r['top_10y_cagr'] - baseline['top_10y_cagr']
    pos = '★' if r['sub_all_pos'] else ''
    marker = '✓' if ds > 0 and dsp > 0 else ''
    print(f"{r['label']:<48}{ds:>+10.2f}{dsp:>+9.1f}%{d1y:>+7.1f}%{d10y:>+8.2f}%{pos:>8} {marker}")
