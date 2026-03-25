-- ════════════════════════════════════════════════════════
-- SOULSCOPE 새 구조 SQL 스키마
-- Supabase Dashboard > SQL Editor 에서 전체 실행
-- ════════════════════════════════════════════════════════

-- ── 유저 ──
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  nickname      text not null,
  bio           text,
  img_url       text,
  profile_pct   int default 0,        -- 프로파일 완성도 0~100
  created_at    timestamptz default now(),
  last_active   timestamptz default now()
);

-- ── 심리 벡터 (대화할수록 업데이트) ──
create table if not exists soul_vectors (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references users(id) on delete cascade unique,
  core_emotion    text,
  attachment      text,
  conflict        text,
  love_lang       text,
  fear            text,
  shine           text,
  voice           text,
  pattern         text,
  emoji           text default '✨',
  color           text default '#B8915A',
  tags            text[] default '{}',
  raw_scores      jsonb default '{}',  -- 세부 수치
  updated_at      timestamptz default now()
);

-- ── AI 대화 기록 (학습 원천) ──
create table if not exists soul_chats (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references users(id) on delete cascade,
  role        text not null,           -- 'ai' | 'user'
  content     text not null,
  chat_type   text default 'daily',    -- 'daily' | 'deep' | 'free'
  created_at  timestamptz default now()
);

-- ── 매칭 ──
create table if not exists matches (
  id            uuid primary key default gen_random_uuid(),
  user_a        uuid references users(id) on delete cascade,
  user_b        uuid references users(id) on delete cascade,
  score         int,
  tier          text,
  dynamics      jsonb,                  -- 관계 역학
  report        jsonb,                  -- 100년 리포트
  stories       jsonb,                  -- 시뮬레이션 스토리
  status        text default 'pending', -- 'pending'|'accepted'|'rejected'
  created_at    timestamptz default now(),
  unique(user_a, user_b)
);

-- ── 채팅방 (매칭 후 실제 대화) ──
create table if not exists chat_rooms (
  id          uuid primary key default gen_random_uuid(),
  match_id    uuid references matches(id) on delete cascade unique,
  created_at  timestamptz default now()
);

-- ── 채팅 메시지 (실시간) ──
create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid references chat_rooms(id) on delete cascade,
  sender_id   uuid references users(id) on delete cascade,
  content     text not null,
  read_at     timestamptz,
  created_at  timestamptz default now()
);

-- ── 좋아요 ──
create table if not exists likes (
  user_id     uuid references users(id) on delete cascade,
  target_id   uuid references users(id) on delete cascade,
  created_at  timestamptz default now(),
  primary key (user_id, target_id)
);

-- ════════════════════════════════════════════════════════
-- RLS (Row Level Security)
-- ════════════════════════════════════════════════════════
alter table users       enable row level security;
alter table soul_vectors enable row level security;
alter table soul_chats  enable row level security;
alter table matches     enable row level security;
alter table chat_rooms  enable row level security;
alter table messages    enable row level security;
alter table likes       enable row level security;

-- 모두 공개 (anon key로 접근, 앱에서 user_id로 필터링)
create policy "public" on users        for all using (true) with check (true);
create policy "public" on soul_vectors for all using (true) with check (true);
create policy "public" on soul_chats   for all using (true) with check (true);
create policy "public" on matches      for all using (true) with check (true);
create policy "public" on chat_rooms   for all using (true) with check (true);
create policy "public" on messages     for all using (true) with check (true);
create policy "public" on likes        for all using (true) with check (true);

-- ════════════════════════════════════════════════════════
-- 실시간 구독 활성화
-- ════════════════════════════════════════════════════════
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table matches;

-- ════════════════════════════════════════════════════════
-- 인덱스
-- ════════════════════════════════════════════════════════
create index if not exists idx_soul_chats_user on soul_chats(user_id, created_at desc);
create index if not exists idx_messages_room   on messages(room_id, created_at asc);
create index if not exists idx_matches_users   on matches(user_a, user_b);
create index if not exists idx_users_active    on users(last_active desc);
