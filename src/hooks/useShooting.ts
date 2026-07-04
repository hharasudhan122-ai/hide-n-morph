import { useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { supabase } from '../lib/supabaseClient';
import { applyDamage } from '../lib/rooms';

const FIRE_COOLDOWN_MS = 400; // ~2.5 shots/sec — fast enough to feel
                                // responsive, slow enough that spamming
                                // click isn't strictly better than aiming
const MAX_RANGE = 50; // meters, generous for a small indoor map

interface UseShootingArgs {
  enabled: boolean; // true only for seekers
  roomId: string;
  selfPlayerId: string;
  /** called right after a successful hit registers, so the caller can
   *  show a hit marker / "converted!" message, and check win condition. */
  onHit?: (targetPlayerId: string, converted: boolean) => void;
  onShoot?: () => void;
  triggerShoot?: number;
  disabled?: boolean;
}

interface ShootingState {
  /** true for a brief moment after firing, for a muzzle-flash/reticle
   *  pulse effect in the HUD. Not currently consumed by any UI, exposed
   *  for whoever builds the gun visual next. */
  justFired: boolean;
}

/** Click-to-shoot raycasting. Casts from the camera's exact center
 * (crosshair-style, not from a gun barrel offset — simpler and accurate
 * for a first-person view) against every Object3D in the scene tagged
 * with userData.playerId (see OtherPlayers in MapScene.tsx), applies
 * damage to the first one hit, and reports the result.
 *
 * Mount inside the <Canvas>, alongside FirstPersonController, only when
 * the local player is the seeker — a hider should never have a shoot
 * listener active at all, not just a disabled one, since seekers are
 * the only role with a gun per the locked game rules. */
export function useShooting({ enabled, roomId, selfPlayerId, onHit, onShoot, triggerShoot, disabled = false }: UseShootingArgs): ShootingState {
  const { camera, scene } = useThree();
  const [justFired, setJustFired] = useState(false);
  const lastFireTime = useRef(0);
  const lastTriggerShoot = useRef<number | undefined>(triggerShoot);
  const raycaster = useRef(new THREE.Raycaster());
  const onHitRef = useRef(onHit);
  const onShootRef = useRef(onShoot);

  useEffect(() => {
    onHitRef.current = onHit;
    onShootRef.current = onShoot;
  }, [onHit, onShoot]);

  async function registerHit(targetPlayerId: string) {
    // Need the target's current HP to compute the new value — fetched
    // fresh here rather than trusting any locally cached copy, since
    // staleness here would mean wrong damage math (e.g. applying -20
    // to an HP value that's already out of date).
    const { data, error } = await supabase
      .from('players')
      .select('hp')
      .eq('id', targetPlayerId)
      .single();

    if (error || !data) return;

    const result = await applyDamage(targetPlayerId, data.hp);
    onHitRef.current?.(targetPlayerId, result.converted);
    // Whether this conversion ended the round (all hiders now caught)
    // is the CALLER's call to make — GameScreen checks
    // allHidersConverted() itself when onHit reports converted=true,
    // since round-lifecycle decisions belong with whoever owns the
    // round, not with the shooting hook.
  }

  async function executeShoot() {
    const now = performance.now();
    if (now - lastFireTime.current < FIRE_COOLDOWN_MS) return;
    lastFireTime.current = now;

    setJustFired(true);
    setTimeout(() => setJustFired(false), 80);
    onShootRef.current?.();

    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    raycaster.current.set(camera.position, direction);
    raycaster.current.far = MAX_RANGE;

    const hits = raycaster.current.intersectObjects(scene.children, true);

    let targetId: string | null = null;
    let isHit = false;

    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj) {
        const tid = obj.userData?.playerId;
        if (tid) {
          targetId = tid;
          isHit = true;
          break;
        }
        obj = obj.parent;
      }
      if (targetId) break;
    }

    supabase
      .from('shots')
      .insert({
        room_id: roomId,
        shooter_id: selfPlayerId,
        target_id: targetId,
        hit: isHit,
        damage: isHit ? 20 : 0,
        shooter_pos: [camera.position.x, camera.position.y, camera.position.z],
        shooter_dir: [direction.x, direction.y, direction.z],
      })
      .then(({ error }) => {
        if (error) {
          console.error('[useShooting] failed to log shot:', error.message, error);
        }
      });

    if (isHit && targetId) {
      await registerHit(targetId);
    }
  }

  useEffect(() => {
    if (!enabled || disabled) return;

    function handleClick() {
      void executeShoot();
    }

    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [enabled, disabled, camera, scene]);

  useEffect(() => {
    if (!enabled || disabled || typeof triggerShoot !== 'number') return;
    if (lastTriggerShoot.current === triggerShoot) {
      lastTriggerShoot.current = triggerShoot;
      return;
    }
    lastTriggerShoot.current = triggerShoot;
    void executeShoot();
  }, [triggerShoot, enabled, disabled, camera, scene]);

  return { justFired };
}
