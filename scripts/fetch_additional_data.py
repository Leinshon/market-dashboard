#!/usr/bin/env python3
"""
yfinance로 SPY volume + VIX9D + VIX3M + HYG + LQD daily 가져오기.
market_data_full.json의 각 record date에 매칭해서 /tmp/market_data_enhanced.json 생성.
"""

import json
from pathlib import Path
import yfinance as yf
from datetime import datetime, timedelta
import time

def fetch_daily(symbol, period='max'):
    print(f'{symbol} fetching...')
    try:
        t = yf.Ticker(symbol)
        df = t.history(period=period, auto_adjust=False)
        if df.empty:
            print(f'  {symbol}: empty')
            return {}
        out = {}
        for idx, row in df.iterrows():
            date = idx.strftime('%Y-%m-%d')
            out[date] = {
                'close': float(row['Close']) if 'Close' in row else None,
                'volume': int(row['Volume']) if 'Volume' in row and row['Volume'] > 0 else None,
            }
        first = min(out.keys()); last = max(out.keys())
        print(f'  {symbol}: {len(out)} rows, {first} ~ {last}')
        return out
    except Exception as e:
        print(f'  {symbol}: error {e}')
        return {}

spy = fetch_daily('SPY')
time.sleep(2)
vix9d = fetch_daily('^VIX9D')
time.sleep(2)
vix3m = fetch_daily('^VIX3M')
time.sleep(2)
hyg = fetch_daily('HYG')
time.sleep(2)
lqd = fetch_daily('LQD')

def match_date(data_map, target_date, max_back=7):
    if target_date in data_map: return data_map[target_date]
    d = datetime.strptime(target_date, '%Y-%m-%d')
    for back in range(1, max_back + 1):
        t = (d - timedelta(days=back)).strftime('%Y-%m-%d')
        if t in data_map: return data_map[t]
    return None

market = json.loads(Path('/tmp/market_data_full.json').read_text())
print(f'\nmarket_data_full.json: {len(market)} rows')

stats = {'spy_volume_yh': 0, 'vix9d_yh': 0, 'vix3m_yh': 0, 'hyg_yh': 0, 'lqd_yh': 0}
for rec in market:
    spy_match = match_date(spy, rec['date'])
    rec['spy_volume_yh'] = spy_match['volume'] if spy_match else None

    v9 = match_date(vix9d, rec['date'])
    rec['vix9d_yh'] = v9['close'] if v9 else None

    v3 = match_date(vix3m, rec['date'])
    rec['vix3m_yh'] = v3['close'] if v3 else None

    h = match_date(hyg, rec['date'])
    rec['hyg_yh'] = h['close'] if h else None

    l = match_date(lqd, rec['date'])
    rec['lqd_yh'] = l['close'] if l else None

    for k in stats:
        if rec[k] is not None: stats[k] += 1

print('\n매칭 결과:')
for k, v in stats.items():
    valid = [d for d in market if d[k] is not None]
    first = valid[0]['date'] if valid else '?'
    last = valid[-1]['date'] if valid else '?'
    print(f'  {k}: {v}/{len(market)} ({v/len(market)*100:.1f}%)  range: {first} ~ {last}')

Path('/tmp/market_data_enhanced.json').write_text(json.dumps(market))
print(f'\nwrote {len(market)} rows to /tmp/market_data_enhanced.json')
