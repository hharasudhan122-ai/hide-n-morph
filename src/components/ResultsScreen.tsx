import type { RoomRow, PlayerRow } from '../types/game';

interface ResultsScreenProps {
  room: RoomRow;
  /** round-start snapshot — needed to know each player's ORIGINAL role,
   *  since by round-end every caught hider has role flipped to 'seeker'
   *  in the live data. Without this snapshot, "Alex (seeker)" in the
   *  results would be ambiguous between "started as seeker" and "was a
   *  hider, got caught" — exactly the distinction a results screen
   *  needs to show. */
  initialPlayers: PlayerRow[];
  /** current/final state — used for hp and confirming live role. */
  finalPlayers: PlayerRow[];
  selfPlayerId: string;
  onBackToLobby: () => void;
}

/** Shown once room.status flips to 'ended'. Reads last_outcome (set by
 * endRound) to announce the winning side, then lists everyone with
 * their ORIGINAL role and what happened to them: an original seeker,
 * a hider who survived (still role='hider' at round end since only
 * hiders win means none of them got caught), or a hider who got caught
 * and converted (original role was 'hider' but final role is 'seeker').
 *
 * Doesn't touch Supabase itself; "Back to Lobby" is just a local screen
 * transition — the room itself stays in 'ended' status, starting a
 * fresh round is a separate concern not built yet. */
export function ResultsScreen({ room, initialPlayers, finalPlayers, selfPlayerId, onBackToLobby }: ResultsScreenProps) {
  const outcome = room.last_outcome;
  const headline =
    outcome === 'hiders_win'
      ? 'Hiders win — they survived the round!'
      : outcome === 'seekers_win'
        ? 'Seekers win — every hider was caught!'
        : 'Round ended';

  return (
    <div className="lobby-screen">
      <h1>{headline}</h1>
      <ul className="player-list">
        {finalPlayers.map((p) => {
          const original = initialPlayers.find((ip) => ip.id === p.id);
          const wasOriginallyHider = original?.role === 'hider';
          const gotCaught = wasOriginallyHider && p.role === 'seeker';

          let statusLabel: string;
          if (!wasOriginallyHider) {
            statusLabel = 'seeker';
          } else if (gotCaught) {
            statusLabel = 'hider — caught';
          } else {
            statusLabel = 'hider — survived';
          }

          return (
            <li key={p.id}>
              {p.display_name}
              {p.id === selfPlayerId && ' (you)'}
              {' — '}
              {statusLabel}
            </li>
          );
        })}
      </ul>
      <button onClick={onBackToLobby}>Back to Lobby</button>
    </div>
  );
}
