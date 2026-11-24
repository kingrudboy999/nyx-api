alter table media_uploads drop constraint if exists media_uploads_purpose_check;
alter table media_uploads add constraint media_uploads_purpose_check
  check (purpose in ('video', 'status', 'post', 'chat', 'story', 'banner'));
