-- Restore-all pass: call lifecycle parity, WebRTC signaling relay.
-- Additive only (kai_threads.share_id already exists since 0007_omniai).

alter table calls add column if not exists answered_at timestamptz;
alter table call_participants add column if not exists outcome text not null default 'ringing';
create index if not exists call_participants_outcome_idx on call_participants (call_id, outcome);

create table if not exists webrtc_peers (
  room text not null,
  peer_id text not null,
  name text not null default '',
  last_seen timestamptz not null default now(),
  primary key (room, peer_id)
);

create table if not exists webrtc_signals (
  id bigserial primary key,
  room text not null,
  to_peer text not null,
  from_peer text not null,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists webrtc_signals_inbox on webrtc_signals (room, to_peer, id);

-- 0019 split subscriptions into product families and created
-- subscriptions_user_family_live_idx (user_id, family). Make sure the legacy
-- user-only index from 0018 is gone so a user can hold two families at once.
drop index if exists subscriptions_user_live_idx;
create unique index if not exists subscriptions_user_family_live_idx
  on subscriptions (user_id, family)
  where status in ('trial', 'active', 'grace', 'billing_retry');
