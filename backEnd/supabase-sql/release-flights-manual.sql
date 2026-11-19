-- Fix flights and hotel stays from the app (Josh only): remove a flight or stay, change a flight, or add one by hand.
-- Safe to run again.
-- Run once in the Supabase SQL Editor, then deploy the new "manage-flight" function.

-- hidden = removed in the app. No alerts, no live checks, and the calendar sync can't bring it back.
alter table flights add column if not exists hidden boolean not null default false;

-- manual = added by hand in the app. The calendar sync never removes it.
alter table flights add column if not exists manual boolean not null default false;

-- Hotel stays can be removed too. The calendar sync can't bring a removed stay back.
alter table stays add column if not exists hidden boolean not null default false;
