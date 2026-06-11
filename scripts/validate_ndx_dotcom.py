#!/usr/bin/env python3
"""
^NDX(NASDAQ-100 지수, 1985~) 전체 history 로 drawdown-단독 vs +margin 점수를 백테스트.
QQQ ETF(1999~)와 달리 닷컴 붕괴(2000-2002)가 '점수화 구간'에 포함된다.
핵심 질문: 2000-2002 에 drawdown 점수가 '매수 적기(>=75)'로 떴을 때, 실제로 value trap 이었나?

입력: /tmp/ndx_daily.json (^NDX 일별), /tmp/market_data_full.json (margin_debt 정렬용)
production 설정과 동일: 일별, WIN=2520(10년), LAG=30.
"""
import json, numpy as np

ndx_rows = json.load(open("/tmp/ndx_daily.json"))
dates = [r['date'] for r in ndx_rows]
ndx = np.array([r['ndx'] for r in ndx_rows], float)
n = len(ndx)

# margin_debt 를 NDX 날짜에 asof 정렬 (forward-fill)
md_rows = json.load(open("/tmp/market_data_full.json"))
md_map = {r['date']: r.get('margin_debt') for r in md_rows}
md_dates = sorted(d for d, v in md_map.items() if v is not None)
md_vals = np.array([md_map[d] for d in md_dates], float)
import bisect
margin = np.full(n, np.nan)
for i, d in enumerate(dates):
    j = bisect.bisect_right(md_dates, d) - 1
    if j >= 0: margin[i] = md_vals[j]

WIN, LAG = 2520, 30
def dd_ath(p):
    o = np.full(len(p), np.nan); pk = -np.inf
    for i, v in enumerate(p):
        if np.isnan(v) or v <= 0: o[i] = np.nan; continue
        pk = max(pk, v); o[i] = v/pk - 1
    return o
def rp(x, w):
    o = np.full(len(x), np.nan)
    for i in range(w, len(x)):
        c = x[i]
        if np.isnan(c): continue
        win = x[i-w:i]; win = win[~np.isnan(win)]
        if len(win) < w*0.5: continue
        o[i] = (win <= c).sum()/len(win)*100
    return o
def lag(v, l): o = np.full(len(v), np.nan); o[l:] = v[:-l]; return o
def fwd(p, l):
    o = np.full(len(p), np.nan)
    for i in range(len(p)-l):
        if not np.isnan(p[i]) and p[i] > 0 and not np.isnan(p[i+l]): o[i] = p[i+l]/p[i]-1
    return o

dd = dd_ath(ndx)
dd_p = rp(-dd, WIN)
with np.errstate(all='ignore'): mps = margin/ndx
mps_p = rp(-lag(mps, LAG), WIN)
score_dd = dd_p.copy()                                   # drawdown 단독
score_cb = np.where(np.isnan(mps_p), dd_p, dd_p*0.8 + mps_p*0.2)  # +margin
score_cb[np.isnan(dd_p)] = np.nan

r1, r3, r5, r10 = fwd(ndx,252), fwd(ndx,756), fwd(ndx,1260), fwd(ndx,2520)
def spearman(a,b):
    m=~np.isnan(a)&~np.isnan(b)
    ra=np.argsort(np.argsort(a[m])); rb=np.argsort(np.argsort(b[m]))
    return np.corrcoef(ra,rb)[0,1], m.sum()

first_dd = dates[int(np.argmax(~np.isnan(score_dd)))]
print(f"NDX {dates[0]} ~ {dates[-1]}, n={n}")
print(f"drawdown-단독 점수 산출 시작: {first_dd}  → 닷컴(2000-02) 포함 여부 = {'포함' if first_dd < '2000' else '미포함'}")

for name, sc in [("drawdown-단독", score_dd), ("+margin(0.8/0.2)", score_cb)]:
    print(f"\n{'='*64}\n{name}")
    for lbl, r in [('1y',r1),('3y',r3),('5y',r5),('10y',r10)]:
        rho, nn = spearman(sc, r)
        print(f"  Spearman(score,{lbl}): {rho:+.3f} (n={nn})")
    # quintile (1y)
    m = ~np.isnan(sc) & ~np.isnan(r1); s, rr = sc[m], r1[m]
    qs = np.percentile(s,[20,40,60,80]); b = np.digitize(s,qs); means=[]
    for q in range(5):
        sel=b==q
        if sel.sum()==0: continue
        mu=rr[sel].mean(); means.append(mu)
        print(f"  Q{q+1} score[{s[sel].min():5.1f}-{s[sel].max():5.1f}] 1y E[r]={mu:+.1%} hit={(rr[sel]>0).mean():.0%} n={sel.sum()}")
    if len(means)>=2: print(f"  top-bottom spread: {means[-1]-means[0]:+.1%}")

# ===== 핵심: 닷컴 value-trap 실측 =====
print(f"\n{'='*64}\n닷컴 VALUE-TRAP 실측 (drawdown-단독, score>=75 '매수 적기' 진입)")
dt = np.array(dates)
def era_test(sc, label, mask):
    sel = mask & (sc >= 75) & ~np.isnan(sc)
    for hl, r, yr in [('1y',r1,1),('3y',r3,3),('5y',r5,5)]:
        ss = sel & ~np.isnan(r)
        if ss.sum()==0: print(f"    {label} {hl}: (표본 없음)"); continue
        rv=r[ss]; cg=(np.power(1+rv,1/yr)-1)
        print(f"    {label} {hl}: E[r]={rv.mean():+.0%} 손실비율={(rv<0).mean():.0%} 최악={rv.min():+.0%} CAGR={cg.mean():+.0%} n={ss.sum()}")
dotcom = (dt>='1999-01-01')&(dt<'2003-01-01')   # 닷컴 천장~바닥 진입
post   = (dt>='2003-01-01')
era_test(score_dd, "닷컴기(99-02) 진입", dotcom)
era_test(score_dd, "그 외(03~) 진입   ", post)

# 닷컴기에 실제로 score>=75 가 떴는가 + 그때 raw drawdown
print(f"\n  닷컴기 score>=75 발생 주수: {((dt>='1999-01-01')&(dt<'2003-01-01')&(score_dd>=75)).sum()}")
for tgt in ['2000-03-31','2001-03-30','2002-10-09']:
    idx=max(i for i,d in enumerate(dates) if d<=tgt)
    print(f"    {dates[idx]}: drawdown={dd[idx]:+.0%}  drawdown-점수={score_dd[idx]:.0f}  이후1y={r1[idx]:+.0%} 3y={r3[idx]:+.0%} 5y={r5[idx]:+.0%}")
