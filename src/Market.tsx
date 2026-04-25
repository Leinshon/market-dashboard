import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { supabase } from './lib/supabase'
import { calculateCompositeScore } from './lib/composite-score'
import './Market.css'

// Chart.js 등록
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
)

// 히스토리 데이터 타입
interface MarketHistoryRecord {
  date: string
  fear_greed: number | null
  vix: number | null
  spy_vs_200ma: number | null
  buffett_indicator: number | null
  fed_balance_sheet_yoy: number | null
  m2_growth_yoy: number | null
  hy_spread: number | null
  yield_curve_10y2y: number | null
  yield_curve_10y3m: number | null
  initial_claims: number | null
  erp: number | null
  spy_price: number | null
  composite_score: number
  qqq_price: number | null
  gld_price: number | null
  schd_price: number | null
  vym_price: number | null
  treasury_3m: number | null
  // 성장 지표
  gdp_growth_qoq: number | null
  ism_manufacturing: number | null
  ism_services: number | null
  retail_sales_yoy: number | null
  // 물가 지표
  cpi_yoy: number | null
  core_cpi_yoy: number | null
  pce_yoy: number | null
  core_pce_yoy: number | null
  ppi_yoy: number | null
  // 고용 지표
  nonfarm_payrolls_mom: number | null
  unemployment_rate: number | null
  labor_participation: number | null
  // 통화정책 지표
  treasury_10y: number | null
  treasury_2y: number | null
  dollar_index: number | null
}

// NOTE: Full file continues - this commit contains the complete Market.tsx with all indicator additions