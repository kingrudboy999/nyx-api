-- User-controlled feed signals and post collaborators. Existing posts stay intact.

create table if not exists feed_topic_mutes (
  user_id text not null references profiles(user_id) on delete cascade,
  tag text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, tag)
);

create table if not exists feed_boosts (
  user_id text not null references profiles(user_id) on delete cascade,
  target_kind text not null check (target_kind in ('author', 'tag')),
  target_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, target_kind, target_id)
);

create table if not exists post_collaborators (
  post_id text not null references posts(id) on delete cascade,
  user_id text not null references profiles(user_id) on delete cascade,
  invited_by text not null references profiles(user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists post_collaborators_user_idx on post_collaborators (user_id, status);
