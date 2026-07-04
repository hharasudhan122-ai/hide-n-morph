-- Run this in Supabase SQL Editor to pick up the new round-outcome column
-- without re-running the entire schema.sql.

alter table rooms
  add column if not exists last_outcome text
  check (last_outcome in ('hiders_win','seekers_win'));
