-- Kilo core schema. Users live in Supabase Auth and are referenced by id only.

create table batches (
  id uuid primary key,
  user_id uuid not null,
  settings jsonb not null,
  ready_notified_at timestamptz,
  created_at timestamptz not null default now()
);
create index batches_user_idx on batches (user_id, created_at desc);

create table videos (
  id uuid primary key,
  user_id uuid not null,
  batch_id uuid not null references batches (id) on delete cascade,
  title text not null,
  source text not null check (source in ('upload', 'recorder')),
  script jsonb,
  settings jsonb not null,
  status text not null default 'uploading'
    check (status in ('uploading', 'queued', 'analyzing', 'ready_for_review', 'rendering', 'done', 'failed')),
  error text,
  proxy_key text,
  clip_offsets jsonb,
  stock_done boolean not null default false,
  analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index videos_user_idx on videos (user_id, created_at desc);
create index videos_batch_idx on videos (batch_id);

create table clips (
  id uuid primary key,
  user_id uuid not null,
  video_id uuid not null references videos (id) on delete cascade,
  ord integer not null,
  filename text not null,
  content_type text not null,
  size_bytes bigint not null,
  ext text not null,
  script_line_index integer,
  take_number integer,
  uploaded_at timestamptz,
  -- ClipInfo, set by ingest
  info jsonb,
  normalized_key text,
  thumb_key text,
  -- SilenceGap[], set by detectSilence
  silences jsonb,
  created_at timestamptz not null default now(),
  unique (video_id, ord)
);
create index clips_video_idx on clips (video_id);

create table transcripts (
  clip_id uuid primary key references clips (id) on delete cascade,
  user_id uuid not null,
  video_id uuid not null references videos (id) on delete cascade,
  transcript jsonb not null,
  created_at timestamptz not null default now()
);
create index transcripts_video_idx on transcripts (video_id);

-- Every saved EDL is kept; the current one is the highest revision.
create table edls (
  video_id uuid not null references videos (id) on delete cascade,
  revision integer not null,
  user_id uuid not null,
  edl jsonb not null,
  author text not null check (author in ('decider', 'user', 'replan', 'system')),
  created_at timestamptz not null default now(),
  primary key (video_id, revision)
);

create table broll_assets (
  id uuid primary key,
  user_id uuid not null,
  video_id uuid not null references videos (id) on delete cascade,
  kind text not null check (kind in ('video', 'image')),
  source text not null default 'user' check (source in ('user', 'stock')),
  filename text not null,
  content_type text not null,
  size_bytes bigint not null default 0,
  ext text not null,
  attribution text,
  stock_query text,
  -- True for assets created with the batch: the video waits for them before analysis.
  initial boolean not null default false,
  status text not null default 'uploading' check (status in ('uploading', 'processing', 'ready', 'failed')),
  uploaded_at timestamptz,
  -- BrollAsset, set by ingest
  info jsonb,
  normalized_key text,
  thumb_key text,
  created_at timestamptz not null default now()
);
create index broll_video_idx on broll_assets (video_id);

create table renders (
  id uuid primary key,
  user_id uuid not null,
  video_id uuid not null references videos (id) on delete cascade,
  variant_id text,
  quality text not null check (quality in ('preview', 'final')),
  status text not null default 'queued' check (status in ('queued', 'rendering', 'done', 'failed')),
  progress real not null default 0,
  edl_revision integer not null,
  output_key text,
  duration_sec double precision,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index renders_video_idx on renders (video_id, created_at);

create table styles (
  id uuid primary key,
  user_id uuid not null,
  name text not null,
  settings jsonb not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index styles_user_idx on styles (user_id, created_at);
create unique index styles_one_default on styles (user_id) where is_default;

create table goals (
  user_id uuid primary key,
  videos_per_week integer not null default 0 check (videos_per_week between 0 and 50),
  reminder_enabled boolean not null default false,
  reminder_hour integer not null default 18 check (reminder_hour between 0 and 23),
  time_zone text not null default 'UTC',
  -- Local date of the last reminder sent, so at most one goes out a day.
  last_reminded_on date,
  updated_at timestamptz not null default now()
);

create table posts (
  id uuid primary key,
  user_id uuid not null,
  video_id uuid references videos (id) on delete set null,
  platform text not null check (platform in ('tiktok', 'instagram', 'other')),
  posted_at timestamptz not null default now()
);
create index posts_user_idx on posts (user_id, posted_at);
create index posts_video_idx on posts (video_id);

create table devices (
  id uuid primary key,
  user_id uuid not null,
  expo_push_token text not null unique,
  platform text not null check (platform in ('ios', 'android', 'web')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index devices_user_idx on devices (user_id);
