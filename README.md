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
- `FRED_API_KEY`: FRED API 키
- `GEMINI_API_KEY`: Google Gemini API 키

### 3. 개발 서버 실행

```bash
npm run dev
```

### 4. Netlify Dev (Functions 포함)

```bash
npm install -g netlify-cli
netlify dev
```

## 빌드

```bash
npm run build
```

## 배포

Netlify에 배포하려면:

```bash
netlify deploy --prod
```

## 기술 스택

- React 19
- TypeScript
- Vite
- Chart.js
- Supabase
- Netlify Functions
- Google Gemini API

## 라이선스

Private
