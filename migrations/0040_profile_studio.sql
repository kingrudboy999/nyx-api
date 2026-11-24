alter table profiles add column if not exists banner_kind text not null default 'none';
alter table profiles add column if not exists banner_poster text;
alter table profiles add column if not exists banner_config text;
alter table profiles add column if not exists banner_draft text;
