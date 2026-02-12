# Project Guidelines


## 핵심 규칙
- 이모티콘 사용 금지
- 컴포넌트 작성 시 오버플로우 발생하지 않도록 사이즈 조절에 주의

## ProfessionalDiagnosis.tsx 작업 시 규칙
- 슬라이드는 항상 누군가 발표를 보듯이 읽는다고 가정할 것
- 한 슬라이드에 내용이 너무 많다고 판단되면, 여러 슬라이드로 나눌지 사용자에게 먼저 질문할 것

### 컨텐츠 영역 규칙
- **flex: 1** 사용: 메인 컨텐츠 영역에 `flex: 1`을 주어 남은 공간을 채우도록
- **고정 높이 지양**: `height: 300px` 같은 고정값 대신 `flex: 1` 또는 `max-height` 사용
- **padding 절제**: 상하 padding은 12-20px 이내로 제한
- **font-size 제한**: 본문 텍스트는 13-18px, 제목은 최대 24px

### 반복 요소 (리스트, 카드 등)
```css
.item-container {
  display: flex;
  flex-direction: column;
  gap: 12px;           /* 16px 이하 권장 */
  flex: 1;
  overflow-y: auto;    /* 내용이 많으면 스크롤 */
}

.item {
  padding: 12px 16px;  /* 상하 12px 이하 권장 */
  flex-shrink: 0;
}
```

### 피해야 할 패턴
- `margin-top: auto`를 여러 요소에 사용 (하나만 사용)
- 중첩된 flex container에 모두 `flex: 1` 적용
- 카드/리스트 아이템에 과도한 padding (20px 초과)
- 불필요한 wrapper div 추가

## CSS 스타일

- **CSS Modules 사용**: Tailwind 사용 금지
- **hover는 심플하게**: 색상만 변경, 배경색/테두리 등 추가 효과 금지
- **border-left 액센트 금지**: 왼쪽 세로 바/라인으로 강조하는 디자인 절대 사용 금지
- **이모지 금지**: 코드, UI, 텍스트 어디에서도 이모지 사용 금지

## Git 작업

- **커밋/푸시 금지**: 사용자가 명시적으로 요청하기 전까지 절대로 git commit, git push 실행 금지
- 코드 변경 후에도 자동으로 커밋하지 말 것
- **.env 파일 절대 커밋 금지**: API 키, 시크릿 등 민감한 정보가 포함된 .env 파일은 절대로 git에 추가하지 말 것
