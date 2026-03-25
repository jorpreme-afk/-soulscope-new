-- ════════════════════════════════════════════════════════
-- Soulscope v6 추가 스키마
-- 기존 schema.sql 실행 후 이것도 실행해주세요
-- ════════════════════════════════════════════════════════

-- 페르소나 매칭 결과 테이블
create table if not exists persona_matches (
  id            uuid primary key default gen_random_uuid(),
  user_a        uuid references users(id) on delete cascade,
  user_b        uuid references users(id) on delete cascade,
  score         int,
  tier          text,
  conversation  jsonb,          -- 페르소나끼리 나눈 대화
  report        jsonb,          -- 매칭 리포트
  status        text default 'pending', -- pending | accepted | rejected
  initiated_by  uuid references users(id),
  rel_level     int default 1,
  rel_xp        int default 0,
  created_at    timestamptz default now(),
  unique(user_a, user_b)
);

alter table persona_matches enable row level security;
create policy "public" on persona_matches for all using (true) with check (true);
alter publication supabase_realtime add table persona_matches;
create index if not exists idx_persona_matches_users on persona_matches(user_a, user_b);
