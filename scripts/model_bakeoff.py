#!/usr/bin/env python3
"""
모델 재고 bake-off: 닷컴·GFC 포함 전체 history 에서 후보 타이밍 신호를 공정 비교.
질문: drawdown 평균회귀가 버블에서 깨졌다 → trend gate / 순수 momentum 이 살아남나?

후보(각각 0~100 ranking 신호, Q5=가장 '매수 매력'):
  S1 drawdown-단독        : dd_ath 의 10년 percentile (현행)
  S2 drawdown + trend gate: 위 신호를 px<200일선 일 때 무력화 (하락추세 중 매수 금지)
  S3 momentum(12m)        : 12개월 수익률의 10년 percentile (추세추종, 강세 매수)
  S4 dd52 + trend gate    : 52주고점 대비 낙폭(단기조정) percentile, 추세 게이트
  S5 trend proximity      : px/200일선-1 의 10년 percentile (추세 위 정도)

평가: 1y 분위 spread(Q5-Q1) 전체 + 위기별 Q5(top quintile) 1y E[r]/손실률.
견고 = 모든 위기에서 음수 안 나옴.
입력: /tmp/gspc_daily.json, /tmp/ndx_daily.json
"""
import json, numpy as np

WIN = 2520
def load(path, key):
    rows = json.load(open(path))
    return [r['date'] for r in rows], np.array([r[key] for r in rows], float)

def ma(p, w):
    out = np.full(len(p), np.nan); s = 0.0; from_ = 0
    # simple trailing mean ignoring nan via cumulative
    csum = np.zeros(len(p)+1)
    for i in range(len(p)): csum[i+1] = csum[i] + (p[i] if not np.isnan(p[i]) else 0)
    cnt = np.zeros(len(p)+1)
    for i in range(len(p)): cnt[i+1] = cnt[i] + (0 if np.isnan(p[i]) else 1)
    for i in range(w-1, len(p)):
        c = cnt[i+1] - cnt[i+1-w]
        if c > 0: out[i] = (csum[i+1] - csum[i+1-w]) / c
    return out

def dd_ath(p):
    o = np.full(len(p), np.nan); pk = -np.inf
    for i, v in enumerate(p):
        if np.isnan(v) or v <= 0: o[i] = np.nan; continue
        pk = max(pk, v); o[i] = v/pk - 1
    return o

def dd52(p, w=252):
    o = np.full(len(p), np.nan)
    for i in range(len(p)):
        lo = max(0, i-w+1); seg = p[lo:i+1]; seg = seg[~np.isnan(seg)]
        if len(seg) and not np.isnan(p[i]) and seg.max() > 0: o[i] = p[i]/seg.max() - 1
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

def mom(p, w=252):
    o = np.full(len(p), np.nan)
    for i in range(w, len(p)):
        if not np.isnan(p[i]) and not np.isnan(p[i-w]) and p[i-w] > 0: o[i] = p[i]/p[i-w]-1
    return o

def fwd(p, l):
    o = np.full(len(p), np.nan)
    for i in range(len(p)-l):
        if not np.isnan(p[i]) and p[i] > 0 and not np.isnan(p[i+l]): o[i] = p[i+l]/p[i]-1
    return o

CRISES = [
    ("dotcom", '1999-01-01', '2003-01-01'),
    ("GFC",    '2007-06-01', '2009-07-01'),
    ("covid",  '2020-01-01', '2020-07-01'),
    ("2022",   '2022-01-01', '2023-01-01'),
]

def candidates(p):
    m200 = ma(p, 200)
    up = (p > m200)                       # 추세 위
    dd_p = rp(-dd_ath(p), WIN)            # 낙폭 클수록 큰 값
    dd52_p = rp(-dd52(p), WIN)
    mom_p = rp(mom(p), WIN)              # momentum 클수록 큰 값
    trend_p = rp((p/m200 - 1), WIN)     # 추세 위일수록 큰 값
    def gate(sig):                        # 하락추세면 매력 무력화
        g = sig.copy(); g[~up] = np.nan; return g
    return {
        "S1 drawdown단독":   dd_p,
        "S2 drawdown+gate":  gate(dd_p),
        "S3 momentum12m":    mom_p,
        "S4 dd52+gate":      gate(dd52_p),
        "S5 trendProx":      trend_p,
    }

def evaluate(name, dates, p):
    r1 = fwd(p, 252)
    dt = np.array(dates)
    print(f"\n{'#'*66}\n{name}  ({dates[0]}~{dates[-1]})")
    print(f"{'signal':18s} {'1y spread':>9s} {'Q5 hit':>7s} | " + " ".join(f"{c[0]:>8s}" for c in CRISES) + "  normal")
    for sig_name, sig in candidates(p).items():
        m = ~np.isnan(sig) & ~np.isnan(r1)
        if m.sum() < 100:
            print(f"{sig_name:18s}  (표본 부족)"); continue
        s, rr = sig[m], r1[m]
        qs = np.percentile(s, [20, 80])
        q5 = rr[s >= qs[1]]; q1 = rr[s <= qs[0]]
        spread = q5.mean() - q1.mean()
        q5hit = (q5 > 0).mean()
        # 위기별 top-quintile 1y E[r]
        thr = np.percentile(sig[~np.isnan(sig)], 80)
        cells = []
        crisis_mask = np.zeros(len(p), bool)
        for _, a, b in CRISES:
            mask = (dt >= a) & (dt < b)
            crisis_mask |= mask
            sel = mask & (sig >= thr) & ~np.isnan(r1)
            cells.append(f"{r1[sel].mean()*100:+7.0f}%" if sel.sum() else "    n/a")
        norm = (~crisis_mask) & (sig >= thr) & ~np.isnan(r1)
        normcell = f"{r1[norm].mean()*100:+.0f}%" if norm.sum() else "n/a"
        print(f"{sig_name:18s} {spread*100:+8.1f}% {q5hit*100:6.0f}% | " + " ".join(cells) + f"  {normcell}")

for nm, path, key in [("S&P500 (^GSPC)", "/tmp/gspc_daily.json", "px"),
                       ("NASDAQ100 (^NDX)", "/tmp/ndx_daily.json", "ndx")]:
    dates, p = load(path, key)
    evaluate(nm, dates, p)
print("\n해석: 1y spread>0 + 모든 위기 열에서 음수 없음 = 견고. Q5=top quintile(매수 매력 상위20%).")
