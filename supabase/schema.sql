-- Health Binder database setup
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Every row belongs to one signed-in user, and Row Level Security makes sure
-- each user can only ever read or change their own rows and files.

create extension if not exists pgcrypto;

-- Visits, appointments and journal notes -------------------------------------
create table if not exists public.entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  cat         text not null default 'medical'
              check (cat in ('medical','dental','vision','lab','pharmacy','therapy','other')),
  date        date,
  title       text default '',
  provider    text default '',
  facility    text default '',
  phone       text default '',
  portal      text default '',
  diagnosis   text default '',
  outcome     text default '',
  follow_up   date,
  cost        numeric(10,2),          -- out-of-pocket cost
  notes       text default '',
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists entries_user_date on public.entries (user_id, date desc);

-- Medications ------------------------------------------------------------------
create table if not exists public.meds (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  dose        text default '',
  freq        text default '',
  purpose     text default '',
  prescriber  text default '',
  pharmacy    text default '',
  start_date  date,
  end_date    date,
  notes       text default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists meds_user on public.meds (user_id);

-- Attachments (the files themselves live in the private "attachments" bucket) ----
create table if not exists public.files (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_id    uuid not null references public.entries(id) on delete cascade,
  name        text not null,
  type        text default '',
  size        bigint default 0,
  path        text not null unique,   -- "<user id>/<file id>/<file name>" inside the bucket
  thumb       text,                   -- small JPEG preview as a data URL (images only)
  created_at  timestamptz not null default now()
);
create index if not exists files_entry on public.files (entry_id);

-- Saved analysis reports (written by the "analyze" Edge Function) ---------------
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  range_label text default '',
  focus       text default '',
  stats       jsonb not null default '{}'::jsonb,
  result      jsonb not null default '{}'::jsonb,
  model       text default '',
  created_at  timestamptz not null default now()
);
create index if not exists reports_user on public.reports (user_id, created_at desc);

-- Keep updated_at current -------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists entries_touch on public.entries;
create trigger entries_touch before update on public.entries for each row execute function public.touch_updated_at();
drop trigger if exists meds_touch on public.meds;
create trigger meds_touch before update on public.meds for each row execute function public.touch_updated_at();

-- Row Level Security: each user sees only their own rows ------------------------
alter table public.entries enable row level security;
alter table public.meds    enable row level security;
alter table public.files   enable row level security;
alter table public.reports enable row level security;

drop policy if exists "own reports" on public.reports;
create policy "own reports" on public.reports for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own entries" on public.entries;
create policy "own entries" on public.entries for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own meds" on public.meds;
create policy "own meds" on public.meds for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own files" on public.files;
create policy "own files" on public.files for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Private storage bucket for photos, PDFs and other documents (50 MB per file) ---
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 52428800)
on conflict (id) do update set public = false;

-- Files are stored under a folder named after the user's id; only that user can touch them.
drop policy if exists "own attachments read" on storage.objects;
create policy "own attachments read" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own attachments add" on storage.objects;
create policy "own attachments add" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own attachments change" on storage.objects;
create policy "own attachments change" on storage.objects for update to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own attachments delete" on storage.objects;
create policy "own attachments delete" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);
