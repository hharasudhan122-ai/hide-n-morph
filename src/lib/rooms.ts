import { supabase } from '../lib/supabaseClient';
import type { RoomRow, PlayerRow, RoomStatus } from '../types/game';

const MAX_PLAYERS_PER_ROOM = 4;

// ---------------------------------------------------------------
// Room creation / joining
// ---------------------------------------------------------------

interface CreateRoomResult {
  room: RoomRow;
  player: PlayerRow;
}

/** Creates a room + inserts the creator as the host player. Retries the
 * room-code generation on the rare unique-constraint collision (see the
 * note in schema.sql next to the `code` column). */
export async function createRoom(
  displayName: string,
  mapId: string = 'quickstop-store'
): Promise<CreateRoomResult> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateClientSideCode();

    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .insert({
        code,
        map_id: mapId,
        status: 'lobby' as RoomStatus,
        // host_id intentionally omitted — null until the host's player
        // row is created below, then patched in.
      })
      .select()
      .single();

    if (roomError) {
      // unique_violation on code -> retry with a new code
      if (roomError.code === '23505') {
        lastError = roomError;
        continue;
      }
      console.error('[createRoom] room insert failed:', roomError);
      throw new Error(`Room insert failed: ${roomError.message} (code: ${roomError.code ?? 'unknown'})`);
    }

    const { data: player, error: playerError } = await supabase
      .from('players')
      .insert({
        room_id: room.id,
        display_name: displayName,
        is_host: true,
      })
      .select()
      .single();

    if (playerError) {
      console.error('[createRoom] host player insert failed:', playerError);
      throw new Error(`Player insert failed: ${playerError.message} (code: ${playerError.code ?? 'unknown'})`);
    }

    // patch host_id now that we have the real player id
    const { data: updatedRoom, error: updateError } = await supabase
      .from('rooms')
      .update({ host_id: player.id })
      .eq('id', room.id)
      .select()
      .single();

    if (updateError) {
      console.error('[createRoom] host_id patch failed:', updateError);
      throw new Error(`Setting host failed: ${updateError.message} (code: ${updateError.code ?? 'unknown'})`);
    }

    return { room: updatedRoom, player };
  }

  throw lastError ?? new Error('Failed to create room after retries');
}

interface JoinRoomResult {
  room: RoomRow;
  player: PlayerRow;
}

export async function joinRoom(code: string, displayName: string): Promise<JoinRoomResult> {
  const normalizedCode = code.trim().toUpperCase();

  const { data: room, error: roomError } = await supabase
    .from('rooms')
    .select()
    .eq('code', normalizedCode)
    .single();

  if (roomError) throw new Error(`Room "${normalizedCode}" not found`);
  if (room.status !== 'lobby') throw new Error('This room has already started or ended');

  const { count, error: countError } = await supabase
    .from('players')
    .select('id', { count: 'exact', head: true })
    .eq('room_id', room.id);

  if (countError) throw countError;
  if ((count ?? 0) >= MAX_PLAYERS_PER_ROOM) {
    throw new Error(`Room is full (max ${MAX_PLAYERS_PER_ROOM} players)`);
  }

  const { data: player, error: playerError } = await supabase
    .from('players')
    .insert({
      room_id: room.id,
      display_name: displayName,
      is_host: false,
    })
    .select()
    .single();

  if (playerError) throw playerError;

  return { room, player };
}

export async function leaveRoom(playerId: string): Promise<void> {
  const { error } = await supabase.from('players').delete().eq('id', playerId);
  if (error) throw error;
}

// ---------------------------------------------------------------
// Realtime subscriptions
// ---------------------------------------------------------------

type RoomChangeHandler = (room: RoomRow) => void;
type PlayersChangeHandler = (players: PlayerRow[]) => void;

/** Subscribes to both the room row (status changes) and the players table
 * (join/leave/move) for a given room. Returns an unsubscribe function —
 * always call it on unmount, or you'll leak channels across screens. */
export function subscribeToRoom(
  roomId: string,
  onRoomChange: RoomChangeHandler,
  onPlayersChange: PlayersChangeHandler
): () => void {
  const channel = supabase
    .channel(`room:${roomId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
      (payload) => {
        if (payload.eventType !== 'DELETE') {
          onRoomChange(payload.new as RoomRow);
        }
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${roomId}` },
      async () => {
        // Any insert/update/delete on players -> refetch the full list.
        // Simpler and safer than patching local state piecemeal, and at
        // 2-4 players this refetch is cheap.
        const { data, error } = await supabase
          .from('players')
          .select()
          .eq('room_id', roomId)
          .order('joined_at', { ascending: true });

        if (!error && data) {
          onPlayersChange(data);
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// ---------------------------------------------------------------
// Host actions
// ---------------------------------------------------------------

/** Randomly assigns one seeker and the rest hiders, then flips room
 * status to 'countdown'. Only the host should call this (enforce in UI
 * by hiding the "Start Game" button for non-hosts; real enforcement
 * happens once auth/RLS is tightened per the note in schema.sql). */
export async function startGame(roomId: string, playerIds: string[]): Promise<void> {
  if (playerIds.length < 2) {
    throw new Error('Need at least 2 players to start (1 seeker + 1 hider)');
  }

  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  const seekerId = shuffled[0];
  const hiderIds = shuffled.slice(1);

  await Promise.all([
    supabase.from('players').update({ role: 'seeker', hp: 100, is_alive: true, morphed_into: null }).eq('id', seekerId),
    ...hiderIds.map((id) =>
      supabase.from('players').update({ role: 'hider', hp: 100, is_alive: true, morphed_into: null }).eq('id', id)
    ),
  ]);

  const { error } = await supabase
    .from('rooms')
    .update({ status: 'countdown', round_started_at: new Date().toISOString() })
    .eq('id', roomId);

  if (error) throw error;
}

// ---------------------------------------------------------------
// Combat / round-end logic
// ---------------------------------------------------------------

const DAMAGE_PER_SHOT = 20;

interface DamageResult {
  newHp: number;
  converted: boolean; // true if this shot dropped the hider to 0 and converted them
}

/** Applies one shot's damage to a hider and handles the convert-to-seeker
 * transition per the locked game rules: hitting 0 HP flips role to
 * 'seeker' (invulnerable from that point on) rather than removing the
 * player from the round. Morph state is cleared on conversion since a
 * seeker can never be morphed — but note this is the ONLY thing that
 * clears morphed_into; taking damage while still a hider does NOT
 * force an un-morph (per design: morph is fully player-controlled until
 * the moment of conversion).
 *
 * NOTE: this performs the HP update directly from the client for now.
 * Per the hardening note in schema.sql, this should eventually move
 * behind a service-role Edge Function that validates the shot's
 * range/angle server-side before applying damage — otherwise a
 * modified client could self-report arbitrary hits. Fine for a small
 * private-room game among friends in the meantime.
 */
export async function applyDamage(targetPlayerId: string, currentHp: number): Promise<DamageResult> {
  const newHp = Math.max(0, currentHp - DAMAGE_PER_SHOT);
  const converted = newHp <= 0;

  const { error } = await supabase
    .from('players')
    .update(
      converted
        ? { hp: 0, role: 'seeker', morphed_into: null }
        : { hp: newHp }
    )
    .eq('id', targetPlayerId);

  if (error) throw error;

  return { newHp, converted };
}

/** Call after every applyDamage to see if the round should end.
 * Per the locked rule: there's no early win for seekers — the round
 * is timer-based. This function only reports the "all hiders
 * converted" case so the host's client can decide to end the round
 * early rather than waiting out a now-pointless timer. The "hiders
 * survive to timer end" win is checked by a countdown in the game
 * screen itself, not here. */
export async function allHidersConverted(roomId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('players')
    .select('role')
    .eq('room_id', roomId);

  if (error) throw error;
  if (!data || data.length === 0) return false;

  const hiderCount = data.filter((p) => p.role === 'hider').length;
  return hiderCount === 0;
}

export type RoundOutcome = 'hiders_win' | 'seekers_win';

/** Ends the round and records the outcome. Called either when the
 * round timer expires (hiders_win, since they survived) or when
 * allHidersConverted() returns true (seekers_win, no need to wait
 * out the rest of the timer). */
export async function endRound(roomId: string, outcome: RoundOutcome): Promise<void> {
  const { error } = await supabase
    .from('rooms')
    .update({ status: 'ended', last_outcome: outcome })
    .eq('id', roomId);

  if (error) throw error;
}

// ---------------------------------------------------------------
// Morph
// ---------------------------------------------------------------

export type MorphResult =
  | { ok: true }
  | { ok: false; reason: 'occupied' | 'not_a_hider' | 'error' };

/** Attempts to morph the given player into the given morphable prop
 * instance. Enforces the one rule that keeps morph meaningful: you
 * can't morph into an instance another hider currently occupies (same
 * `morphableId`, not just same group — two hiders CAN be different
 * instances in the same group, that's the intended "needle in a
 * haystack" tension).
 *
 * Range-checking (is the player actually close enough to this prop) is
 * the CALLER's responsibility — done client-side against the manifest's
 * footprint before this is ever called, since that's a spatial/3D
 * concern this data-layer function shouldn't need to know about.
 *
 * Role is also re-checked here (not just trusted from the caller) since
 * a seeker should never be able to morph even if some UI bug let the
 * button render for them. */
export async function tryMorph(playerId: string, morphableId: string): Promise<MorphResult> {
  const { data: self, error: selfError } = await supabase
    .from('players')
    .select('role, room_id')
    .eq('id', playerId)
    .single();

  if (selfError || !self) return { ok: false, reason: 'error' };
  if (self.role !== 'hider') return { ok: false, reason: 'not_a_hider' };

  const { data: occupant, error: occupantError } = await supabase
    .from('players')
    .select('id')
    .eq('room_id', self.room_id)
    .eq('morphed_into', morphableId)
    .maybeSingle();

  if (occupantError) return { ok: false, reason: 'error' };
  if (occupant && occupant.id !== playerId) return { ok: false, reason: 'occupied' };

  // NOTE: there's a small race window here — two hiders could both pass
  // the occupant check and then both write the same morphableId a few ms
  // apart, since this isn't wrapped in a DB-level transaction/lock. At
  // 2-4 players clicking morph on the exact same prop in the same
  // instant is rare enough to accept for v1. If it ever matters, this
  // becomes a Postgres function with a `select ... for update` lock
  // instead of two round-trips from the client.
  const { error: updateError } = await supabase
    .from('players')
    .update({ morphed_into: morphableId })
    .eq('id', playerId);

  if (updateError) return { ok: false, reason: 'error' };
  return { ok: true };
}

/** Voluntary un-morph. Per the locked game rules, this is the ONLY
 * other way morph state changes besides conversion-to-seeker — damage
 * never forces it. */
export async function unmorph(playerId: string): Promise<void> {
  const { error } = await supabase
    .from('players')
    .update({ morphed_into: null })
    .eq('id', playerId);

  if (error) throw error;
}

/** Updates a morphed player's rot_y directly — used by the ←/→ key
 * rotation control so a hider can manually align their disguise to
 * match the real prop's orientation. This intentionally writes to the
 * SAME rot_y column position-sync already uses; while morphed, normal
 * camera-look rotation sync is paused by the caller (useMorphSystem)
 * so the two control schemes don't fight over the same field. */
export async function setMorphRotation(playerId: string, rotationY: number): Promise<void> {
  const { error } = await supabase
    .from('players')
    .update({ rot_y: rotationY })
    .eq('id', playerId);

  if (error) throw error;
}

function generateClientSideCode(): string {
  // Mirrors generate_room_code() in schema.sql, kept client-side too so
  // we can show a code in the UI before the insert round-trips. The DB
  // unique constraint is still the source of truth on collision.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
