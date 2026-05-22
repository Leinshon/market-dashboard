# 투자 매력도 / 리스크 신호 산출 파이프라인

## 현재 구조 (2026-05 재학습)

`src/lib/composite-score.ts`의 점수 체계는 다음 분석의 출력값:

### Timing Score (투자 매력도)
- **구성**: ERP 66.7% + Buffett Indicator 33.3% (Z-score weighted, 0~100)
- **선정 근거**: 1996~2026 데이터에서 3개 sub-period 부호 일치 + Edge > 5% 모두 만족하는 지표 (`analyze_robustness.py` 결과)
- **검증된 hit rate** (`recalibrate.py` 출력):
  - 60+ (매수 적기): 12개월 후 98.5% 상승, 평균 +17.2%
  - <41 (방어 우위): 12개월 후 64.6% 상승, 평균 +2.1%

### Risk Signal (리스크 신호)
- **구성**: VIX + HY Spread 분위 기반 4단계 (normal/elevated/high/extreme)
- **임계값**: 1996~2026 분포의 70/85/95 percentile

### 폐기된 옛 구조
- 옛 5지표 (HY Spread, VIX, Initial Claims, S&P/200MA, YC 10Y-2Y) 단일 점수
- 폐기 이유: 3개 sub-period 부호 일치 검증을 거의 통과 못 함. HY Spread는 시기별 부호가 -0.334 → +0.142 → +0.542 로 흔들림.

## 실행 순서

```bash
# 1. Supabase에서 데이터 덤프 (/tmp/market_data_full.json 생성)
node scripts/export_market_data.mjs

# 2. 11개 후보 지표 robustness 분석 (어떤 지표가 살아남는지 확인)
python3 scripts/analyze_robustness.py

# 3. 살아남은 지표로 mean/std/임계값 + stance 확률 재산출
python3 scripts/recalibrate.py
```

`recalibrate.py`의 출력 끝부분에 TypeScript용 `TIMING_INDICATOR_STATS` + `RISK_SIGNAL_THRESHOLDS` 블록이 그대로 찍힘. `src/lib/composite-score.ts`에 복붙하면 재학습 끝.

`getStanceProbability()` (`src/Market.tsx`) 의 6개월/12개월 hit rate 도 `recalibrate.py`의 `[3]` 섹션 표 그대로 옮겨 적으면 됨.

## 옛 스크립트 (참고용)

- `calculate_weights.py` — 옛 11지표 → 양수 strength 필터링 (단순 Pearson). robustness 검증 없음. 새 구조에선 미사용.
- `calculate_stats.py` — 옛 5지표 mean/std. 새 구조에선 `recalibrate.py`로 대체.

## 알려진 한계

- Spearman 6m 상관계수가 최대 0.14. 어떤 가중치를 써도 timing 예측력의 천장이 분명히 있음. 60+/41- 극단 구간에서만 신호가 명확.
- In-sample 전체 fit. 진정한 out-of-sample 검증 없음 (walk-forward 미구현).
- VIX는 robust하지만 hit rate 측면에서 역설 (top 20%일 때 hit < bot 20%). 그래서 Timing Score에서 빠지고 Risk Signal로 분리됨.
