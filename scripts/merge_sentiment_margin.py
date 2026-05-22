#!/usr/bin/env python3
"""
AAII sentiment + FINRA margin debt 를 market_data_full.json 에 매칭.
결과: /tmp/market_data_full_v2.json
"""

import pandas as pd
import json
from datetime import datetime, timedelta
from pathlib import Path

# AAII (weekly, 1987~)
df_aaii = pd.read_excel('/tmp/aaii.xls', sheet_name='SENTIMENT', header=3)
df_aaii = df_aaii[['Date', 'Bullish', 'Neutral', 'Bearish', 'Spread']].dropna(subset=['Date'])
df_aaii['Date'] = pd.to_datetime(df_aaii['Date'], errors='coerce')
df_aaii = df_aaii.dropna(subset=['Date'])
df_aaii['date_str'] = df_aaii['Date'].dt.strftime('%Y-%m-%d')
aaii_map = {}
for _, row in df_aaii.iterrows():
    try:
        aaii_map[row['date_str']] = {
            'bullish': float(row['Bullish']) if pd.notna(row['Bullish']) else None,
            'bearish': float(row['Bearish']) if pd.notna(row['Bearish']) else None,
            'neutral': float(row['Neutral']) if pd.notna(row['Neutral']) else None,
            'spread': float(row['Spread']) if pd.notna(row['Spread']) else None,
        }
    except (ValueError, TypeError):
        pass

# 일부 date_str이 valid이지만 값이 안 들어간 경우 제거
aaii_map = {k: v for k, v in aaii_map.items() if any(x is not None for x in v.values())}
print(f'AAII: {len(aaii_map)} weeks, {min(aaii_map)} ~ {max(aaii_map)}')

# FINRA Margin (monthly, ~1997~)
df_finra = pd.read_excel('/tmp/finra.xlsx', sheet_name='Customer Margin Balances')
# Year-Month → date_str (월말 가정)
finra_map = {}
for _, row in df_finra.iterrows():
    ym = str(row['Year-Month'])
    try:
        y, m = ym.split('-')
        # 해당 월의 마지막 날
        if int(m) == 12:
            next_month = datetime(int(y) + 1, 1, 1)
        else:
            next_month = datetime(int(y), int(m) + 1, 1)
        last_day = (next_month - timedelta(days=1)).strftime('%Y-%m-%d')
        finra_map[last_day] = {
            'margin_debt': float(row.iloc[1]) if pd.notna(row.iloc[1]) else None,
            'free_credit_cash': float(row.iloc[2]) if pd.notna(row.iloc[2]) else None,
        }
    except (ValueError, KeyError):
        pass
print(f'FINRA: {len(finra_map)} months, {min(finra_map)} ~ {max(finra_map)}')

# market_data_full.json 매칭
market = json.loads(Path('/tmp/market_data_full.json').read_text())

def match_within(map_d, target_date, max_back):
    if target_date in map_d: return map_d[target_date]
    d = datetime.strptime(target_date, '%Y-%m-%d')
    for back in range(1, max_back + 1):
        t = (d - timedelta(days=back)).strftime('%Y-%m-%d')
        if t in map_d: return map_d[t]
    return None

stats = {'aaii_bull': 0, 'aaii_bear': 0, 'margin_debt': 0}
for rec in market:
    # AAII: weekly, match within 7 days back
    a = match_within(aaii_map, rec['date'], 7)
    rec['aaii_bullish'] = a['bullish'] if a else None
    rec['aaii_bearish'] = a['bearish'] if a else None
    rec['aaii_spread'] = a['spread'] if a else None
    # FINRA: monthly, match within 40 days back (월말 데이터)
    m = match_within(finra_map, rec['date'], 40)
    rec['margin_debt'] = m['margin_debt'] if m else None
    rec['free_credit_cash'] = m['free_credit_cash'] if m else None

    if rec['aaii_bullish'] is not None: stats['aaii_bull'] += 1
    if rec['aaii_bearish'] is not None: stats['aaii_bear'] += 1
    if rec['margin_debt'] is not None: stats['margin_debt'] += 1

print('\n매칭 결과:')
for k, v in stats.items():
    valid_recs = [d for d in market if d.get('aaii_bullish' if 'aaii' in k else 'margin_debt') is not None]
    first = valid_recs[0]['date'] if valid_recs else '?'
    last = valid_recs[-1]['date'] if valid_recs else '?'
    print(f'  {k}: {v}/{len(market)} ({v/len(market)*100:.1f}%) range {first} ~ {last}')

Path('/tmp/market_data_full_v2.json').write_text(json.dumps(market))
print(f'\nwrote {len(market)} rows to /tmp/market_data_full_v2.json')
