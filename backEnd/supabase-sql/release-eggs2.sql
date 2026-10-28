-- More easter eggs: Josh's silly photo. Run once in the Supabase SQL Editor.

-- 1. Where the silly photo is saved
alter table profiles add column if not exists silly_path text;

-- 2. Each person can upload their own photo ("<id>.jpg") and their own silly photo ("<id>-silly.jpg")
drop policy if exists "Avatars: upload own" on storage.objects;
create policy "Avatars: upload own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'avatars' and name in (auth.uid()::text || '.jpg', auth.uid()::text || '-silly.jpg'));
drop policy if exists "Avatars: replace own" on storage.objects;
create policy "Avatars: replace own" on storage.objects
  for update to authenticated using (
    bucket_id = 'avatars' and name in (auth.uid()::text || '.jpg', auth.uid()::text || '-silly.jpg'));
