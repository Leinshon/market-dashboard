# Market Dashboard

시장 타이밍 분석 대시보드

## 기능

- 실시간 시장 지표 모니터링
- Composite Score 기반 시장 국면 분석
- 히스토리 차트 및 백테스트
- Gemini AI 채팅 지원

## 개발 환경 설정

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경 변수 설정

`.env.example` 파일을 참고하여 `.env` 파일을 생성하고 필요한 API 키를 설정하세요.

```bash
cp .env.example .env
```

필요한 환경 변수:
- `VITE_SUPABASE_URL`: Supabase 프로젝트 URL
- `VITE_SUPABASE_ANON_KEY`: Supabase Anon 키
- `SUPABASE_URL`: Supabase 프로젝트 URL (서버 측)
- `SUPABASE_SERVICE_KEY`: Supabase Service Role 키
- `FRED_API_KEY`: FRED API 키
- `GEMINI_API_KEY`: Google Gemini API 키
- `CRON_SECRET`: Cron 작업 인증용 시크릿 (임의의 문자열)

### 3. 개발 서버 실행

```bash
npm run dev
```

## 빌드

```bash
npm run build
```

## 배포 (Vercel)

### Vercel CLI로 배포

```bash
npm install -g vercel
vercel
```

### Vercel 웹에서 배포

1. [Vercel](https://vercel.com)에 GitHub 저장소 연결
2. 환경 변수 설정:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `FRED_API_KEY`
   - `GEMINI_API_KEY`
   - `CRON_SECRET` (임의의 강력한 문자열)
3. Deploy 버튼 클릭

### Cron 작업 설정

Vercel에서 자동으로 `vercel.json`의 cron 설정을 인식하여 매일 오후 10시(UTC)에 시장 데이터를 수집합니다.

## 기술 스택

- React 19
- TypeScript
- Vite
- Chart.js
- Supabase
- Vercel Serverless Functions
- Vercel Cron Jobs
- Google Gemini API

## 라이선스

Private
