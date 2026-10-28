-- Postcards: a photo and a short message from wherever you are. Run once in the Supabase SQL Editor.

-- 1. The postcards
create table if not exists postcards (
  id bigint generated always as identity primary key,
  sender_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sender_name text,
  city text,
  message text not null check (char_length(message) between 1 and 500),
  photo_path text,
  created_at timestamptz default now()
);
alter table postcards enable row level security;

drop policy if exists "Postcards: read" on postcards;
create policy "Postcards: read" on postcards for select to authenticated using (true);
drop policy if exists "Postcards: send own" on postcards;
create policy "Postcards: send own" on postcards for insert to authenticated with check (sender_id = auth.uid());
drop policy if exists "Postcards: delete own" on postcards;
create policy "Postcards: delete own" on postcards for delete to authenticated using (sender_id = auth.uid());
-- Family accounts (Mom) can't see or send postcards
drop policy if exists "No family: postcards" on postcards;
create policy "No family: postcards" on postcards as restrictive for all to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'family');

-- 2. A private folder for the photos. Each person uploads into their own folder ("<id>/...").
insert into storage.buckets (id, name, public)
values ('postcards', 'postcards', false)
on conflict (id) do nothing;

drop policy if exists "Postcards: read photos" on storage.objects;
create policy "Postcards: read photos" on storage.objects for select to authenticated
  using (bucket_id = 'postcards' and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'family');
drop policy if exists "Postcards: upload own" on storage.objects;
create policy "Postcards: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'postcards' and (storage.foldername(name))[1] = auth.uid()::text
              and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'family');

-- 3. Live updates (a new postcard shows at once)
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'postcards') then
    alter publication supabase_realtime add table public.postcards;
  end if;
end $$;
