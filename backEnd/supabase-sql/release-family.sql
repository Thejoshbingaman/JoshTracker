-- =====================================================================
-- JoshTracker: watchdog, milestone notes, Mom's account, realtime
-- Run this whole file once in the Supabase SQL Editor.
-- =====================================================================

-- ---------- 1. Watchdog: heartbeats and API call log (server only) ----------
create table if not exists heartbeats (
  name text primary key,                  -- "check-flights", "smart-processor"
  last_ok timestamptz not null default now(),
  detail text
);
alter table heartbeats enable row level security;   -- no policies = only the server can see it

create table if not exists api_calls (
  id bigint generated always as identity primary key,
  api text not null,                      -- "flightaware"
  at timestamptz not null default now()
);
alter table api_calls enable row level security;

-- ---------- 2. Milestone notes (Arc's 50th and 100th of each button) ----------
create table if not exists milestones (
  id bigint generated always as identity primary key,
  type text not null check (type in ('kiss', 'hug', 'punch')),
  count int not null,
  title text,
  note text not null,
  unlocked_at timestamptz,               -- set by send-kiss when she reaches the count
  seen_at timestamptz,                   -- set by the app when she closes the note
  unique (type, count)
);
alter table milestones enable row level security;

-- She can only read a note once it is unlocked (no peeking), and only set seen_at
drop policy if exists "Read unlocked milestones" on milestones;
create policy "Read unlocked milestones" on milestones
  for select to authenticated using (unlocked_at is not null);
drop policy if exists "Mark milestones seen" on milestones;
create policy "Mark milestones seen" on milestones
  for update to authenticated using (unlocked_at is not null) with check (unlocked_at is not null);
revoke update on milestones from authenticated;
grant update (seen_at) on milestones to authenticated;

-- ---------- 3. Family accounts (Mom) see only the tracker ----------
-- "Restrictive" policies are ANDed with the existing ones: family accounts get nothing here.
-- The role lives in app_metadata, which only the server (or you, in SQL) can change.
drop policy if exists "No family: pings" on pings;
create policy "No family: pings" on pings as restrictive for all to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'family');

drop policy if exists "No family: next_visit" on next_visit;
create policy "No family: next_visit" on next_visit as restrictive for all to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'family');

drop policy if exists "No family: milestones" on milestones;
create policy "No family: milestones" on milestones as restrictive for all to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'family');

drop policy if exists "No family: welcome_note" on welcome_note;
create policy "No family: welcome_note" on welcome_note as restrictive for all to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'family');

-- ---------- 4. Hotel time zone (for "It's 6:12 PM where Josh is") ----------
alter table stays add column if not exists tz text;

-- ---------- 5. Realtime: the open app updates the moment data changes ----------
do $$
declare t text;
begin
  foreach t in array array['flights', 'stays', 'pings', 'next_visit', 'milestones'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
