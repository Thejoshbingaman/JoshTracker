-- Coupons that come with milestone notes. Run once in the SQL Editor.
alter table milestones add column if not exists coupon text;          -- short title: "Nails on me"
alter table milestones add column if not exists coupon_details text;  -- the fine print
alter table milestones add column if not exists redeemed_at timestamptz;
-- She can still only change seen_at from the app; using a coupon goes through send-kiss.
