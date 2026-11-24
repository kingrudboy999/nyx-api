-- Reddit-style community fields. Existing communities, posts, and members stay.

alter table communities add column if not exists banner_url text;
alter table communities add column if not exists category text not null default '';
alter table communities add column if not exists access text not null default 'public';
alter table communities add column if not exists nsfw boolean not null default false;
alter table communities add column if not exists about text not null default '';
alter table communities add column if not exists post_count integer not null default 0;

update communities set access = 'private' where is_private = true and access = 'public';

alter table community_posts add column if not exists title text not null default '';
alter table community_posts add column if not exists link_url text;
alter table community_posts add column if not exists score integer not null default 0;
alter table community_posts add column if not exists upvotes integer not null default 0;
alter table community_posts add column if not exists downvotes integer not null default 0;
alter table community_posts add column if not exists pinned boolean not null default false;
alter table community_posts add column if not exists locked boolean not null default false;
alter table community_posts add column if not exists is_removed boolean not null default false;
alter table community_posts add column if not exists flair text not null default '';

create table if not exists community_votes (
  post_id text not null references community_posts(id) on delete cascade,
  user_id text not null references profiles(user_id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists community_comments (
  id text primary key,
  post_id text not null references community_posts(id) on delete cascade,
  parent_id text,
  author_id text not null references profiles(user_id) on delete cascade,
  body text not null,
  score integer not null default 0,
  is_removed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists community_comments_post_idx on community_comments (post_id, created_at);

create table if not exists community_comment_votes (
  comment_id text not null references community_comments(id) on delete cascade,
  user_id text not null references profiles(user_id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  primary key (comment_id, user_id)
);

create table if not exists community_rules (
  id text primary key,
  community_id text not null references communities(id) on delete cascade,
  title text not null,
  body text not null default '',
  sort_order integer not null default 0,
  active boolean not null default true
);
create index if not exists community_rules_idx on community_rules (community_id, sort_order);

create table if not exists community_join_requests (
  community_id text not null references communities(id) on delete cascade,
  user_id text not null references profiles(user_id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  primary key (community_id, user_id)
);

create table if not exists community_bans (
  community_id text not null references communities(id) on delete cascade,
  user_id text not null references profiles(user_id) on delete cascade,
  reason text not null default '',
  until_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (community_id, user_id)
);

create table if not exists community_flairs (
  id text primary key,
  community_id text not null references communities(id) on delete cascade,
  label text not null,
  created_at timestamptz not null default now()
);

create index if not exists community_posts_rank_idx on community_posts (community_id, pinned desc, score desc, created_at desc);
