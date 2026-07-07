import { useEffect, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3Tuple, MapBounds, MorphableProp, FloorPlane, WallCollider } from '../types/game';

const WALK_SPEED = 4; // meters per second
const SPRINT_SPEED = 6.5; // meters per second
const PLAYER_HEIGHT = 1.7;
const JUMP_VELOCITY = 8.5; // initial upward speed in m/s when jumping —
                             // tuned to clear all morphable props including the scaled up
                             // potato chip shelves (~1.72m) and freezers/vending machines (~1.8m)
const GRAVITY = -16; // m/s^2 — tuned higher than real gravity (-9.8) for a
                       // snappier, more game-like jump arc rather than a
                       // slow, floaty real-world fall. Combined with
                       // JUMP_VELOCITY=8.5 this gives ~2.25m max jump height
                       // (v^2 / 2g) — comfortably clears shelves and freezers.
const PLAYER_RADIUS = 0.3; // horizontal collision radius, roughly shoulder-width

interface FirstPersonControllerProps {
  startPosition: Vec3Tuple;
  bounds: MapBounds;
  /** Solid obstacles the player collides with horizontally, and can
   * stand on top of after jumping. Currently sourced from the manifest's
   * morphables (crates, columns, etc) — walls aren't included yet since
   * they're built from many small segments rather than one collider
   * per logical wall; see the remaining-work note where this is wired
   * in MapScene.tsx if wall collision becomes the next priority. */
  colliders?: MorphableProp[];
  /** Invisible box colliders laid over an imported scene.glb's building
   * walls (see WallCollider) — the actual thing that fixes "walking
   * straight through walls", since neither colliders (circular props)
   * nor floorPlanes (horizontal surfaces) block a vertical wall run. */
  wallColliders?: WallCollider[];
  /** Elevated rectangular surfaces (the second floor) — see FloorPlane.
   * Checked alongside colliders for both horizontal blocking and
   * landing-on-top, since structurally it's the same "solid surface
   * with headroom-based blocking" logic just shaped differently. */
  floorPlanes?: FloorPlane[];
  thirdPerson?: boolean;
  /** Called every frame with the current position, throttled internally
   * by the caller (this component just reports every frame; whoever
   * wires up Supabase sync should throttle to ~10-15Hz there, not here —
   * keeps this component simple and reusable). */
  playerPositionRef: MutableRefObject<THREE.Vector3>;
  onPositionChange?: (position: [number, number, number], rotationY: number) => void;
  disabled?: boolean;
  mobileMoveInput?: { x: number; y: number };
  /** Accumulated, not-yet-applied camera yaw (radians) from the mobile
   *  free-look drag layer. MobileControls ADDS to this ref on every
   *  pointermove; this component reads it once per frame, applies it
   *  to the camera, then resets it to 0 — a ref (rather than React
   *  state) is used specifically so drag events don't have to round-trip
   *  through a re-render before affecting rotation, and so nothing
   *  needs to "un-apply" a stale value on frames with no new input. */
  mobileLookDeltaRef?: MutableRefObject<number>;
  mobileSprint?: boolean;
  jumpRequestCount?: number;
}

/** True if a player (treated as a vertical cylinder, PLAYER_RADIUS wide)
 * standing with their FEET at feetHeight would overlap any collider at
 * the given x/z. Horizontal overlap uses circle-circle distance against
 * each collider's footprint radius. A collider only blocks movement if
 * the player's feet are below that collider's top surface — once
 * you've jumped/landed above a prop's height, you're "on top of it"
 * and free to walk across, not blocked by its footprint anymore. */
/** A rectangular elevated surface (the second floor) a player can stand
 * on once they're at or above its height, and which blocks movement
 * from below like any other solid surface — same headroom logic as a
 * prop collider, just rectangular instead of circular and intended to
 * cover a large region rather than one small object. */
function insideFloorPlane(x: number, z: number, plane: FloorPlane): boolean {
  return x >= plane.minX && x <= plane.maxX && z >= plane.minZ && z <= plane.maxZ;
}

/** True if a player standing with feet at feetHeight (head therefore at
 * feetHeight + PLAYER_HEIGHT) at (x, z) overlaps a WallCollider box. The
 * box is inflated by PLAYER_RADIUS on X/Z so the player's body can't
 * clip halfway into a wall the way a zero-width point check would allow
 * — same reasoning as the circle-vs-radius check other colliders use. */
function insideWallCollider(x: number, z: number, feetHeight: number, wall: WallCollider): boolean {
  const inX = x >= wall.minX - PLAYER_RADIUS && x <= wall.maxX + PLAYER_RADIUS;
  const inZ = z >= wall.minZ - PLAYER_RADIUS && z <= wall.maxZ + PLAYER_RADIUS;
  if (!inX || !inZ) return false;
  const headHeight = feetHeight + PLAYER_HEIGHT;
  // Blocks if the player's vertical span (feet to head) overlaps the
  // wall's blocked Y range at all — a real wall should stop you whether
  // you're crouched, standing, or mid-jump, not just at foot level.
  return headHeight > wall.minY && feetHeight < wall.maxY;
}

/** True if a player (treated as a vertical cylinder, PLAYER_RADIUS wide)
 * standing with their FEET at feetHeight would overlap any collider at
 * the given x/z. Horizontal overlap uses circle-circle distance against
 * each collider's footprint radius. A collider only blocks movement if
 * the player's feet are below that collider's top surface — once
 * you've jumped/landed above a prop's height, you're "on top of it"
 * and free to walk across, not blocked by its footprint anymore. */
function collidesAt(
  x: number,
  z: number,
  feetHeight: number,
  colliders: MorphableProp[],
  floorPlanes: FloorPlane[] = [],
  wallColliders: WallCollider[] = []
): boolean {
  for (const c of colliders) {
    const dx = x - c.position[0];
    const dz = z - c.position[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    const minClear = PLAYER_RADIUS + c.footprint.radius;
    if (dist < minClear && feetHeight < c.footprint.height - 0.05) {
      // small -0.05 tolerance so landing exactly AT a prop's height
      // (floating point edge case) doesn't get incorrectly re-blocked
      return true;
    }
  }
  for (const plane of floorPlanes) {
    if (insideFloorPlane(x, z, plane) && feetHeight < plane.height - 0.05) {
      return true;
    }
  }
  for (const wall of wallColliders) {
    if (insideWallCollider(x, z, feetHeight, wall)) {
      return true;
    }
  }
  return false;
}

/** Finds the highest collider top surface directly beneath (x, z), if
 * any — used by the gravity/landing logic so a falling player comes to
 * rest standing ON TOP of a prop instead of clipping through it back
 * down to the floor. Returns 0 (floor level) if nothing is underneath.
 * Floor planes are checked alongside individual prop colliders, since
 * the second floor is just another standable surface at a fixed height
 * across a region rather than a single small footprint. */
function groundHeightAt(
  x: number,
  z: number,
  feetHeight: number,
  colliders: MorphableProp[],
  floorPlanes: FloorPlane[] = []
): number {
  let highest = 0;
  for (const c of colliders) {
    const dx = x - c.position[0];
    const dz = z - c.position[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < PLAYER_RADIUS + c.footprint.radius && c.footprint.height > highest) {
      highest = c.footprint.height;
    }
  }
  for (const plane of floorPlanes) {
    if (!plane.isCeiling && insideFloorPlane(x, z, plane) && plane.height <= feetHeight + 0.05 && plane.height > highest) {
      highest = plane.height;
    }
  }
  return highest;
}

function ceilingHeightAt(
  x: number,
  z: number,
  feetHeight: number,
  floorPlanes: FloorPlane[] = []
): number {
  let lowestCeiling = Infinity;
  const headY = feetHeight + PLAYER_HEIGHT;
  for (const plane of floorPlanes) {
    if (!plane.isCeiling) continue;
    if (!insideFloorPlane(x, z, plane)) continue;
    if (plane.height >= headY - 0.05 && plane.height < lowestCeiling) {
      lowestCeiling = plane.height;
    }
  }
  return lowestCeiling === Infinity ? Number.MAX_VALUE : lowestCeiling;
}

/** Bare WASD + pointer-lock-look first-person movement, now with basic
 * cylinder-vs-cylinder collision against the manifest's morphable props.
 * Pairs with
 * <PointerLockControls /> already in MapScene for the mouse-look part;
 * this component only handles keyboard-driven translation and keeps the
 * player within manifest.bounds. */
export function FirstPersonController({ startPosition, bounds, colliders = [], wallColliders = [], floorPlanes = [], playerPositionRef, thirdPerson = false, onPositionChange, disabled = false, mobileMoveInput = { x: 0, y: 0 }, mobileLookDeltaRef, mobileSprint = false, jumpRequestCount = 0 }: FirstPersonControllerProps) {
  const { camera, scene } = useThree();
  const raycasterRef = useRef<THREE.Raycaster | null>(null);
  const previousSurfaceHeightRef = useRef<number>(0);
  const keysPressed = useRef<Set<string>>(new Set());
  const disabledRef = useRef(disabled);
  const velocity = useRef(new THREE.Vector3());
  const verticalVelocity = useRef(0); // current vertical speed, m/s (negative = falling)
  const heightAboveGround = useRef(0); // camera height relative to PLAYER_HEIGHT baseline; 0 = grounded
  const isGroundedRef = useRef(true); // updated each frame in useFrame; read by the
                                        // once-mounted keydown handler above, which
                                        // can't safely read fresh camera/colliders
                                        // values itself (its effect never re-subscribes)
  const lastJumpCount = useRef(jumpRequestCount);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  useEffect(() => {
    playerPositionRef.current.set(...startPosition);
    playerPositionRef.current.y = PLAYER_HEIGHT;
    camera.position.set(playerPositionRef.current.x, playerPositionRef.current.y, playerPositionRef.current.z);
  }, [camera, playerPositionRef, startPosition]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (disabledRef.current) return;
      keysPressed.current.add(e.code);
      if (e.code === 'Space' && isGroundedRef.current) {
        verticalVelocity.current = JUMP_VELOCITY;
      }
    }
    function handleKeyUp(e: KeyboardEvent) {
      keysPressed.current.delete(e.code);
    }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  useEffect(() => {
    if (disabledRef.current) return;
    if (jumpRequestCount > lastJumpCount.current && isGroundedRef.current) {
      verticalVelocity.current = JUMP_VELOCITY;
    }
    lastJumpCount.current = jumpRequestCount;
  }, [jumpRequestCount]);

  useFrame((_, delta) => {
    if (disabledRef.current) return;

    const keys = keysPressed.current;
    const forward = mobileMoveInput.y || (keys.has('KeyW') ? 1 : keys.has('KeyS') ? -1 : 0);
    const strafe = mobileMoveInput.x || (keys.has('KeyD') ? 1 : keys.has('KeyA') ? -1 : 0);

    // Drain the mobile free-look accumulator: apply whatever yaw has
    // built up since last frame (already sensitivity-scaled by
    // MobileControls, so it's applied directly rather than multiplied
    // by delta — unlike a joystick "held" value, this is a one-shot
    // amount of turn that arrived since we last checked), then zero it
    // out so it isn't re-applied next frame with no new drag input.
    if (mobileLookDeltaRef && mobileLookDeltaRef.current !== 0) {
      camera.rotation.y += mobileLookDeltaRef.current;
      mobileLookDeltaRef.current = 0;
    }

    if (forward === 0 && strafe === 0) {
      velocity.current.set(0, 0, 0);
    } else {
      // Move relative to camera facing, but flatten to the XZ plane so
      // looking up/down doesn't speed up or slow down ground movement.
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      direction.y = 0;
      direction.normalize();

      // cross(direction, up) gives the camera's RIGHT vector in a
      // right-handed coordinate system (which Three.js uses). The
      // previous order, cross(up, direction), produces the negated
      // (LEFT) vector instead — cross product is anti-commutative,
      // so swapping the argument order flips the sign. That's exactly
      // why A/D felt reversed: strafe=+1 (D, "move right") was being
      // multiplied against the LEFT vector, visually moving the
      // player left when pressing the key meant for right, and vice
      // versa for A.
      const right = new THREE.Vector3().crossVectors(direction, camera.up).normalize();

      const isSprinting = mobileSprint || keys.has('ShiftLeft') || keys.has('ShiftRight');
      const currentSpeed = isSprinting ? SPRINT_SPEED : WALK_SPEED;

      velocity.current
        .copy(direction)
        .multiplyScalar(forward)
        .addScaledVector(right, strafe)
        .normalize()
        .multiplyScalar(currentSpeed * delta);

      // heightAboveGround IS the feet height relative to floor baseline
      // (PLAYER_HEIGHT is added separately to get the camera/eye height).
      const feetHeight = heightAboveGround.current;

      // Try the full diagonal move first; if blocked, slide by trying
      // each axis independently. This gives a proper "slide along the
      // wall" feel instead of fully freezing the instant any contact
      // happens — e.g. moving diagonally into a corner still lets you
      // slide along whichever axis isn't blocked.
      const candidateX = playerPositionRef.current.x + velocity.current.x;
      const candidateZ = playerPositionRef.current.z + velocity.current.z;

      if (!collidesAt(candidateX, candidateZ, feetHeight, colliders, floorPlanes, wallColliders)) {
        playerPositionRef.current.x = candidateX;
        playerPositionRef.current.z = candidateZ;
      } else {
        if (!collidesAt(candidateX, playerPositionRef.current.z, feetHeight, colliders, floorPlanes, wallColliders)) {
          playerPositionRef.current.x = candidateX;
        }
        if (!collidesAt(playerPositionRef.current.x, candidateZ, feetHeight, colliders, floorPlanes, wallColliders)) {
          playerPositionRef.current.z = candidateZ;
        }
      }
    }

    // Clamp to map bounds so players can't walk through walls into the void.
    playerPositionRef.current.x = THREE.MathUtils.clamp(playerPositionRef.current.x, bounds.min[0], bounds.max[0]);
    playerPositionRef.current.z = THREE.MathUtils.clamp(playerPositionRef.current.z, bounds.min[2], bounds.max[2]);
    // Gravity integration: while in the air, fall back toward whatever
    // surface is directly beneath the player — either the floor (height
    // 0) or the top of a collider prop they've jumped onto. groundHeightAt
    // re-check every frame using the player's CURRENT x/z, so walking
    // off the edge of something you're standing on correctly starts a
    // fall back toward the floor (or a different, lower collider)
    // rather than staying locked to whatever surface you landed on
    // originally.
    const feetHeight = heightAboveGround.current;
    let surfaceHeight = groundHeightAt(playerPositionRef.current.x, playerPositionRef.current.z, feetHeight, colliders, floorPlanes);
    const ceilingHeight = ceilingHeightAt(playerPositionRef.current.x, playerPositionRef.current.z, feetHeight, floorPlanes);

    // Raycast against the rendered scene to pick up authored geometry
    // (stairs, floors, ramps) that aren't represented as manifest
    // colliders/floorPlanes. Start the ray from the player's current
    // head height so it does not hit a roof/ceiling above the player
    // and incorrectly treat that as the ground.
    try {
      if (!raycasterRef.current) raycasterRef.current = new THREE.Raycaster();
      const rc = raycasterRef.current;
      const origin = new THREE.Vector3(
        playerPositionRef.current.x,
        playerPositionRef.current.y + 0.5,
        playerPositionRef.current.z
      );
      rc.set(origin, new THREE.Vector3(0, -1, 0));
      rc.far = 50;
      const intersects = scene ? rc.intersectObject(scene, true) : [];
      const headY = playerPositionRef.current.y;
      let bestHitY = -Infinity;
      for (const hit of intersects) {
        // Skip the local player's own 3rd-person body mesh (tagged via
        // userData.excludeFromGroundRay on its wrapping group in
        // MapScene.tsx). This ray starts directly above the player's own
        // x/z, so once that mesh exists in the scene (3rd-person view
        // only — it isn't rendered in 1st person) it self-intersects,
        // gets read as "ground" above the real floor, and the player
        // snaps up onto it — which redraws the mesh even higher, which
        // the next frame hits again. Without this skip that feedback
        // loop runs away and launches the player into the sky, which is
        // exactly the bug this guards against.
        let node: THREE.Object3D | null = hit.object;
        let excluded = false;
        while (node) {
          if (node.userData?.excludeFromGroundRay) {
            excluded = true;
            break;
          }
          node = node.parent;
        }
        if (excluded) continue;

        const hitY = hit.point.y;
        if (hitY <= headY - 0.05 && hitY > bestHitY) {
          bestHitY = hitY;
        }
      }
      if (bestHitY !== -Infinity && bestHitY > surfaceHeight) {
        // Only accept this as the new ground height if it's a small
        // step up from where the player's feet currently are, OR
        // they're actually airborne (mid-jump) and legitimately landing
        // on something taller. Without this cap, this raycast — which
        // runs every frame regardless of collidesAt/floorPlane gating —
        // will snap the player straight up onto the top of ANY taller
        // surface (a ramp cap, a raised platform, a truck bed, etc.) the
        // instant it becomes the nearest thing directly underneath them,
        // even though they only walked up to its side. That's exactly
        // the "walk into it and get teleported on top of it" bug: real
        // stairs work fine today because each individual step is a tiny
        // rise (well under MAX_STEP_UP), but anything taller was being
        // treated the same way — one big instant snap instead of
        // requiring an actual jump.
        const MAX_STEP_UP = 0.6; // meters — generous for stairs/curbs,
                                   // too small to silently climb a
                                   // waist-height-or-taller platform
        const isAirborne = verticalVelocity.current !== 0 || !isGroundedRef.current;
        const stepUp = bestHitY - heightAboveGround.current;
        if (isAirborne || stepUp <= MAX_STEP_UP) {
          surfaceHeight = bestHitY;
        }
      }
    } catch (e) {
      // Raycast may fail in exotic contexts; fail silently and fall
      // back to collider-based ground logic.
    }

    // Stabilize small fluctuations in detected surface height to avoid
    // jitter that can cause unintended automatic jumping/clipping.
    const prevSurface = previousSurfaceHeightRef.current ?? 0;
    if (Math.abs(surfaceHeight - prevSurface) < 0.05) {
      surfaceHeight = prevSurface;
    } else {
      previousSurfaceHeightRef.current = surfaceHeight;
    }

    if (heightAboveGround.current > surfaceHeight || verticalVelocity.current > 0) {
      verticalVelocity.current += GRAVITY * delta;
      heightAboveGround.current += verticalVelocity.current * delta;
      if (heightAboveGround.current <= surfaceHeight) {
        heightAboveGround.current = surfaceHeight;
        verticalVelocity.current = 0;
        isGroundedRef.current = true;
      } else {
        isGroundedRef.current = false;
      }
    } else {
      // Already at or below the current surface height (e.g. the
      // collider that was supporting you just changed because you
      // moved) — snap up to stand on it rather than floating/clipping.
      heightAboveGround.current = surfaceHeight;
      isGroundedRef.current = true;
    }

    const headY = PLAYER_HEIGHT + heightAboveGround.current;
    if (headY > ceilingHeight - 0.05) {
      heightAboveGround.current = ceilingHeight - PLAYER_HEIGHT;
      verticalVelocity.current = Math.min(verticalVelocity.current, 0);
      isGroundedRef.current = false;
    }

    playerPositionRef.current.y = PLAYER_HEIGHT + heightAboveGround.current;
    if (!thirdPerson) {
      camera.position.copy(playerPositionRef.current);
    }

    if (onPositionChange) {
      // Derive yaw via atan2 on the camera's forward direction vector,
      // rather than reading camera.rotation.y directly. PointerLockControls
      // manages rotation internally with its own Euler order, and combined
      // pitch+yaw changes can make a direct .rotation.y read unreliable
      // (a well-documented three.js gotcha — looking up/down while turning
      // can bleed into the wrong axis depending on Euler decomposition
      // order). atan2 on the direction vector's X/Z components gives yaw
      // directly from geometry, sidestepping that ambiguity entirely.
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const rotationY = Math.atan2(dir.x, dir.z);
      onPositionChange(
        [playerPositionRef.current.x, playerPositionRef.current.y, playerPositionRef.current.z],
        rotationY
      );
    }
  });

  return null;
}
