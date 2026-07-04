import { useEffect, useRef, useState } from 'react';
import { endRound } from '../lib/rooms';
import type { RoomRow } from '../types/game';

interface UseRoundTimerResult {
  /** seconds remaining, clamped to >= 0. Null until round_started_at is
   *  set (e.g. still in the lobby, shouldn't normally render a timer). */
  secondsRemaining: number | null;
}

/** Ticks down from room.round_seconds, starting at room.round_started_at.
 * When it reaches 0, calls endRound(roomId, 'hiders_win') exactly once —
 * per the locked game rules, surviving to the timer's end is how hiders
 * win, so reaching 0 while the round is still 'playing'/'countdown'
 * (i.e. nobody already ended it via all-hiders-caught) means hiders won.
 *
 * Multiple clients in the same room will all independently notice the
 * timer hitting 0 and all call endRound — that's fine, the call is
 * idempotent (just sets status + last_outcome), so there's no need for
 * leader-election or a single source-of-truth client here. */
export function useRoundTimer(room: RoomRow): UseRoundTimerResult {
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const hasEndedRef = useRef(false);

  useEffect(() => {
    if (!room.round_started_at) {
      setSecondsRemaining(null);
      return;
    }

    // Reset the "have we already called endRound" guard whenever a NEW
    // round starts (different round_started_at) — without this, a
    // second round in the same session would never re-trigger the
    // timeout call after the first round already set the guard.
    hasEndedRef.current = false;

    function tick() {
      const startedAt = new Date(room.round_started_at!).getTime();
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const remaining = Math.max(0, Math.ceil(room.round_seconds - elapsedSeconds));
      setSecondsRemaining(remaining);

      if (remaining === 0 && !hasEndedRef.current && room.status !== 'ended') {
        hasEndedRef.current = true;
        void endRound(room.id, 'hiders_win');
      }
    }

    tick(); // immediate first tick, don't wait a full second to show a value
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [room.id, room.round_started_at, room.round_seconds, room.status]);

  return { secondsRemaining };
}
