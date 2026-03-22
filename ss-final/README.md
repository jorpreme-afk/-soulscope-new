# Soulscope v8.2

## SQL 실행 순서 (반드시 순서대로)
1. schema.sql
2. schema_v6_add.sql
3. schema_v8_add.sql
4. schema_v8_security.sql

## 배포
1. GitHub 새 레포 → 이 폴더 전체 업로드
2. vercel.com → Import → ANTHROPIC_API_KEY 환경변수 추가 → Deploy

## 이번에 고친 것들
① 콜드스타트 — [AI] 더미 페르소나 5개 자동 생성
② api/claude.js — CORS 완화, 에러 상세화, 스트리밍 헤더
③ 보안 — soul_chats 접근 제한, 닉네임 중복방지 인덱스
④ 스켈레톤 — 앱 재시작시 빈화면 방지
⑤ 로딩 텍스트 — "소울이 생각하는 중..."
⑥ 매칭 필터 — 이미 매칭됐거나 거절한 사람 제외
⑦ AI 더미 채팅 — [AI] 페르소나가 실제로 채팅 응답
⑧ calcPct 개선 — 필드(60%) + confidence(25%) + tags(15%)
⑨ 점수 분산 — 보완 관계 가중치 강화
⑩ Canvas 공유 이미지 — 이미지 파일로 공유/다운로드
