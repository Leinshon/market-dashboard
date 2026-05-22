#!/usr/bin/env python3
"""
장기 horizon 검증: "장기우상향 시장에서 어느 타이밍이 정말 더 좋았나"

질문 reframing:
- S&P500은 장기적으로 어차피 오른다.
- "지금 score가 90인 시점" 과 "score가 30인 시점" 에 각각 사면,
  3년/5년/10년 뒤 얼마나 차이가 나는가?
- "Always invested" baseline 대비 timing alpha 가 얼마나 되는가?

이게 진짜 "타이밍의 가치" 를 측정.
"""

import json
import numpy as np
from pathlib import Path

with open("/tmp/market_data_full.json") as f:
    raw = json.load(f)

n = len(raw)
dates = [d['date'] for d in raw]
date64 = np.array(dates, dtype='datetime64[D]')
spy = np.array([d['spy_price'] if d['spy_price'] is not None else np.nan for d in raw], dtype=float)

# drawdown ATH p10y
dd_ath = np.full(n, np.nan)
for i in range(n):
    if i < 26: continue
    peak = np.nanmax(spy[:i+1])
    if peak > 0 and not np.isnan(spy[i]):
        dd_ath[i] = spy[i] / peak - 1

WIN = 520
def rp(values, w):
    out = np.full(len(values), np.nan)
    for i in range(w, len(values)):
        win = values[i-w:i]
        win = win[~np.isnan(win)]
        if len(win) < w*0.5 or np.isnan(values[i]): continue
        out[i] = np.sum(win <= values[i]) / len(win)
    return out

score = rp(-dd_ath, WIN) * 100

# Long horizons (weekly data: 52 ≈ 1y)
HORIZONS = {'1y': 52, '3y': 156, '5y': 260, '10y': 520}

def fwd_return(prices, lag):
    out = np.full(len(prices), np.nan)
    for i in range(len(prices) - lag):
        if prices[i] and prices[i] > 0 and not np.isnan(prices[i+lag]):
            out[i] = prices[i + lag] / prices[i] - 1
    return out

def fwd_cagr(prices, lag, years):
    ret = fwd_return(prices, lag)
    return (1 + ret) ** (1/years) - 1

returns = {h: fwd_return(spy, lag) for h, lag in HORIZONS.items()}
cagrs = {
    '1y':  fwd_cagr(spy, 52, 1),
    '3y':  fwd_cagr(spy, 156, 3),
    '5y':  fwd_cagr(spy, 260, 5),
    '10y': fwd_cagr(spy, 520, 10),
}

# ============================================================
# 1. Score 구간별 horizon 누적 수익률 / CAGR
# ============================================================
buckets = [
    ('90-100 (극단 매수)', 90, 101),
    ('80-90 (강한 매수)', 80, 90),
    ('60-80 (매수)',     60, 80),
    ('40-60 (중립)',     40, 60),
    ('20-40 (약매도)',   20, 40),
    ('0-20 (강매도)',    0,  20),
]

print("="*100)
print("[장기 horizon 별 score 구간 평균 누적 수익률]")
print("='장기우상향 시장에서 정말로 좋은 타이밍이 있었는가' 검증")
print("="*100)
for h, lag in HORIZONS.items():
    yrs = {'1y':1, '3y':3, '5y':5, '10y':10}[h]
    print(f"\n--- {h} forward (CAGR + 누적) ---")
    print(f"{'구간':<22}{'n':>6}{'누적수익률':>14}{'CAGR':>10}{'중앙값':>12}{'min':>10}{'max':>10}")
    for label, lo, hi in buckets:
        m = (~np.isnan(score)) & (~np.isnan(returns[h])) & (score >= lo) & (score < hi)
        if m.sum() < 5:
            print(f"  {label:<20}{m.sum():>6}  데이터 부족")
            continue
        rr = returns[h][m]
        cagr = (1 + rr) ** (1/yrs) - 1
        median_ret = np.median(rr)
        print(f"  {label:<20}{m.sum():>6}{np.mean(rr)*100:>13.1f}%{np.mean(cagr)*100:>9.1f}%{median_ret*100:>11.1f}%{np.min(rr)*100:>9.1f}%{np.max(rr)*100:>9.1f}%")

    # Always invested baseline
    valid_baseline = returns[h][~np.isnan(returns[h])]
    base_cagr = np.mean((1 + valid_baseline) ** (1/yrs) - 1)
    print(f"  {'전체 평균 (baseline)':<20}{len(valid_baseline):>6}{np.mean(valid_baseline)*100:>13.1f}%{base_cagr*100:>9.1f}%")

# ============================================================
# 2. Timing Alpha: score > 80 vs always invested 차이
# ============================================================
print("\n" + "="*100)
print("[Timing Alpha — score 80+ 만 사서 들고가기 vs 항상 들고가기]")
print("="*100)
for h, lag in HORIZONS.items():
    yrs = {'1y':1, '3y':3, '5y':5, '10y':10}[h]
    r = returns[h]
    valid = ~np.isnan(r)

    # Always invested
    always_cagr = np.mean((1 + r[valid]) ** (1/yrs) - 1)
    always_total = np.mean(r[valid])

    # Score 80+ only
    high_mask = valid & (~np.isnan(score)) & (score >= 80)
    if high_mask.sum() == 0: continue
    high_total = np.mean(r[high_mask])
    high_cagr = np.mean((1 + r[high_mask]) ** (1/yrs) - 1)

    # Score 60+
    med_mask = valid & (~np.isnan(score)) & (score >= 60)
    med_total = np.mean(r[med_mask])
    med_cagr = np.mean((1 + r[med_mask]) ** (1/yrs) - 1)

    # Score 20- (worst timing)
    low_mask = valid & (~np.isnan(score)) & (score < 20)
    low_total = np.mean(r[low_mask]) if low_mask.sum() > 0 else 0
    low_cagr = np.mean((1 + r[low_mask]) ** (1/yrs) - 1) if low_mask.sum() > 0 else 0

    print(f"\n--- {h} (n_baseline={valid.sum()}, n_80+={high_mask.sum()}, n_60+={med_mask.sum()}, n_<20={low_mask.sum()}) ---")
    print(f"  Always invested:   CAGR {always_cagr*100:+6.2f}%, 누적 {always_total*100:+7.1f}%")
    print(f"  Score 60+ entries: CAGR {med_cagr*100:+6.2f}%, 누적 {med_total*100:+7.1f}%  (alpha {(med_cagr-always_cagr)*100:+5.2f}%/yr)")
    print(f"  Score 80+ entries: CAGR {high_cagr*100:+6.2f}%, 누적 {high_total*100:+7.1f}%  (alpha {(high_cagr-always_cagr)*100:+5.2f}%/yr)")
    print(f"  Score <20 entries: CAGR {low_cagr*100:+6.2f}%, 누적 {low_total*100:+7.1f}%  (penalty {(low_cagr-always_cagr)*100:+5.2f}%/yr)")

# ============================================================
# 3. "더 많이 사기 좋은 타이밍" 비유 — 같은 자금이 N년 뒤 얼마로 불었는지
# ============================================================
print("\n" + "="*100)
print("[같은 1000만원 투자 시 N년 뒤 평가액 (시기별 평균)]")
print("="*100)
print(f"{'구간':<22}{'1년 후':>14}{'3년 후':>14}{'5년 후':>14}{'10년 후':>14}")
for label, lo, hi in buckets:
    row = [label]
    for h, lag in HORIZONS.items():
        m = (~np.isnan(score)) & (~np.isnan(returns[h])) & (score >= lo) & (score < hi)
        if m.sum() < 5:
            row.append("N/A")
            continue
        avg_ret = np.mean(returns[h][m])
        row.append(f"{10000000 * (1 + avg_ret):,.0f}")
    print(f"  {row[0]:<22}{row[1]:>14}{row[2]:>14}{row[3]:>14}{row[4]:>14}")

# ============================================================
# 4. 하방 위험: score 별 worst case
# ============================================================
print("\n" + "="*100)
print("[하방 위험: score 구간 별 worst 5% / median / best 5% (12개월)]")
print("="*100)
print(f"{'구간':<22}{'n':>6}{'p5 (worst)':>12}{'median':>10}{'p95 (best)':>12}{'손실 비율':>10}")
for label, lo, hi in buckets:
    m = (~np.isnan(score)) & (~np.isnan(returns['1y'])) & (score >= lo) & (score < hi)
    if m.sum() < 5: continue
    rr = returns['1y'][m]
    p5 = np.percentile(rr, 5)
    p50 = np.median(rr)
    p95 = np.percentile(rr, 95)
    loss_rate = (rr < 0).sum() / len(rr) * 100
    print(f"  {label:<22}{m.sum():>6}{p5*100:>11.1f}%{p50*100:>9.1f}%{p95*100:>11.1f}%{loss_rate:>9.1f}%")

# ============================================================
# 5. 직관적 비교: SPY 한 번에 vs 점수 기반 매수
# ============================================================
print("\n" + "="*100)
print("[Score 80+ 신호에서만 매수해서 10년 보유 vs 무작위 진입]")
print("='타이밍 신호로 들어가면 정말 더 벌었나' 직접 측정")
print("="*100)
# Score 80+ 시점들 추출, 그 시점부터 10년 뒤 SPY 가격 비교
high_idxs = np.where((~np.isnan(score)) & (score >= 80))[0]
if len(high_idxs) > 0:
    rets_10y = []
    for idx in high_idxs:
        if idx + 520 < n and not np.isnan(spy[idx+520]):
            r = spy[idx+520] / spy[idx] - 1
            rets_10y.append(r)
    if rets_10y:
        print(f"  Score 80+ 진입 (n={len(rets_10y)}): 평균 10y 누적 {np.mean(rets_10y)*100:+.1f}%, "
              f"CAGR {((1+np.mean(rets_10y))**(1/10)-1)*100:+.2f}%")
        print(f"    중앙값 {np.median(rets_10y)*100:+.1f}%, "
              f"min {np.min(rets_10y)*100:+.1f}%, max {np.max(rets_10y)*100:+.1f}%")
        print(f"    하락 비율: {sum(1 for r in rets_10y if r < 0)/len(rets_10y)*100:.1f}%")

# Always invested 10y
all_10y = [spy[i+520]/spy[i] - 1 for i in range(n-520) if spy[i] > 0 and not np.isnan(spy[i+520])]
print(f"\n  Always invested 10y (n={len(all_10y)}): 평균 누적 {np.mean(all_10y)*100:+.1f}%, "
      f"CAGR {((1+np.mean(all_10y))**(1/10)-1)*100:+.2f}%")
print(f"    중앙값 {np.median(all_10y)*100:+.1f}%, "
      f"min {np.min(all_10y)*100:+.1f}%, max {np.max(all_10y)*100:+.1f}%")
print(f"    하락 비율: {sum(1 for r in all_10y if r < 0)/len(all_10y)*100:.1f}%")
