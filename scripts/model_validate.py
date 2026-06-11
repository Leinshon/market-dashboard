#!/usr/bin/env python3
"""
투자매력도 재설계안 검증 (cross-index, full history, walk-forward-style fixed params, PSR).

모델 비교:
  OLD  drawdown-단독          : rp(-dd_ath)                      (현행, 평균회귀)
  TREND 추세 코어             : 0.5*rp(px/MA200-1) + 0.5*rp(mom12)
  NEW  추세+변동성+게이트dip   : 0.6*TREND + 0.25*rp(-vol60) + 0.15*gated_dd
                              (가중치는 a-priori 고정, 미튜닝)

평가:
  (1) 1y forward-return 분위 spread (Q5-Q1) — 지수별 + 전체 풀링
  (2) 위기별(닷컴/GFC/covid/2022) top-quintile 1y E[r] — 풀링
  (3) 타이밍 전략(노출 w=score/100) Sharpe·MaxDD vs buy&hold + PSR

입력: /tmp/idx/<SYM>.json (12개 지수, Yahoo range=max)
"""
import json, numpy as np, math
from pathlib import Path

WIN = 2520
SYMS = ["GSPC","NDX","IXIC","DJI","RUT","FTSE","GDAXI","N225","HSI","KS11","AXJO","GSPTSE"]
CRISES = [("dotcom",'1999-01-01','2003-01-01'),("GFC",'2007-06-01','2009-07-01'),
          ("covid",'2020-01-01','2020-07-01'),("2022",'2022-01-01','2023-01-01')]

def ma(p,w):
    c=np.concatenate([[0],np.cumsum(np.nan_to_num(p))]); n=np.concatenate([[0],np.cumsum(~np.isnan(p))])
    out=np.full(len(p),np.nan)
    for i in range(w-1,len(p)):
        cnt=n[i+1]-n[i+1-w]
        if cnt>0: out[i]=(c[i+1]-c[i+1-w])/cnt
    return out
def dd_ath(p):
    o=np.full(len(p),np.nan); pk=-np.inf
    for i,v in enumerate(p):
        if np.isnan(v) or v<=0: o[i]=np.nan; continue
        pk=max(pk,v); o[i]=v/pk-1
    return o
def rp(x,w):
    o=np.full(len(x),np.nan)
    for i in range(w,len(x)):
        c=x[i]
        if np.isnan(c): continue
        win=x[i-w:i]; win=win[~np.isnan(win)]
        if len(win)<w*0.5: continue
        o[i]=(win<=c).sum()/len(win)*100
    return o
def mom(p,w=252):
    o=np.full(len(p),np.nan)
    for i in range(w,len(p)):
        if not np.isnan(p[i]) and not np.isnan(p[i-w]) and p[i-w]>0: o[i]=p[i]/p[i-w]-1
    return o
def rvol(p,w=60):
    r=np.full(len(p),np.nan); r[1:]=p[1:]/p[:-1]-1
    o=np.full(len(p),np.nan)
    for i in range(w,len(p)):
        seg=r[i-w+1:i+1]; seg=seg[~np.isnan(seg)]
        if len(seg)>w*0.5: o[i]=seg.std()*math.sqrt(252)
    return o
def fwd(p,l):
    o=np.full(len(p),np.nan)
    for i in range(len(p)-l):
        if not np.isnan(p[i]) and p[i]>0 and not np.isnan(p[i+l]): o[i]=p[i+l]/p[i]-1
    return o

def scores(p):
    m200=ma(p,200); up=p>m200
    T=0.5*rp(p/m200-1,WIN)+0.5*rp(mom(p),WIN)
    V=rp(-rvol(p),WIN)
    Graw=rp(-dd_ath(p),WIN); G=np.where(up, Graw, 0.0)
    G=np.where(np.isnan(G),0.0,G)
    new=np.where(np.isnan(T)|np.isnan(V), np.nan, 0.6*T+0.25*V+0.15*G)
    old=rp(-dd_ath(p),WIN)
    return {"OLD":old, "TREND":T, "NEW":new}

def Phi(x): return 0.5*(1+math.erf(x/math.sqrt(2)))
def psr(r, sr0_daily):
    r=r[~np.isnan(r)]
    if len(r)<100 or r.std()==0: return float('nan')
    sr=r.mean()/r.std()
    m=(r-r.mean()); g3=(m**3).mean()/r.std()**3; g4=(m**4).mean()/r.std()**4
    denom=math.sqrt(max(1e-9,1-g3*sr+(g4-1)/4*sr**2))
    return Phi((sr-sr0_daily)*math.sqrt(len(r)-1)/denom)
def maxdd(eq):
    pk=-np.inf; mx=0
    for v in eq:
        pk=max(pk,v); mx=min(mx,v/pk-1)
    return mx

# ---- load ----
DATA={}
for s in SYMS:
    rows=json.load(open(f"/tmp/idx/{s}.json"))
    DATA[s]=([r['date'] for r in rows], np.array([r['px'] for r in rows],float))

# ---- per-index compute + pooled accumulation ----
pool={k:{'sc':[], 'r1':[], 'dt':[]} for k in ["OLD","TREND","NEW"]}
print(f"{'idx':7s} | {'1y spread (Q5-Q1)':^26s} | {'전략 Sharpe (연율)':^26s} | {'MaxDD':^20s}")
print(f"{'':7s} | {'OLD':>7s}{'TREND':>9s}{'NEW':>9s} | {'B&H':>6s}{'OLD':>7s}{'NEW':>7s} | {'B&H':>6s}{'NEW':>7s}")
for s in SYMS:
    dates,p=DATA[s]; sc=scores(p); r1=fwd(p,252)
    rd=np.full(len(p),np.nan); rd[1:]=p[1:]/p[:-1]-1
    spreads={}; shr={}; mdd={}
    bh=rd.copy()
    for k,sig in sc.items():
        m=~np.isnan(sig)&~np.isnan(r1)
        if m.sum()>50:
            v,rr=sig[m],r1[m]; qs=np.percentile(v,[20,80])
            spreads[k]=rr[v>=qs[1]].mean()-rr[v<=qs[0]].mean()
        else: spreads[k]=float('nan')
        pool[k]['sc'].append(sig); pool[k]['r1'].append(r1); pool[k]['dt'].append(np.array(dates))
        # strategy
        w=np.clip(sig/100,0,1); strat=np.full(len(p),np.nan); strat[1:]=w[:-1]*rd[1:]
        shr[k]=np.nanmean(strat)/np.nanstd(strat)*math.sqrt(252) if np.nanstd(strat)>0 else float('nan')
        eq=np.cumprod(1+np.nan_to_num(strat[~np.isnan(strat)])); mdd[k]=maxdd(eq)
    bhsh=np.nanmean(bh)/np.nanstd(bh)*math.sqrt(252)
    bheq=np.cumprod(1+np.nan_to_num(bh[~np.isnan(bh)])); bhmdd=maxdd(bheq)
    print(f"{s:7s} | {spreads['OLD']*100:+6.1f}%{spreads['TREND']*100:+8.1f}%{spreads['NEW']*100:+8.1f}% | "
          f"{bhsh:6.2f}{shr['OLD']:7.2f}{shr['NEW']:7.2f} | {bhmdd*100:5.0f}%{mdd['NEW']*100:+7.0f}%")

# ---- pooled spread + per-crisis ----
print(f"\n{'='*64}\n전체 풀링 (12개 지수 × 전 기간)")
for k in ["OLD","TREND","NEW"]:
    SC=np.concatenate(pool[k]['sc']); R1=np.concatenate(pool[k]['r1']); DT=np.concatenate(pool[k]['dt'])
    m=~np.isnan(SC)&~np.isnan(R1); v,rr,dd=SC[m],R1[m],DT[m]
    qs=np.percentile(v,[20,80]); spread=rr[v>=qs[1]].mean()-rr[v<=qs[0]].mean()
    thr=np.percentile(SC[~np.isnan(SC)],80)
    cells=[]
    for nm,a,b in CRISES:
        sel=(dd>=a)&(dd<b)&(v>=thr)
        cells.append(f"{nm}={rr[sel].mean()*100:+.0f}%(n{sel.sum()})" if sel.sum() else f"{nm}=n/a")
    print(f"  {k:6s} 1y spread={spread*100:+5.1f}%  Q5hit={(rr[v>=qs[1]]>0).mean()*100:3.0f}%  | "+"  ".join(cells))

# ---- PSR: 전략이 buy&hold 대비 Sharpe 우위가 통계적으로 유의한가 (지수별, NEW) ----
print(f"\n{'='*64}\nPSR: NEW 전략 SR > buy&hold SR 확률 (>0.95 면 유의), 지수별")
psr_vals=[]
for s in SYMS:
    dates,p=DATA[s]; sig=scores(p)['NEW']
    rd=np.full(len(p),np.nan); rd[1:]=p[1:]/p[:-1]-1
    w=np.clip(sig/100,0,1); strat=np.full(len(p),np.nan); strat[1:]=w[:-1]*rd[1:]
    bh=rd[~np.isnan(strat)]; st=strat[~np.isnan(strat)]
    sr0=bh.mean()/bh.std() if bh.std()>0 else 0
    pv=psr(st, sr0); psr_vals.append(pv)
    print(f"  {s:7s} PSR(NEW>B&H)={pv:.2f}")
print(f"  중앙값 PSR={np.nanmedian(psr_vals):.2f}, >0.95 지수 수={sum(1 for v in psr_vals if v>0.95)}/{len(psr_vals)}")
