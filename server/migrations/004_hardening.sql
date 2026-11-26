-- Hardening after review: the no-speech notice, crash-recovery counters and usage records for per-user limits.

-- Something the creator should know about a video that did not fail (e.g. no speech was heard).
alter table videos add column if not exists notice text;

-- How many times a job was found orphaned (its worker died) and queued again; bounded so a file that kills workers fails.
alter table videos add column if not exists recoveries integer not null default 0;
alter table renders add column if not exists recoveries integer not null default 0;

-- Requests counted against per-user rate limits (replans per video per hour).
create table if not exists usage_events (
  id bigserial primary key,
  user_id uuid not null,
  kind text not null,
  video_id uuid,
  at timestamptz not null default now()
);
create index if not exists usage_events_user_kind_idx on usage_events (user_id, kind, at);

create index if not exists videos_user_status_idx on videos (user_id, status);
create index if not exists renders_user_status_idx on renders (user_id, status);
create index if not exists renders_video_variant_idx on renders (video_id, quality, edl_revision);
