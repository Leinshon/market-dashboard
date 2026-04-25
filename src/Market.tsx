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