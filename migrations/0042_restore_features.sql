-- Restored feature set (2026-11-24): additive + idempotent.
alter table profiles add column if not exists ghost_mode boolean not null default false;
alter table conversation_members add column if not exists pinned boolean not null default false;
alter table posts add column if not exists boosted_until timestamptz;

create table if not exists tag_follows (
  user_id text not null references profiles(user_id) on delete cascade,
  tag_lc text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, tag_lc)
);

create table if not exists saved_collections (
  id text primary key,
  user_id text not null references profiles(user_id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists saved_collection_items (
  collection_id text not null references saved_collections(id) on delete cascade,
  post_id text not null references posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (collection_id, post_id)
);

create table if not exists ephemeral_pings (
  id text primary key,
  from_user_id text not null references profiles(user_id) on delete cascade,
  to_user_id text not null references profiles(user_id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists ephemeral_pings_to_idx on ephemeral_pings (to_user_id, created_at);
