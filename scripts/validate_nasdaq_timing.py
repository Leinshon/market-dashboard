#!/usr/bin/env python3
"""
NASDAQ100(QQQ)에 S&P500 기준으로 fit된 Timing Score를 적용하는 게 유효한가?

방법:
- 원래 검증된 방법론(weekly 리샘플, 520주=10년 rolling percentile, fwd 52/156/260/520주)으로
  SPY와 QQQ를 각각 동일 로직으로 산출 후 비교.
- Timing Score = 0.8*drawdown_ath_p10y + 0.2*(margin/price)_p10y_inv (margin 없으면 dd 단독)
- 질문: (a) 같은 score가 두 지수에서 비슷한 forward-return 분포로 매핑되나?
        (b) stance 임계값(90/75/60/40/20)이 두 지수에 같게 보정되나?
        (c) "깊은 drawdown=매수" 전제가 QQQ(닷컴 value trap 포함)에서도 성립하나?
입력: /tmp/market_data_full.json (daily, export_market_data.mjs 산출)
"""
import json
import numpy as np

with open("/tmp/market_data_full.json") as f:
    raw = json.load(f)

# ---------- weekly 리샘플: ISO 주별 마지막 거래일 ----------
import datetime
def isoweek_key(ds):
    y, w, _ = datetime.date.fromisoformat(ds).isocalendar()
    return y * 100 + w

weekly = {}
for r in raw:
    weekly[isoweek_key(r['date'])] = r  # 같은 주면 뒤(=최신) 거래일로 덮어씀
rows = [weekly[k] for k in sorted(weekly)]
dates = [r['date'] for r in rows]
n = len(rows)
def col(name):
    return np.array([r[name] if r.get(name) is not None else np.nan for r in rows], dtype=float)
spy = col('spy_price'); qqq = col('qqq_price'); margin = col('margin_debt')
print(f"weekly n={n}  {dates[0]} ~ {dates[-1]}  (~{n/((datetime.date.fromisoformat(dates[-1])-datetime.date.fromisoformat(dates[0])).days/365):.0f}/yr)")

WIN = 520          # 10yr weekly
LAG = 6            # FINRA release lag (weeks)
W_DD, W_MG = 0.8, 0.2

def drawdown_ath(p):
    out = np.full(len(p), np.nan); peak = -np.inf
    for i, v in enumerate(p):
        if np.isnan(v) or v <= 0: out[i] = np.nan; continue
        peak = max(peak, v); out[i] = v/peak - 1
    return out

def rolling_pct(values, w):
    out = np.full(len(values), np.nan)
    for i in range(w, len(values)):
        cur = values[i]
        if np.isnan(cur): continue
        win = values[i-w:i]; win = win[~np.isnan(win)]
        if len(win) < w*0.5: continue
        out[i] = (win <= cur).sum() / len(win) * 100
    return out

def apply_lag(v, lag):
    out = np.full(len(v), np.nan); out[lag:] = v[:-lag]; return out

def fwd_ret(p, lag):
    out = np.full(len(p), np.nan)
    for i in range(len(p)-lag):
        if not np.isnan(p[i]) and p[i] > 0 and not np.isnan(p[i+lag]):
            out[i] = p[i+lag]/p[i] - 1
    return out

def timing_score(price, margin):
    dd = drawdown_ath(price)
    dd_p = rolling_pct(-dd, WIN)
    mps = price.copy()
    with np.errstate(invalid='ignore', divide='ignore'):
        mps = margin / price
    mps_lag = apply_lag(mps, LAG)
    mps_p = rolling_pct(-mps_lag, WIN)
    out = np.full(len(price), np.nan)
    for i in range(len(price)):
        if np.isnan(dd_p[i]): continue
        out[i] = dd_p[i]*W_DD + mps_p[i]*W_MG if not np.isnan(mps_p[i]) else dd_p[i]
    return out, dd_p

def cagr(total, years):
    return (np.power(1+total, 1/years) - 1)

def analyze(name, price):
    score, dd_p = timing_score(price, margin)
    r1  = fwd_ret(price, 52)
    r3  = fwd_ret(price, 156)
    r5  = fwd_ret(price, 260)
    r10 = fwd_ret(price, 520)
    valid = ~np.isnan(score)
    print(f"\n{'='*70}\n{name}  (score valid: {valid.sum()} weeks, {dates[np.argmax(valid)]} ~ {dates[max(np.where(valid)[0])]})")

    # ---- Spearman 상관: score vs forward return (numpy rank corr) ----
    def spearman(a, b):
        ra = np.argsort(np.argsort(a)); rb = np.argsort(np.argsort(b))
        return np.corrcoef(ra, rb)[0, 1]
    for lbl, r in [('1y',r1),('3y',r3),('5y',r5),('10y',r10)]:
        m = valid & ~np.isnan(r)
        if m.sum() > 30:
            rho = spearman(score[m], r[m])
            print(f"  Spearman(score, {lbl} fwd ret): {rho:+.3f}  (n={m.sum()})")

    # ---- Quintile 분석 (1y) ----
    m = valid & ~np.isnan(r1)
    s, rr = score[m], r1[m]
    qs = np.percentile(s, [20,40,60,80])
    buckets = np.digitize(s, qs)
    print(f"  --- 1y fwd ret by score quintile ---")
    means = []
    for q in range(5):
        sel = buckets == q
        if sel.sum() == 0: continue
        mu, sd = rr[sel].mean(), rr[sel].std()
        hit = (rr[sel] > 0).mean()
        sharpe = mu/sd if sd > 0 else float('nan')
        means.append(mu)
        print(f"    Q{q+1} (score {s[sel].min():5.1f}-{s[sel].max():5.1f}): "
              f"E[r]={mu:+.1%}  hit={hit:.0%}  sharpe={sharpe:+.2f}  n={sel.sum()}")
    if len(means) >= 2:
        print(f"    top-bottom quintile spread: {means[-1]-means[0]:+.1%}")

    # ---- Stance 임계값 테이블 (SPY fit 임계값 그대로 적용) ----
    print(f"  --- stance bucket (SPY 임계값 그대로): 1y hit / 1y E[r] / 10y CAGR ---")
    for lo, hi, lbl in [(90,101,'90+ aggr+'),(75,90,'75-90 aggr'),(60,75,'60-75 mod-aggr'),
                        (40,60,'40-60 neutral'),(20,40,'20-40 mod-def'),(0,20,'<20 def')]:
        sel = valid & (score >= lo) & (score < hi)
        s1 = sel & ~np.isnan(r1); s10 = sel & ~np.isnan(r10)
        if s1.sum() == 0 and s10.sum() == 0: continue
        hit1 = (r1[s1] > 0).mean() if s1.sum() else float('nan')
        er1  = r1[s1].mean() if s1.sum() else float('nan')
        cg10 = cagr(r10[s10], 10).mean() if s10.sum() else float('nan')
        print(f"    {lbl:15s}: 1y hit={hit1:4.0%}  1y E[r]={er1:+6.1%}  "
              f"10y CAGR={cg10:+5.1%}  (n1={s1.sum():3d}, n10={s10.sum():3d})")
    return score, r1, r3, r10

spy_score, spy_r1, spy_r3, spy_r10 = analyze("S&P500 (SPY)", spy)
qqq_score, qqq_r1, qqq_r3, qqq_r10 = analyze("NASDAQ100 (QQQ)", qqq)

# ---- 무조건부 baseline + stance 분포 (score가 얼마나 자주 각 구간에 머무나) ----
print(f"\n{'='*70}\n무조건부 baseline 1y E[r] (전 구간 평균, drift 비교)")
for nm, sc, r1 in [("SPY", spy_score, spy_r1), ("QQQ", qqq_score, qqq_r1)]:
    m = ~np.isnan(sc) & ~np.isnan(r1)
    print(f"  {nm}: 1y E[r]={r1[m].mean():+.1%}  hit={(r1[m]>0).mean():.0%}")
print("stance 도달 빈도 (전체 valid 주 대비 %)")
for nm, sc in [("SPY", spy_score), ("QQQ", qqq_score)]:
    v = sc[~np.isnan(sc)]; tot = len(v)
    f75 = (v>=75).mean()*100; f90 = (v>=90).mean()*100; f20 = (v<20).mean()*100
    print(f"  {nm}: score>=90 {f90:4.1f}%   >=75 {f75:4.1f}%   <20 {f20:4.1f}%")

# ---- value-trap 진단: score>=75 진입 시 3y/10y 분포 ----
print(f"\n{'='*70}\nVALUE-TRAP 진단: score>=75('매수 적기') 진입 후 결과")
def pct(x): return f"{x:+.0%}" if np.isfinite(x) else "n/a"
for nm, sc, r3, r10 in [("SPY", spy_score, spy_r3, spy_r10), ("QQQ", qqq_score, qqq_r3, qqq_r10)]:
    sel = (sc >= 75)
    s3 = sel & ~np.isnan(r3); s10 = sel & ~np.isnan(r10)
    loss3 = (r3[s3]<0).mean() if s3.sum() else float('nan')
    worst3 = r3[s3].min() if s3.sum() else float('nan')
    loss10 = (r10[s10]<0).mean() if s10.sum() else float('nan')
    worst10 = r10[s10].min() if s10.sum() else float('nan')
    print(f"  {nm}: 3y손실비율={pct(loss3)} 3y최악={pct(worst3)}  "
          f"10y손실비율={pct(loss10)} 10y최악={pct(worst10)}  (n3={s3.sum()}, n10={s10.sum()})")

# ---- QQQ scored 기간이 닷컴(2000-02)을 포함하나? raw drawdown 진단 ----
print(f"\nQQQ scored 시작={dates[np.argmax(~np.isnan(qqq_score))]}  "
      f"→ 닷컴 붕괴(2000-02)는 520주 warmup에 묻혀 '점수'에 미반영")
dd_q = drawdown_ath(qqq)
for tgt in ['2000-03','2001-09','2002-09']:
    idx = max(i for i,d in enumerate(dates) if d[:7] <= tgt)
    print(f"  {dates[idx]}: QQQ drawdown_ath={dd_q[idx]:+.0%} (점수화 됐다면 '극도 매력'으로 표시됐을 구간)")

# ---- sub-period: dot-com 포함 vs post-2010 ----
print(f"\n{'='*70}\nSUB-PERIOD: score>=75 1y E[r] (regime별)")
dt = np.array([datetime.date.fromisoformat(d) for d in dates])
pre = np.array([d.year < 2010 for d in dt]); post = ~pre
for nm, sc, r1 in [("SPY", spy_score, spy_r1), ("QQQ", qqq_score, qqq_r1)]:
    for lbl, mask in [("~2009", pre), ("2010~", post)]:
        sel = mask & (sc >= 75) & ~np.isnan(r1)
        if sel.sum():
            print(f"  {nm} {lbl}: 1y E[r]={r1[sel].mean():+.1%}  hit={(r1[sel]>0).mean():.0%}  n={sel.sum()}")
        else:
            print(f"  {nm} {lbl}: (no signal)")
