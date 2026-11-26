-- Analysis progress (0..1) shown while a video is queued or analyzing.
alter table videos add column if not exists progress real not null default 0;
