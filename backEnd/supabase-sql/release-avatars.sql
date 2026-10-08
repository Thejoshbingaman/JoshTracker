-- Profile photos. Run once in the Supabase SQL Editor.

-- 1. A private storage folder for the photos
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do nothing;

-- Signed-in users can see the photos; each person can only upload or replace their own ("<their id>.jpg")
drop policy if exists "Avatars: read" on storage.objects;
create policy "Avatars: read" on storage.objects
  for select to authenticated using (bucket_id = 'avatars');
drop policy if exists "Avatars: upload own" on storage.objects;
create policy "Avatars: upload own" on storage.objects
  for insert to authenticated with check (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');
drop policy if exists "Avatars: replace own" on storage.objects;
create policy "Avatars: replace own" on storage.objects
  for update to authenticated using (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');

-- 2. Who has a photo (so each phone can show the other person's face)
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text,
  avatar_path text,
  is_family boolean default false,
  updated_at timestamptz default now()
);
alter table profiles enable row level security;
drop policy if exists "Profiles: read" on profiles;
create policy "Profiles: read" on profiles for select to authenticated using (true);
drop policy if exists "Profiles: write own" on profiles;
create policy "Profiles: write own" on profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists "Profiles: update own" on profiles;
create policy "Profiles: update own" on profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
