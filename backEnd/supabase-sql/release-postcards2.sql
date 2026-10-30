-- Postcards, part 2: likes, comments, and full-quality photos. Run once in the Supabase SQL Editor.

-- 1. Where the full-quality original photo is saved
alter table postcards add column if not exists original_path text;

-- 2. Likes (one per person per postcard)
create table if not exists postcard_likes (
  postcard_id bigint not null references postcards (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz default now(),
  primary key (postcard_id, user_id)
);
alter table postcard_likes enable row level security;
drop policy if exists "Likes: read" on postcard_likes;
create policy "Likes: read" on postcard_likes for select to authenticated using (true);
drop policy if exists "Likes: add own" on postcard_likes;
create policy "Likes: add own" on postcard_likes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "Likes: remove own" on postcard_likes;
create policy "Likes: remove own" on postcard_likes for delete to authenticated using (user_id = auth.uid());
drop policy if exists "No family: postcard_likes" on postcard_likes;
create policy "No family: postcard_likes" on postcard_likes as restrictive for all to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'family');

-- 3. Comments
create table if not exists postcard_comments (
  id bigint generated always as identity primary key,
  postcard_id bigint not null references postcards (id) on delete cascade,
  sender_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sender_name text,
  body text not null check (char_length(body) between 1 and 300),
  created_at timestamptz default now()
);
alter table postcard_comments enable row level security;
drop policy if exists "Comments: read" on postcard_comments;
create policy "Comments: read" on postcard_comments for select to authenticated using (true);
drop policy if exists "Comments: add own" on postcard_comments;
create policy "Comments: add own" on postcard_comments for insert to authenticated with check (sender_id = auth.uid());
drop policy if exists "Comments: remove own" on postcard_comments;
create policy "Comments: remove own" on postcard_comments for delete to authenticated using (sender_id = auth.uid());
drop policy if exists "No family: postcard_comments" on postcard_comments;
create policy "No family: postcard_comments" on postcard_comments as restrictive for all to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'family');

-- 4. Full-size photos can be big (an iPhone photo is 3 to 8 MB). Allow up to 50 MB per file.
update storage.buckets set file_size_limit = 52428800 where id = 'postcards';

-- 5. Live updates
do $$
declare t text;
begin
  foreach t in array array['postcard_likes', 'postcard_comments'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
