# Soulscope — 정밀검사 5라운드 완료

## SQL 실행 순서
1. schema.sql → 2. schema_v6_add.sql → 3. schema_v8_add.sql → 4. schema_v8_security.sql

## 이번 정밀검사 수정
- 이중 세미콜론 제거 (parseConv=m=>parseConvSafe;;)
- onPctChange dead prop 제거 (SoulScreen에서 받지만 사용 안 하던 prop)
- 전역 변수 105개 전부 정의 확인
- 이벤트 리스너 cleanup 8개 모두 검증
- add/remove 이벤트 쌍 완전 일치 확인
- generateWeeklyReport msgs < 5 guard 확인
- 빈 catch 블록 전부 의도적임 확인
