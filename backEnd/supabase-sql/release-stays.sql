-- Hotel stays from Google Calendar ("Stay at ..." events)
create table if not exists stays (
  id bigint generated always as identity primary key,
  event_id text unique not null,         -- Google Calendar event id
  hotel text,
  address text,
  city text,
  state text,
  lat double precision,
  lon double precision,
  check_in timestamptz not null,
  check_out timestamptz not null,
  updated_at timestamptz default now()
);
alter table stays enable row level security;
create policy "Logged-in users can read stays"
  on stays for select to authenticated using (true);
