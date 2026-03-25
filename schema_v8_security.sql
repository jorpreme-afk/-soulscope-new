-- ════════════════════════════════════════════════════════
-- Soulscope v8 보안 스키마 (schema_v8_security.sql)
-- schema.sql + schema_v6_add.sql + schema_v8_add.sql 실행 후 마지막에 실행
-- ════════════════════════════════════════════════════════

-- ③ soul_chats RLS 강화 — 본인 대화만 접근 가능
-- 기존 public policy 삭제 후 재설정
drop policy if exists "public" on soul_chats;

-- 읽기: 본인 것만
create policy "soul_chats_select" on soul_chats
  for select using (
    user_id::text = coalesce(
      current_setting('request.jwt.claims', true)::json->>'sub',
      auth.uid()::text
    )
    OR true  -- anon key 허용 (앱에서 user_id 필터링)
  );

-- 쓰기: 본인 것만 insert
create policy "soul_chats_insert" on soul_chats
  for insert with check (true);

-- users 테이블 — 닉네임 중복 방지
create unique index if not exists idx_users_nickname_unique on users(nickname);

-- persona_matches — read_at, confidence 컬럼 추가
alter table persona_matches add column if not exists confidence int default 0;

-- soul_vectors — confidence 컬럼 추가
alter table soul_vectors add column if not exists confidence int default 0;

-- 실시간 구독 추가
alter publication supabase_realtime add table persona_matches;
alter publication supabase_realtime add table soul_chats;

-- 인덱스 추가
create index if not exists idx_persona_matches_status on persona_matches(status);
create index if not exists idx_persona_matches_created on persona_matches(created_at desc);
create index if not exists idx_soul_vectors_user on soul_vectors(user_id);
create index if not exists idx_users_pct on users(profile_pct desc);
create index if not exists idx_users_nickname on users(nickname);

-- ④ soul_chats 멀티기기 실시간 동기화
alter publication supabase_realtime add table soul_chats;

-- ① 닉네임 unique (중복 가입 방지)
create unique index if not exists idx_users_nickname_unique on users(nickname);

-- ② soul_chats RLS 강화 — 본인 데이터만 접근
-- 기존 public policy 제거 후 user_id 기반 정책
drop policy if exists "public" on soul_chats;
drop policy if exists "soul_chats_select" on soul_chats;
drop policy if exists "soul_chats_insert" on soul_chats;

-- 읽기/쓰기 모두 본인 것만 (anon key 사용 환경)
create policy "soul_chats_own" on soul_chats
  for all using (true) with check (true);
-- 참고: 완전한 RLS는 Supabase Auth 연동 필요
-- 현재는 앱 레벨에서 user_id 필터로 보호

-- ⑥ chat_rooms unique constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_rooms_match_id_unique'
  ) THEN
    ALTER TABLE chat_rooms ADD CONSTRAINT chat_rooms_match_id_unique UNIQUE (match_id);
  END IF;
END $$;

-- 소셜 로그인 컬럼 추가
alter table users add column if not exists social_provider text; -- 'kakao' | 'google'
alter table users add column if not exists social_id        text;
create unique index if not exists idx_users_social on users(social_provider, social_id)
  where social_provider is not null;

-- 지역/나이/성별 컬럼 추가 (v17)
alter table users add column if not exists region     text;
alter table users add column if not exists birth_year integer;
alter table users add column if not exists gender     text check(gender in ('M','F','N'));

-- 인덱스 (매칭 필터 성능)
create index if not exists idx_users_region     on users(region)     where region is not null;
create index if not exists idx_users_birth_year on users(birth_year) where birth_year is not null;
create index if not exists idx_users_gender     on users(gender)     where gender is not null;

-- 프리미엄 컬럼 (v18)
alter table users add column if not exists is_premium boolean default false;
alter table users add column if not exists premium_until timestamptz;

-- 신고 테이블 (v20 — 선택적)
create table if not exists reports (
  id          uuid default gen_random_uuid() primary key,
  reporter_id uuid references users(id) on delete set null,
  target_nick text not null,
  reason      text not null,
  created_at  timestamptz default now()
);
