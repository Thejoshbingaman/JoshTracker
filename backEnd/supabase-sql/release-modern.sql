-- JoshTracker: tables for the scoreboard and "next time together"
-- Run once in Supabase → SQL Editor.

-- Every kiss / hug / punch, so the app can count them
create table if not exists pings (
  id bigint generated always as identity primary key,
  sender_id uuid references auth.users(id) on delete cascade,
  sender_name text,
  type text not null,
  created_at timestamptz default now()
);
alter table pings enable row level security;
create policy "Logged-in users can read pings"
  on pings for select to authenticated using (true);

-- One shared "next time together" date
create table if not exists next_visit (
  id int primary key default 1,
  title text,
  at timestamptz,
  constraint one_row check (id = 1)
);
alter table next_visit enable row level security;
create policy "Logged-in users can read next visit"
  on next_visit for select to authenticated using (true);
create policy "Logged-in users can set next visit"
  on next_visit for insert to authenticated with check (id = 1);
create policy "Logged-in users can change next visit"
  on next_visit for update to authenticated using (id = 1) with check (id = 1);
