#!/usr/bin/env python3
"""
투자 타이밍 적합성 관점의 robust 분석.

기존 calculate_weights.py는:
- 단순 Pearson 상관계수 (right-skew에 취약)
- 4주/12주 only (timing 의사결정 horizon에 비해 짧음)
- in-sample 전체 fit (regime 변화에 취약)
- 지표를 독립적으로 평가 (joint 정보 무시)

이 스크립트는:
1. Pearson + Spearman, 1/3/6/12개월 horizon
2. 시기별 robustness (3개 sub-period + rolling)
3. 분위별 forward return (비선형/threshold 효과)
4. 극단 구간 hit rate (타이밍 판단의 핵심 지표)
5. 현재 composite의 점수 구간별 hit rate 검증
"""

import json
import numpy as np
from pathlib import Path
# numpy만으로 Spearman 구현 (scipy 의존 회피)
def _spearman(x, y):
    rx = np.argsort(np.argsort(x))
    ry = np.argsort(np.argsort(y))
    return np.corrcoef(rx, ry)[0, 1]

data_path = Path("/tmp/market_data_full.json")
with open(data_path, 'r') as f:
    raw = json.load(f)

n = len(raw)
dates = np.array([d['date'] for d in raw])
spy = np.array([d['spy_price'] if d['spy_price'] is not None else np.nan for d in raw], dtype=float)

# 영업주(weekly) 단위라고 가정 -> 1m=4, 3m=13, 6m=26, 12m=52
HORIZONS = {'1m': 4, '3m': 13, '6m': 26, '12m': 52}

def fwd_ret(prices, lag):
    out = np.full(len(prices), np.nan)
    for i in range(len(prices) - lag):
        if prices[i] and prices[i] > 0 and not np.isnan(prices[i+lag]):
            out[i] = prices[i + lag] / prices[i] - 1
    return out

returns = {h: fwd_ret(spy, lag) for h, lag in HORIZONS.items()}

# "높을수록 미래수익률 높다" 방향으로 통일하기 위한 invert 매핑
indicators_config = {
    'fear_greed':             {'invert': True,  'label': 'Fear & Greed'},
    'vix':                    {'invert': False, 'label': 'VIX'},
    'spy_vs_200ma':           {'invert': True,  'label': 'S&P vs 200MA'},
    'buffett_indicator':      {'invert': True,  'label': 'Buffett'},
    'fed_balance_sheet_yoy':  {'invert': True,  'label': 'Fed BS YoY'},
    'm2_growth_yoy':          {'invert': True,  'label': 'M2 YoY'},
    'hy_spread':              {'invert': False, 'label': 'HY Spread'},
    'yield_curve_10y2y':      {'invert': False, 'label': 'YC 10Y-2Y'},
    'yield_curve_10y3m':      {'invert': False, 'label': 'YC 10Y-3M'},
    'initial_claims':         {'invert': False, 'label': 'Init Claims'},
    'erp':                    {'invert': False, 'label': 'ERP'},
}

# 각 지표 값 추출 + invert 적용 ("high = bullish for forward returns" 방향)
ind_values = {}
for k, cfg in indicators_config.items():
    arr = np.array([d[k] if d[k] is not None else np.nan for d in raw], dtype=float)
    ind_values[k] = -arr if cfg['invert'] else arr

def safe_corr(x, y, method='pearson'):
    m = ~(np.isnan(x) | np.isnan(y))
    if m.sum() < 50: return np.nan
    xv, yv = x[m], y[m]
    if np.std(xv) == 0 or np.std(yv) == 0: return np.nan
    if method == 'pearson':
        return np.corrcoef(xv, yv)[0, 1]
    elif method == 'spearman':
        return _spearman(xv, yv)

# ============================================================
# 1. 전기간 Pearson + Spearman, 4 horizon
# ============================================================
print("="*100)
print("[1] 전기간 상관계수 (방향: + = 높을수록 미래수익 좋음)")
print("="*100)
header = f"{'지표':<14}" + "".join(f"{'P_'+h:>9}" for h in HORIZONS) + "  " + "".join(f"{'S_'+h:>9}" for h in HORIZONS)
print(header)
print("-"*100)
full_corr = {}
for k, cfg in indicators_config.items():
    p = [safe_corr(ind_values[k], returns[h], 'pearson') for h in HORIZONS]
    s = [safe_corr(ind_values[k], returns[h], 'spearman') for h in HORIZONS]
    full_corr[k] = {'pearson': p, 'spearman': s}
    p_str = "".join(f"{x:>9.3f}" if not np.isnan(x) else f"{'N/A':>9}" for x in p)
    s_str = "".join(f"{x:>9.3f}" if not np.isnan(x) else f"{'N/A':>9}" for x in s)
    print(f"{cfg['label']:<14}{p_str}  {s_str}")

# ============================================================
# 2. 시기별 robustness (3 sub-periods)
# ============================================================
date_arr = np.array(dates, dtype='datetime64[D]')
splits = [
    ('1996-2008', date_arr < np.datetime64('2008-01-01')),
    ('2008-2020', (date_arr >= np.datetime64('2008-01-01')) & (date_arr < np.datetime64('2020-01-01'))),
    ('2020-2026', date_arr >= np.datetime64('2020-01-01')),
]

print("\n" + "="*100)
print("[2] 시기별 Spearman 상관계수 (6개월 horizon) — robustness 체크")
print("="*100)
print(f"{'지표':<14}" + "".join(f"{name:>14}" for name, _ in splits) + f"{'전기간':>14}{'sign일치':>10}")
print("-"*100)
robust_scores = {}
for k, cfg in indicators_config.items():
    period_corrs = []
    for name, mask in splits:
        c = safe_corr(ind_values[k][mask], returns['6m'][mask], 'spearman')
        period_corrs.append(c)
    full_c = full_corr[k]['spearman'][2]  # 6m index
    signs = [1 if (not np.isnan(c) and c > 0) else 0 for c in period_corrs]
    sign_agree = sum(signs)
    robust_scores[k] = {
        'periods': period_corrs, 'full_6m': full_c, 'sign_agree': sign_agree
    }
    pc_str = "".join(f"{c:>14.3f}" if not np.isnan(c) else f"{'N/A':>14}" for c in period_corrs)
    print(f"{cfg['label']:<14}{pc_str}{full_c:>14.3f}{sign_agree:>9}/3")

# ============================================================
# 3. 분위별 평균 forward return (6개월) — 비선형/threshold 효과
# ============================================================
print("\n" + "="*100)
print("[3] 지표 분위(quintile)별 평균 6개월 forward return (%)")
print("    Q1=가장 약세 신호 (점수 낮음), Q5=가장 강세 신호 (점수 높음)")
print("    monotone 증가하면 = timing tool로 유효")
print("="*100)
print(f"{'지표':<14}{'Q1':>9}{'Q2':>9}{'Q3':>9}{'Q4':>9}{'Q5':>9}{'Q5-Q1':>9}{'monotone':>10}")
print("-"*100)
monotone_score = {}
for k, cfg in indicators_config.items():
    v = ind_values[k]
    r = returns['6m']
    m = ~(np.isnan(v) | np.isnan(r))
    if m.sum() < 100:
        continue
    vv, rr = v[m], r[m]
    qs = np.quantile(vv, [0.2, 0.4, 0.6, 0.8])
    buckets = np.digitize(vv, qs)  # 0..4
    means = [np.mean(rr[buckets == i]) * 100 for i in range(5)]
    spread = means[4] - means[0]
    diffs = np.diff(means)
    mono = sum(1 for d in diffs if d > 0)
    monotone_score[k] = {'means': means, 'spread': spread, 'mono': mono}
    means_str = "".join(f"{x:>9.2f}" for x in means)
    print(f"{cfg['label']:<14}{means_str}{spread:>9.2f}{mono:>9}/4")

# ============================================================
# 4. 극단 구간 hit rate (top 20% / bottom 20%) — 타이밍 판단 핵심
# ============================================================
print("\n" + "="*100)
print("[4] 극단 구간 6개월 hit rate (= 6개월 후 상승한 비율, %)")
print("    Top20%: 지표가 매우 강세 신호일 때 (매수 적기 신호)")
print("    Bot20%: 지표가 매우 약세 신호일 때 (매도 신호)")
print("    Edge = Top20 hit rate - Bot20 hit rate (양수가 클수록 유효)")
print("="*100)
print(f"{'지표':<14}{'Bot20 hit':>12}{'Bot20 avg%':>12}{'Top20 hit':>12}{'Top20 avg%':>12}{'Edge%':>10}{'n_top':>8}")
print("-"*100)
extreme_scores = {}
for k, cfg in indicators_config.items():
    v = ind_values[k]
    r = returns['6m']
    m = ~(np.isnan(v) | np.isnan(r))
    if m.sum() < 100: continue
    vv, rr = v[m], r[m]
    q20, q80 = np.quantile(vv, [0.2, 0.8])
    bot = rr[vv <= q20]
    top = rr[vv >= q80]
    bot_hit = np.mean(bot > 0) * 100
    top_hit = np.mean(top > 0) * 100
    bot_avg = np.mean(bot) * 100
    top_avg = np.mean(top) * 100
    edge = top_hit - bot_hit
    extreme_scores[k] = {'edge': edge, 'top_hit': top_hit, 'bot_hit': bot_hit, 'n_top': len(top)}
    print(f"{cfg['label']:<14}{bot_hit:>11.1f}%{bot_avg:>11.2f}%{top_hit:>11.1f}%{top_avg:>11.2f}%{edge:>9.1f}%{len(top):>8}")

# ============================================================
# 5. 종합 후보 추천
# ============================================================
print("\n" + "="*100)
print("[5] 타이밍 유효성 종합 (sign일치 3/3 + Spearman 6m > 0.05 + Edge > 5% 모두 만족하는 지표)")
print("="*100)
keepers = []
for k, cfg in indicators_config.items():
    rs = robust_scores.get(k)
    es = extreme_scores.get(k)
    if rs is None or es is None: continue
    if rs['sign_agree'] == 3 and rs['full_6m'] > 0.05 and es['edge'] > 5:
        keepers.append((k, cfg['label'], rs['full_6m'], es['edge'], es['top_hit']))

print(f"\n{'지표':<14}{'Spearman_6m':>14}{'Edge%':>10}{'Top20_hit%':>12}")
print("-"*52)
for k, label, sp, edge, hit in sorted(keepers, key=lambda x: -x[2]):
    print(f"{label:<14}{sp:>14.3f}{edge:>9.1f}%{hit:>11.1f}%")

# 가중치 제안 (Spearman 6m 양수 + Edge 양수 만족하는 지표만, Spearman 기반)
print("\n" + "="*100)
print("[6] 제안 가중치 (Spearman 6m 기반, sign일치 3/3 + Edge > 5% 만족 지표만)")
print("="*100)
total = sum(sp for _, _, sp, _, _ in keepers)
if total > 0:
    print("// 투자 타이밍 가중치 (재학습 2026-05, robustness 검증 통과)")
    print("const INDICATOR_WEIGHTS = {")
    for k, label, sp, edge, hit in sorted(keepers, key=lambda x: -x[2]):
        w = sp / total
        print(f"  '{label}': {w:.4f},  // Spearman_6m={sp:.3f}, edge={edge:.1f}%")
    print("}")
else:
    print("(조건 만족 지표 없음)")

# ============================================================
# 7. 현재 composite score (5개 지표, 옛 가중치) 의 hit rate 검증
# ============================================================
print("\n" + "="*100)
print("[7] 현재 composite_score (5개 지표, 옛 weight) 의 실제 점수 구간별 hit rate")
print("    DB의 composite_score 컬럼 직접 사용")
print("="*100)

cs = np.array([d.get('composite_score') if d.get('composite_score') is not None else np.nan for d in raw], dtype=float)
if np.sum(~np.isnan(cs)) < 100:
    print("(DB에 composite_score 데이터 부족, skip)")
else:
    ranges = [(0, 40), (40, 45), (45, 50), (50, 55), (55, 60), (60, 100)]
    for h_label, h_lag in [('3m', 13), ('6m', 26), ('12m', 52)]:
        r = returns[h_label]
        print(f"\n--- {h_label} forward return ---")
        print(f"{'점수구간':<12}{'n':>6}{'hit%':>8}{'avg%':>10}{'min%':>10}{'max%':>10}")
        for lo, hi in ranges:
            m = (~np.isnan(cs)) & (~np.isnan(r)) & (cs >= lo) & (cs < hi)
            if m.sum() == 0: continue
            rr = r[m] * 100
            print(f"  {lo}-{hi:<6}{m.sum():>6}{np.mean(rr > 0):>7.1%}{np.mean(rr):>9.2f}%{np.min(rr):>9.2f}%{np.max(rr):>9.2f}%")
