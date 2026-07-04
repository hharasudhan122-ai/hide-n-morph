import { useState } from 'react';
import { Lobby } from './components/Lobby';
import { GameScreen } from './components/GameScreen';
import type { RoomRow, PlayerRow } from './types/game';

type AppScreen = 'lobby' | 'game';

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('lobby');
  const [activeRoom, setActiveRoom] = useState<RoomRow | null>(null);
  const [selfPlayerId, setSelfPlayerId] = useState<string | null>(null);
  const [initialPlayers, setInitialPlayers] = useState<PlayerRow[]>([]);

  function handleGameStart(room: RoomRow, players: PlayerRow[], selfId: string) {
    setActiveRoom(room);
    setSelfPlayerId(selfId);
    setInitialPlayers(players);
    setScreen('game');
  }

  // Resets all round-specific state and drops back to the lobby's
  // create/join menu. Doesn't touch the room/player rows in Supabase —
  // the room stays 'ended' there; this is purely a local UI reset so
  // the person can create or join a fresh room from scratch. A proper
  // "play again with the same group" flow (resetting the SAME room
  // back to 'lobby') is a nicer UX but isn't built yet — see the
  // remaining work list.
  function handleBackToLobby() {
    setActiveRoom(null);
    setSelfPlayerId(null);
    setInitialPlayers([]);
    setScreen('lobby');
  }

  if (screen === 'game' && activeRoom && selfPlayerId) {
    return (
      <div style={{ width: '100vw', height: '100vh' }}>
        <GameScreen
          room={activeRoom}
          selfPlayerId={selfPlayerId}
          initialPlayers={initialPlayers}
          onBackToLobby={handleBackToLobby}
        />
      </div>
    );
  }

  return <Lobby onGameStart={handleGameStart} />;
}
