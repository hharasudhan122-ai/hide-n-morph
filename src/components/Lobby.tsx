import { useEffect, useRef, useState } from 'react';
import { createRoom, joinRoom, leaveRoom, subscribeToRoom, startGame } from '../lib/rooms';
import type { RoomRow, PlayerRow } from '../types/game';

interface LobbyProps {
  onGameStart: (room: RoomRow, players: PlayerRow[], selfId: string) => void;
}

type LobbyScreen = 'menu' | 'create' | 'join' | 'waiting';

export function Lobby({ onGameStart }: LobbyProps) {
  const [screen, setScreen] = useState<LobbyScreen>('menu');
  const [displayName, setDisplayName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [room, setRoom] = useState<RoomRow | null>(null);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Refs so the subscription callback (set up once per room.id) always
  // reads the LATEST players/selfId, not whatever they were when the
  // effect first ran. Without this, onGameStart could fire with a stale
  // selfId of null if it changed after the effect's initial mount.
  const playersRef = useRef(players);
  const selfIdRef = useRef(selfId);
  useEffect(() => {
    playersRef.current = players;
  }, [players]);
  useEffect(() => {
    selfIdRef.current = selfId;
  }, [selfId]);

  // Subscribe once we have a room
  useEffect(() => {
    if (!room) return;

    const unsubscribe = subscribeToRoom(
      room.id,
      (updatedRoom) => {
        setRoom(updatedRoom);
        if (updatedRoom.status === 'countdown' || updatedRoom.status === 'playing') {
          const currentSelfId = selfIdRef.current;
          if (currentSelfId) onGameStart(updatedRoom, playersRef.current, currentSelfId);
        }
      },
      (updatedPlayers) => setPlayers(updatedPlayers)
    );

    return unsubscribe;
  }, [room?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleCreate() {
    if (!displayName.trim()) {
      setErrorMsg('Enter a name first');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      const { room: newRoom, player } = await createRoom(displayName.trim());
      setRoom(newRoom);
      setSelfId(player.id);
      setPlayers([player]);
      setScreen('waiting');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create room');
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin() {
    if (!displayName.trim()) {
      setErrorMsg('Enter a name first');
      return;
    }
    if (!joinCode.trim()) {
      setErrorMsg('Enter a room code');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      const { room: joinedRoom, player } = await joinRoom(joinCode, displayName.trim());
      setRoom(joinedRoom);
      setSelfId(player.id);
      setScreen('waiting');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to join room');
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave() {
    if (selfId) {
      try {
        await leaveRoom(selfId);
      } catch {
        // best-effort, ignore failures on leave
      }
    }
    setRoom(null);
    setPlayers([]);
    setSelfId(null);
    setScreen('menu');
  }

  async function handleStart() {
    if (!room) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await startGame(room.id, players.map((p) => p.id));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start game');
    } finally {
      setBusy(false);
    }
  }

  const isHost = players.find((p) => p.id === selfId)?.is_host ?? false;
  const canStart = players.length >= 2;

  if (screen === 'menu') {
    return (
      <div className="lobby-container">
        <div className="lobby-screen">
          <h1>Hide n Morph</h1>
          <p className="lobby-subtitle">Transform. Deceive. Survive.</p>
          <input
            placeholder="Your name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={20}
          />
          {errorMsg && <p className="lobby-error">{errorMsg}</p>}
          <button disabled={busy} onClick={() => setScreen('create')}>Create Room</button>
          <button disabled={busy} onClick={() => setScreen('join')} className="btn-secondary">Join Room</button>
        </div>
      </div>
    );
  }

  if (screen === 'create') {
    return (
      <div className="lobby-container">
        <div className="lobby-screen">
          <h1>Create Room</h1>
          <input
            placeholder="Your name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={20}
          />
          {errorMsg && <p className="lobby-error">{errorMsg}</p>}
          <button disabled={busy} onClick={handleCreate}>{busy ? 'Creating…' : 'Create'}</button>
          <button disabled={busy} onClick={() => setScreen('menu')} className="btn-secondary">Back</button>
        </div>
      </div>
    );
  }

  if (screen === 'join') {
    return (
      <div className="lobby-container">
        <div className="lobby-screen">
          <h1>Join Room</h1>
          <input
            placeholder="Your name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={20}
          />
          <input
            placeholder="Room code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            maxLength={6}
          />
          {errorMsg && <p className="lobby-error">{errorMsg}</p>}
          <button disabled={busy} onClick={handleJoin}>{busy ? 'Joining…' : 'Join'}</button>
          <button disabled={busy} onClick={() => setScreen('menu')} className="btn-secondary">Back</button>
        </div>
      </div>
    );
  }

  // waiting room
  return (
    <div className="lobby-container">
      <div className="lobby-screen">
        <h1>Waiting Room</h1>
        <div className="room-code-display">
          <span className="room-code-label">Room Code</span>
          <span className="room-code-value">{room?.code}</span>
        </div>
        <p className="lobby-subtitle">Share this code with friends to join!</p>
        <ul className="player-list">
          {players.map((p) => (
            <li key={p.id}>
              <span className="player-dot" />
              {p.display_name} {p.is_host && <span className="badge">HOST</span>} {p.id === selfId && <span className="badge badge-you">YOU</span>}
            </li>
          ))}
        </ul>
        {errorMsg && <p className="lobby-error">{errorMsg}</p>}
        {isHost ? (
          <button disabled={busy || !canStart} onClick={handleStart}>
            {canStart ? (busy ? 'Starting…' : '🎮 Start Game') : 'Need 2+ players'}
          </button>
        ) : (
          <p className="lobby-subtitle">Waiting for host to start…</p>
        )}
        <button disabled={busy} onClick={handleLeave} className="btn-secondary">Leave</button>
      </div>
    </div>
  );
}
