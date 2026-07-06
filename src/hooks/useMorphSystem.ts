import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { tryMorph, unmorph, setMorphRotation } from '../lib/rooms';
import { supabase } from '../lib/supabaseClient';
import type { MorphableProp } from '../types/game';

const MORPH_RANGE = 1.5; // meters — generous enough that walking up to a
                          // prop feels responsive, tight enough that you
                          // can't morph into something across the room
const ROTATE_SPEED = 90; // degrees per second while holding an arrow key
const ROTATE_SYNC_INTERVAL_MS = 100; // matches the position-sync throttle
                                       // elsewhere — rotating every frame
                                       // would write to Supabase 60x/sec,
                                       // this caps it to the same ~10Hz
                                       // rate as normal movement sync

interface UseMorphSystemArgs {
  playerId: string;
  morphables: MorphableProp[];
  /** currently morphed-into id, or null — comes from the live player row
   *  (subscribed in GameScreen) so this hook doesn't own that state
   *  itself, just reacts to it and triggers the keypress action. */
  currentMorphId: string | null;
  /** incrementing this number triggers the same morph/un-morph action
   *  that pressing E does on desktop. Useful for mobile buttons. */
  triggerMorph?: number;
  /** disabled entirely for seekers — they should never see a morph
   *  prompt or be able to trigger morph. The caller (MapScene) only
   *  mounts this hook's wrapper component for hiders in the first
   *  place, but `enabled` stays as an explicit belt-and-suspenders
   *  gate rather than relying solely on "is this even mounted". */
  enabled: boolean;
  /** Optional maximum safe camera Y to clamp flushed positions when morphing
   *  (prevents clients in 3rd-person from writing an elevated camera Y
   *  into the player's DB row and causing others to render them off into
   *  the sky). */
  maxSafeCameraY?: number;
}

interface MorphSystemState {
  /** the prop currently in range to morph into, or null. Drives the
   *  "Press E to morph into [thing]" UI prompt. */
  nearbyProp: MorphableProp | null;
  /** true while a morph/unmorph request is in flight, to debounce
   *  rapid E presses from firing multiple overlapping requests. */
  busy: boolean;
}

/** Tracks camera distance to every morphable prop each frame, exposes
 * the nearest in-range one for a UI prompt, and wires the E key to
 * morph-into (if not currently morphed) or un-morph (if currently
 * morphed) via the rooms.ts functions. Mount this inside the Canvas
 * (needs useThree for the camera) alongside FirstPersonController. */
export function useMorphSystem({
  playerId,
  morphables,
  currentMorphId,
  triggerMorph,
  enabled,
  maxSafeCameraY,
}: UseMorphSystemArgs): MorphSystemState {
  const { camera } = useThree();
  const [nearbyProp, setNearbyProp] = useState<MorphableProp | null>(null);
  const [busy, setBusy] = useState(false);

  // Refs so the keydown handler (set up once) always reads the latest
  // nearbyProp/currentMorphId/busy without needing to re-bind the
  // listener on every change — same stale-closure fix pattern used in
  // Lobby.tsx, applied here for the same reason.
  const nearbyPropRef = useRef(nearbyProp);
  const currentMorphIdRef = useRef(currentMorphId);
  const busyRef = useRef(busy);
  const lastTriggerMorph = useRef(triggerMorph);
  nearbyPropRef.current = nearbyProp;
  currentMorphIdRef.current = currentMorphId;
  busyRef.current = busy;

  async function attemptMorphAction() {
    if (busyRef.current) return;

    const morphedInto = currentMorphIdRef.current;
    const target = nearbyPropRef.current;

    if (morphedInto) {
      setBusy(true);
      try {
        await unmorph(playerId);
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!target) return;

    setBusy(true);
    try {
      const result = await tryMorph(playerId, target.id);
      console.debug('[morph] tryMorph result for', playerId, 'target', target.id, result);
      if (result.ok) {
        try {
          const flushedY = typeof maxSafeCameraY === 'number' ? Math.min(camera.position.y, maxSafeCameraY) : camera.position.y;
          await supabase.from('players').update({
            pos_x: camera.position.x,
            pos_y: flushedY,
            pos_z: camera.position.z,
          }).eq('id', playerId);
          console.debug('[morph] flushed position for', playerId, [camera.position.x, camera.position.y, camera.position.z]);
        } catch (e) {
          console.error('[morph] failed to flush position', e);
        }
      } else if (!result.ok && result.reason === 'occupied') {
        console.info('[morph] that one is already taken, try a different one');
      }
    } finally {
      setBusy(false);
    }
  }

  // ←/→ disguise rotation: held-key state (not single keydown events)
  // so rotation feels like a continuous turn, same as WASD movement,
  // rather than a one-shot nudge per press.
  const rotateKeysHeld = useRef<{ left: boolean; right: boolean }>({ left: false, right: false });
  const currentRotationDeg = useRef(0); // local optimistic rotation value,
                                          // synced to Supabase on a
                                          // throttle below rather than
                                          // every frame
  const lastRotationSync = useRef(0);

  useFrame(() => {
    if (!enabled || morphables.length === 0) {
      if (nearbyPropRef.current !== null) setNearbyProp(null);
      return;
    }

    // If already morphed, there's no "nearby prop" prompt to show —
    // the only available action is un-morph, which doesn't need a
    // proximity check.
    if (currentMorphIdRef.current) {
      if (nearbyPropRef.current !== null) setNearbyProp(null);
      return;
    }

    let closest: MorphableProp | null = null;
    let closestDist = Infinity;

    for (const prop of morphables) {
      const dx = camera.position.x - prop.position[0];
      const dz = camera.position.z - prop.position[2];
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= MORPH_RANGE && dist < closestDist) {
        closest = prop;
        closestDist = dist;
      }
    }

    // Only setState when the nearby prop actually changes — avoids
    // triggering a React re-render every single frame just because
    // distance fluctuates by a few millimeters.
    if (closest?.id !== nearbyPropRef.current?.id) {
      setNearbyProp(closest);
    }
  });

  useEffect(() => {
    if (!enabled) return;

    function handleRotateKeyDown(e: KeyboardEvent) {
      if (e.code === 'ArrowLeft') rotateKeysHeld.current.left = true;
      if (e.code === 'ArrowRight') rotateKeysHeld.current.right = true;
    }
    function handleRotateKeyUp(e: KeyboardEvent) {
      if (e.code === 'ArrowLeft') rotateKeysHeld.current.left = false;
      if (e.code === 'ArrowRight') rotateKeysHeld.current.right = false;
    }

    window.addEventListener('keydown', handleRotateKeyDown);
    window.addEventListener('keyup', handleRotateKeyUp);
    return () => {
      window.removeEventListener('keydown', handleRotateKeyDown);
      window.removeEventListener('keyup', handleRotateKeyUp);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof triggerMorph !== 'number') return;
    if (lastTriggerMorph.current === triggerMorph) return;
    lastTriggerMorph.current = triggerMorph;
    void attemptMorphAction();
  }, [triggerMorph, enabled, playerId]);

  // Per-frame rotation integration + throttled sync — only active while
  // actually morphed, since rotating an un-morphed hider's own facing
  // via arrow keys isn't part of the design (camera-look already
  // handles facing direction when not morphed).
  useFrame((_, delta) => {
    if (!enabled || !currentMorphIdRef.current) return;

    const { left, right } = rotateKeysHeld.current;
    if (!left && !right) return;

    const direction = left ? -1 : 1; // left decreases angle, right increases
    currentRotationDeg.current += direction * ROTATE_SPEED * delta;
    // Normalize to 0-360 for a clean stored value, purely cosmetic
    // (rotation math elsewhere doesn't care about the range, this just
    // keeps the synced number from growing unbounded over a long round).
    currentRotationDeg.current = ((currentRotationDeg.current % 360) + 360) % 360;

    const now = performance.now();
    if (now - lastRotationSync.current >= ROTATE_SYNC_INTERVAL_MS) {
      lastRotationSync.current = now;
      const rotationRadians = (currentRotationDeg.current * Math.PI) / 180;
      void setMorphRotation(playerId, rotationRadians);
    }
  });

  useEffect(() => {
    if (!enabled) return;

    async function handleKeyDown(e: KeyboardEvent) {
      if (e.code !== 'KeyE') return;
      if (busyRef.current) return;

      const morphedInto = currentMorphIdRef.current;
      const target = nearbyPropRef.current;

      if (morphedInto) {
        // Currently morphed -> E un-morphs, regardless of proximity.
        setBusy(true);
        try {
          await unmorph(playerId);
        } finally {
          setBusy(false);
        }
        return;
      }

      if (!target) return; // nothing in range, nothing to do

      setBusy(true);
      try {
        const result = await tryMorph(playerId, target.id);
        console.debug('[morph] tryMorph result for', playerId, 'target', target.id, result);
        if (result.ok) {
          // Immediately flush the current camera position to the player's
          // row so other clients render the morphed player exactly where
          // they were when the morph happened. This prevents a small
          // timing gap (throttled position sync) from leaving others
          // with an out-of-date location that looks like a teleport.
            try {
              const flushedY = typeof maxSafeCameraY === 'number' ? Math.min(camera.position.y, maxSafeCameraY) : camera.position.y;
              await supabase.from('players').update({
                pos_x: camera.position.x,
                pos_y: flushedY,
                pos_z: camera.position.z,
              }).eq('id', playerId);
              console.debug('[morph] flushed position for', playerId, [camera.position.x, flushedY, camera.position.z]);
            } catch (e) {
              console.error('[morph] failed to flush position', e);
            }
        } else if (!result.ok && result.reason === 'occupied') {
          // Someone else already claimed this exact instance between
          // when we detected it as "nearby" and pressing E. Rare, not
          // worth a popup — the prompt will just stay available for a
          // different instance in the same group right next to it.
          console.info('[morph] that one is already taken, try a different one');
        }
      } finally {
        setBusy(false);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, playerId]);

  return { nearbyProp, busy };
}
