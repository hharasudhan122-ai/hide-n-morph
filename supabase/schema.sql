-- ============================================================
-- HIDE N MORPH — Supabase Schema
-- Run this in the Supabase SQL editor (or via `supabase db push`)
-- ============================================================

-- ----------------------------------------------------------------
-- ROOMS
-- ----------------------------------------------------------------
create table if not exists rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,              -- short human-friendly join code, e.g. "FOX482"
                                                    -- app layer should retry generate_room_code() on
                                                    -- unique-violation when creating a room (rare collision)
  map_id      text not null default 'quickstop-store',
  status      text not null default 'lobby'      -- 'lobby' | 'countdown' | 'playing' | 'ended'
              check (status in ('lobby','countdown','playing','ended')),
  host_id     uuid,                                -- references players.id of whoever created the room
                                                     -- nullable: briefly null between room insert and the
                                                     -- host's player insert (see createRoom in rooms.ts)
  round_seconds   integer not null default 180,    -- how long a round lasts once playing starts
  round_started_at timestamptz,
  last_outcome  text check (last_outcome in ('hiders_win','seekers_win')), -- set when status -> 'ended'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_rooms_code on rooms (code);

-- ----------------------------------------------------------------
-- PLAYERS
-- ----------------------------------------------------------------
create table if not exists players (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references rooms(id) on delete cascade,
  display_name  text not null,
  role          text check (role in ('seeker','hider')),   -- null while in lobby, assigned at round start.
                                                              -- A hider whose hp hits 0 flips this to 'seeker'
                                                              -- (see convert-to-seeker note below) rather than
                                                              -- being removed from the round.
  hp            integer not null default 100,                -- meaningless/ignored once role = 'seeker'
                                                              -- (seekers are invulnerable, never take damage)
  is_alive      boolean not null default true,                -- true for the whole round for everyone;
                                                              -- there is no "dead" state in this game, only
                                                              -- hider -> seeker conversion. Kept for possible
                                                              -- future use (e.g. disconnect handling).
  pos_x         real not null default 0,
  pos_y         real not null default 0,
  pos_z         real not null default 0,
  rot_y         real not null default 0,
  morphed_into  text,                              -- morphable id from manifest.json, null = not morphed
  is_host       boolean not null default false,
  last_seen_at  timestamptz not null default now(),
  joined_at     timestamptz not null default now()
);

create index if not exists idx_players_room on players (room_id);

-- ----------------------------------------------------------------
-- SHOT LOG (audit trail — also lets the Edge Function validate hits)
-- ----------------------------------------------------------------
create table if not exists shots (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references rooms(id) on delete cascade,
  shooter_id  uuid not null references players(id) on delete cascade,
  target_id   uuid references players(id) on delete cascade,  -- null if shot missed everyone
  hit         boolean not null default false,
  damage      integer not null default 0,
  shooter_pos real[3],
  shooter_dir real[3],
  created_at  timestamptz not null default now()
);

create index if not exists idx_shots_room on shots (room_id);

-- ----------------------------------------------------------------
-- updated_at trigger for rooms
-- ----------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_rooms_updated_at on rooms;
create trigger trg_rooms_updated_at
  before update on rooms
  for each row execute function set_updated_at();

-- ----------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------
alter table rooms enable row level security;
alter table players enable row level security;
alter table shots enable row level security;

-- Rooms: anyone can read a room (needed to join by code / see status).
-- Anyone can create a room. Only the host can update/delete it directly from
-- the client — but most state transitions (start round, end round) should
-- go through the Edge Function below rather than raw client updates.
create policy "rooms_select_all" on rooms
  for select using (true);

create policy "rooms_insert_any" on rooms
  for insert with check (true);

create policy "rooms_update_host_only" on rooms
  for update using (true);  -- tightened to host-only once you wire real auth; see note at bottom

-- Players: anyone can read players in any room (needed for opponents to see you).
-- Anyone can insert themselves as a new player. Players can only update their
-- OWN row directly (movement, morph state) — HP/damage changes are NOT done
-- via direct client update, they go through the validated Edge Function.
create policy "players_select_all" on players
  for select using (true);

create policy "players_insert_any" on players
  for insert with check (true);

create policy "players_update_own_movement" on players
  for update using (true);  -- tightened with auth.uid() once real auth is added; see note

-- Shots: insert-only from clients (the raw "I fired" event), no client updates/deletes.
-- The Edge Function uses the service role key to write the validated outcome.
create policy "shots_select_room" on shots
  for select using (true);

create policy "shots_insert_any" on shots
  for insert with check (true);

-- ----------------------------------------------------------------
-- Realtime: enable replication on the tables the game subscribes to
-- ----------------------------------------------------------------
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table shots;

-- ----------------------------------------------------------------
-- Helper: generate a short room code (6 chars, no ambiguous letters)
-- ----------------------------------------------------------------
create or replace function generate_room_code()
returns text as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- no O/0, I/1
  result text := '';
  i int;
begin
  for i in 1..6 loop
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  end loop;
  return result;
end;
$$ language plpgsql;

-- ----------------------------------------------------------------
-- Cleanup: remove stale lobby rooms older than 1 hour (run on a cron,
-- e.g. via Supabase scheduled Edge Function or pg_cron if enabled)
-- ----------------------------------------------------------------
-- select cron.schedule('cleanup-stale-rooms', '0 * * * *', $$
--   delete from rooms where status = 'lobby' and created_at < now() - interval '1 hour';
-- $$);

-- ============================================================
-- NOTE ON AUTH / RLS TIGHTENING
-- ============================================================
-- This schema uses permissive RLS (anyone can update any row) because v1
-- has no auth system — players are anonymous, identified only by the
-- player.id they're handed on join. This is fine for a small project
-- among friends, but it does mean a malicious client could move OTHER
-- players or edit their HP directly via the Supabase client.
--
-- Two practical ways to harden this later, in increasing order of effort:
-- 1. Use Supabase Anonymous Auth (auth.signInAnonymously()) so each
--    client has a real auth.uid(), then change policies to
--    `using (auth.uid() = id)` on players, `using (auth.uid() = host_id)`
--    on rooms.
-- 2. Move HP/damage writes exclusively through the Edge Function (already
--    the plan) using the service role key, and revoke client UPDATE
--    on players.hp specifically via a column-level policy or a trigger
--    that rejects HP changes not coming from the service role.
--
-- For now: ship v1 with this permissive schema, since the realistic
-- "threat model" is 2-4 friends in a private room code, not the public
-- internet. Revisit if this ever goes beyond that.
