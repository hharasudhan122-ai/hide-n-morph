import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { MapScene } from '../scenes/MapScene';
import { allHidersConverted, endRound } from '../lib/rooms';
import { useRoundTimer } from '../hooks/useRoundTimer';
import { useMapManifest } from '../hooks/useMapManifest';
import { ResultsScreen } from './ResultsScreen';
import type { RoomRow, PlayerRow, MorphableProp } from '../types/game';

interface GameScreenProps {
  room: RoomRow;
  selfPlayerId: string;
  initialPlayers: PlayerRow[];
  onBackToLobby: () => void;
}

const SEEKER_INTRO_SECONDS = 22;

/** Wraps MapScene with the live "who am I" state it needs. Role isn't
 * static for the whole round — a hider can convert to seeker mid-game —
 * so this subscribes to the self player's row specifically rather than
 * trusting a one-time snapshot passed in at game start. */
export function GameScreen({ room: initialRoom, selfPlayerId, initialPlayers, onBackToLobby }: GameScreenProps) {
  // room is held in local state (not just the prop) because status and
  // last_outcome change mid-session (round ends), and this component
  // needs to react to that to show ResultsScreen — same pattern as
  // selfPlayer below, which also can't just trust a static snapshot.
  const [room, setRoom] = useState<RoomRow>(initialRoom);
  const initialSelf = initialPlayers.find((p) => p.id === selfPlayerId) ?? null;
  const [selfPlayer, setSelfPlayer] = useState<PlayerRow | null>(initialSelf);
  const [otherPlayers, setOtherPlayers] = useState<PlayerRow[]>(
    initialPlayers.filter((p) => p.id !== selfPlayerId)
  );
  const [lastShotTimes, setLastShotTimes] = useState<Record<string, number>>({});
  const [seekerIntroSecondsLeft, setSeekerIntroSecondsLeft] = useState<number | null>(null);

  // Stable per-player spawn index: this player's rank (by id, for a fixed
  // deterministic order) among all OTHER players sharing the same role at
  // round start. Without this every player defaults to spawnIndex 0 in
  // MapScene and all hiders stack on the exact same spawn point.
  // Computed once from initialPlayers (the round-start snapshot) rather
  // than live data, so it doesn't shift under a player's feet if roles
  // change later (e.g. a hider converting to seeker mid-round keeps
  // their already-assigned position, this only matters for the initial
  // spawn moment).
  const spawnIndex = (() => {
    if (!initialSelf?.role) return 0;
    const sameRole = initialPlayers
      .filter((p) => p.role === initialSelf.role)
      .map((p) => p.id)
      .sort();
    const idx = sameRole.indexOf(selfPlayerId);
    return idx === -1 ? 0 : idx;
  })();

  useEffect(() => {
    let cancelled = false;

    // Fetch the CURRENT row on mount, not just initialSelf from the
    // stale lobby snapshot. initialPlayers was captured before
    // startGame() finished writing roles — there's a real race where
    // the role-assignment UPDATE can complete (and the room flips to
    // 'countdown', triggering onGameStart) before this component even
    // exists to subscribe, meaning that UPDATE event is gone by the
    // time the channel below connects. Without this explicit fetch,
    // a player could get stuck forever on "Waiting for role
    // assignment…" despite the DB already having their role set.
    async function fetchSelf() {
      const { data, error } = await supabase
        .from('players')
        .select()
        .eq('id', selfPlayerId)
        .single();

      if (!cancelled && !error && data) {
        setSelfPlayer(data);
      }
    }

    fetchSelf();

    const channel = supabase
      .channel(`self-player:${selfPlayerId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'players', filter: `id=eq.${selfPlayerId}` },
        (payload) => setSelfPlayer(payload.new as PlayerRow)
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [selfPlayerId]);

  // Tracks the room row itself — specifically status/last_outcome,
  // which flip when the round ends (either via endRound from a hit
  // converting the last hider, or from useRoundTimer's timeout call).
  // Without this, GameScreen would never know to swap to ResultsScreen.
  useEffect(() => {
    const channel = supabase
      .channel(`room-status:${initialRoom.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${initialRoom.id}` },
        (payload) => setRoom(payload.new as RoomRow)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [initialRoom.id]);

  // Separate subscription for everyone ELSE in the room — drives the
  // capsules MapScene renders for other connected players.
  //
  // IMPORTANT: this patches local state directly from each realtime
  // payload rather than refetching the full player list on every
  // change. The original refetch-based approach was reasoned to be
  // "cheap at 2-4 players" — true for LOBBY-rate changes, but position
  // sync writes to this same players table at ~10Hz PER PLAYER (see
  // useThrottled(handlePositionChange, 100) below). With refetch-on-any-
  // change, that meant a full table refetch every ~100ms per other
  // player in the room — 20+ REST round-trips/sec in a 3-player room —
  // which is almost certainly what was overwhelming the connection
  // (ERR_CONNECTION_CLOSED reported after testing). Patching avoids
  // this entirely: one cheap in-memory array update per payload, zero
  // extra network calls.
  useEffect(() => {
    let cancelled = false;

    async function fetchInitial() {
      const { data, error } = await supabase
        .from('players')
        .select()
        .eq('room_id', room.id)
        .neq('id', selfPlayerId);

      if (!cancelled && !error && data) {
        setOtherPlayers(data);
      }
    }

    fetchInitial();

    const channel = supabase
      .channel(`room-players:${room.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${room.id}` },
        (payload) => {
          if (cancelled) return;

          // Self's own row changes are handled by the separate
          // self-player subscription above — skip here to avoid
          // showing the local player in their own otherPlayers list.
          const rowId =
            (payload.new as PlayerRow | null)?.id ?? (payload.old as PlayerRow | null)?.id;
          if (rowId === selfPlayerId) return;

          if (payload.eventType === 'DELETE') {
            setOtherPlayers((prev) => prev.filter((p) => p.id !== rowId));
            return;
          }

          const updated = payload.new as PlayerRow;
          setOtherPlayers((prev) => {
            const idx = prev.findIndex((p) => p.id === updated.id);
            if (idx !== -1) {
              const prevPlayer = prev[idx];
              if (
                typeof prevPlayer.pos_y === 'number' &&
                typeof updated.pos_y === 'number' &&
                updated.pos_y > prevPlayer.pos_y + 0.5
              ) {
                console.warn('[realtime] incoming pos_y jump for', updated.id, prevPlayer.pos_y, '->', updated.pos_y);
              }
              return prev.map((p) => (p.id === updated.id ? updated : p));
            }
            // INSERT case: a new player joined mid-round (e.g. someone
            // reconnecting) — append rather than ignore.
            return [...prev, updated];
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [room.id, selfPlayerId]);

  useEffect(() => {
    const channel = supabase
      .channel(`room-shots:${room.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'shots', filter: `room_id=eq.${room.id}` },
        (payload) => {
          const shot = payload.new as { shooter_id: string };
          if (shot && shot.shooter_id) {
            setLastShotTimes((prev) => ({
              ...prev,
              [shot.shooter_id]: Date.now(),
            }));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [room.id]);

  useEffect(() => {
    if (!selfPlayer || selfPlayer.role !== 'seeker' || !room.round_started_at || room.status === 'ended') {
      setSeekerIntroSecondsLeft(null);
      return;
    }

    const startedAt = new Date(room.round_started_at).getTime();
    const endTime = startedAt + SEEKER_INTRO_SECONDS * 1000;

    function updateCountdown() {
      const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
      setSeekerIntroSecondsLeft(remaining);
    }

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(interval);
  }, [selfPlayer?.role, room.round_started_at, room.status]);

  function handlePositionChange(position: [number, number, number], rotationY: number) {
    // While morphed, rotation is controlled by the ←/→ key disguise-
    // rotation system (useMorphSystem -> setMorphRotation) instead of
    // camera look-direction. Writing rot_y here too would immediately
    // overwrite whatever the player just set with the rotation keys,
    // every single frame — so position keeps syncing freely (movement
    // stays unrestricted while morphed, per the locked game rules) but
    // rot_y is left out of this particular update while morphed.
    const isMorphed = Boolean(selfPlayer?.morphed_into);

    const updatePayload: Record<string, number> = {
      pos_x: position[0],
      pos_y: position[1],
      pos_z: position[2],
    };
    if (!isMorphed) {
      updatePayload.rot_y = rotationY;
    }

    // Clamp sudden upward jumps in pos_y to prevent 3rd-person drift.
    // This also applies whether morphed or not — some clients reported
    // continuous upward drift when toggling into 3rd-person as a
    // character. When we clamp, log to console so it's easy to trace
    // during testing.
    const globalMaxSafe = (manifest?.bounds?.max?.[1] ?? 200) + 2;
    if (updatePayload.pos_y > globalMaxSafe) {
      console.warn('[position-sync] clamping pos_y', updatePayload.pos_y, '->', globalMaxSafe);
      updatePayload.pos_y = globalMaxSafe;
    }

    // Fire-and-forget; throttling happens here rather than in
    // FirstPersonController so the controller stays simple/reusable.
    supabase
      .from('players')
      .update(updatePayload)
      .eq('id', selfPlayerId)
      .then(({ error }) => {
        if (error) {
          // Was previously silent (void + no .then) — logging now since
          // a hard 0,0,0 in the DB for every player suggests these
          // writes may be failing outright rather than just lagging.
          console.error('[position-sync] update failed:', error.message, error);
        }
      });
  }

  // Must be called unconditionally, before any early return below —
  // otherwise this hook (and its internal useRef calls) wouldn't run
  // on every render, violating the Rules of Hooks.
  const throttledPositionChange = useThrottled(handlePositionChange, 100);

  // Drives the "Press E to morph into [thing]" HTML overlay. Lives here
  // (outside the Canvas) rather than inside MapScene's JSX tree because
  // normal DOM/CSS text rendering over a WebGL canvas is much simpler
  // as a sibling overlay than trying to render HTML from inside R3F.
  const [morphPrompt, setMorphPrompt] = useState<MorphableProp | null>(null);

  // Brief on-screen confirmation when this seeker's shot lands — cleared
  // automatically after a couple seconds. otherPlayers may lag a tick
  // behind the player just hit (their row update arrives via a separate
  // subscription), so the name is looked up defensively with a fallback.
  const [hitMessage, setHitMessage] = useState<string | null>(null);
  const hitMessageTimeout = useRef<ReturnType<typeof setTimeout>>();

  async function handleHit(targetPlayerId: string, converted: boolean) {
    const targetName =
      otherPlayers.find((p) => p.id === targetPlayerId)?.display_name ?? 'a hider';

    setHitMessage(converted ? `${targetName} caught — now hunting too!` : `Hit ${targetName}!`);
    if (hitMessageTimeout.current) clearTimeout(hitMessageTimeout.current);
    hitMessageTimeout.current = setTimeout(() => setHitMessage(null), 2500);

    if (converted) {
      const allCaught = await allHidersConverted(room.id);
      if (allCaught) {
        await endRound(room.id, 'seekers_win');
      }
    }
  }

  useEffect(() => {
    return () => {
      if (hitMessageTimeout.current) clearTimeout(hitMessageTimeout.current);
    };
  }, []);

  // Must be called unconditionally alongside the other hooks above,
  // before any early return — same Rules of Hooks reasoning as
  // throttledPositionChange. Ticks down regardless of whether we're
  // currently rendering the 3D scene or about to show results; once
  // room.status is 'ended' this just keeps reporting 0, harmlessly.
  const { secondsRemaining } = useRoundTimer(room);

  // Only used to resolve selfPlayer.morphed_into -> a readable group
  // name for the "You are disguised as..." banner below. MapScene
  // independently loads this same manifest for the 3D scene itself —
  // this is a second, separate fetch of the same small JSON file,
  // which is cheap and avoids threading manifest data between
  // components that otherwise don't need to share it.
  const { manifest } = useMapManifest(room.map_id);
  const morphedProp = selfPlayer?.morphed_into
    ? manifest?.morphables.find((m) => m.id === selfPlayer.morphed_into) ?? null
    : null;
  const seekerIntroActive = selfPlayer?.role === 'seeker' && Boolean(seekerIntroSecondsLeft && seekerIntroSecondsLeft > 0);

  if (room.status === 'ended') {
    return (
      <ResultsScreen
        room={room}
        initialPlayers={initialPlayers}
        finalPlayers={[...(selfPlayer ? [selfPlayer] : []), ...otherPlayers]}
        selfPlayerId={selfPlayerId}
        onBackToLobby={onBackToLobby}
      />
    );
  }

  if (!selfPlayer || !selfPlayer.role) {
    return <div className="map-loading">Waiting for role assignment…</div>;
  }

  return (
    <div className="game-screen">
      <MapScene
        mapId={room.map_id}
        role={selfPlayer.role}
        spawnIndex={spawnIndex}
        onPositionChange={throttledPositionChange}
        otherPlayers={otherPlayers}
        selfPlayerId={selfPlayerId}
        selfPlayer={selfPlayer}
        currentMorphId={selfPlayer.morphed_into}
        onMorphPromptChange={setMorphPrompt}
        onHitRegistered={handleHit}
        lastShotTimes={lastShotTimes}
        seekerIntroActive={seekerIntroActive}
        onShoot={() => {
          setLastShotTimes((prev) => ({
            ...prev,
            [selfPlayerId]: Date.now(),
          }));
        }}
      />
      {secondsRemaining !== null && (
        <div className="round-timer">{formatTime(secondsRemaining)}</div>
      )}
      {selfPlayer.role === 'hider' && (
        <HealthBar hp={selfPlayer.hp} />
      )}
      {selfPlayer.role === 'hider' && (selfPlayer.morphed_into || morphPrompt) && (
        <div className="morph-prompt-overlay">
          {selfPlayer.morphed_into
            ? 'Press E to un-morph'
            : `Press E to morph into ${morphPrompt!.groupId.replace(/_/g, ' ')}`}
        </div>
      )}
      {selfPlayer.role === 'hider' && selfPlayer.morphed_into && morphedProp && (
        <div className="disguise-banner">
          You are disguised as: {morphedProp.groupId.replace(/_/g, ' ')}
        </div>
      )}
      {selfPlayer.role === 'seeker' && seekerIntroActive && (
        <div className="seeker-intro-overlay">
          <div className="seeker-intro-card">
            <div className="seeker-intro-title">Seeker incoming</div>
            <div className="seeker-intro-copy">Hiders get a short window to hide and morph.</div>
            <div className="seeker-intro-timer">{seekerIntroSecondsLeft}s</div>
          </div>
        </div>
      )}
      {selfPlayer.role === 'seeker' && hitMessage && (
        <div className="hit-message-overlay">{hitMessage}</div>
      )}
      {selfPlayer.role === 'seeker' && <div className="crosshair" />}
    </div>
  );
}

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Returns a throttled version of fn that fires at most once per
 * intervalMs. Built locally rather than pulling in lodash just for this —
 * keeps the bundle smaller for a one-function need. */
function useThrottled<T extends (...args: never[]) => void>(fn: T, intervalMs: number): T {
  const lastCallRef = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn; // always call the latest fn, avoid stale closures

  const throttledRef = useRef<T>();
  if (!throttledRef.current) {
    throttledRef.current = ((...args: Parameters<T>) => {
      const now = Date.now();
      if (now - lastCallRef.current >= intervalMs) {
        lastCallRef.current = now;
        fnRef.current(...args);
      }
    }) as T;
  }

  return throttledRef.current;
}

const MAX_HP = 100; // matches the starting hp default in schema.sql

/** Hider's own HP bar — the visual cue that lets a hider know they've
 * been shot and should consider fleeing/morphing rather than continuing
 * to wander in the open. Color escalates green -> yellow -> red as HP
 * drops, since color change reads faster under pressure than reading
 * the number itself. Only ever shown to hiders (seekers are invulnerable
 * and have no meaningful HP, per the locked game rules), enforced by
 * the caller only rendering this for role === 'hider'. */
function HealthBar({ hp }: { hp: number }) {
  const pct = Math.max(0, Math.min(100, (hp / MAX_HP) * 100));
  const color = pct > 50 ? '#3ecf5e' : pct > 20 ? '#e0c43e' : '#e04444';

  return (
    <div className="health-bar-container">
      <div className="health-bar-label">HP: {hp}</div>
      <div className="health-bar-track">
        <div className="health-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
