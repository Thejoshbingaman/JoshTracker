-- Easter eggs. Run once in the Supabase SQL Editor.

-- Which eggs each person has found
create table if not exists easter_eggs (
  user_id uuid not null references auth.users (id) on delete cascade,
  egg text not null,
  found_at timestamptz default now(),
  primary key (user_id, egg)
);
alter table easter_eggs enable row level security;
drop policy if exists "Eggs: read" on easter_eggs;
create policy "Eggs: read" on easter_eggs for select to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'family');
-- (Finding an egg is saved by the send-kiss function, which also alerts Josh.)

-- Private text for the eggs (kept out of the public code on GitHub)
create table if not exists secrets (
  key text primary key,
  value text
);
alter table secrets enable row level security;
drop policy if exists "Secrets: read" on secrets;
create policy "Secrets: read" on secrets for select to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'family');
