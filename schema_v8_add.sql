-- Soulscope v8 추가 스키마
-- schema.sql + schema_v6_add.sql 실행 후 이것도 실행

-- read_at 컬럼 추가 (읽음 처리)
alter table persona_matches add column if not exists read_at timestamptz;

-- confidence 컬럼 추가
alter table persona_matches add column if not exists confidence int default 0;
alter table soul_vectors    add column if not exists confidence int default 0;

-- match_queue 테이블 (백그라운드 매칭 큐)
create table if not exists match_queue (
  id         uuid primary key default gen_random_uuid(),
  user_a     uuid references users(id) on delete cascade,
  user_b     uuid references users(id) on delete cascade,
  status     text default 'queued',
  created_at timestamptz default now()
);
alter table match_queue enable row level security;
create policy "public" on match_queue for all using (true) with check (true);

-- persona_matches realtime
alter publication supabase_realtime add table persona_matches;

-- 인덱스
create index if not exists idx_users_id_list   on users(id);
create index if not exists idx_pmatches_status on persona_matches(status);
create index if not exists idx_pmatches_users  on persona_matches(user_a, user_b);

-- ① PIN 기반 계정 보호
alter table users add column if not exists pin_hash text;
-- 닉네임 중복 방지 (복구 위해 필수)
create unique index if not exists idx_users_nickname on users(nickname);
