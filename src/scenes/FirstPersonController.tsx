import { useEffect, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3Tuple, MapBounds, MorphableProp } from '../types/game';

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
  mobileLookInput?: number;
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
export interface FloorPlane {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

function insideFloorPlane(x: number, z: number, plane: FloorPlane): boolean {
  return x >= plane.minX && x <= plane.maxX && z >= plane.minZ && z <= plane.maxZ;
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
  floorPlanes: FloorPlane[] = []
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
    if (insideFloorPlane(x, z, plane) && plane.height > highest) {
      highest = plane.height;
    }
  }
  return highest;
}

/** Bare WASD + pointer-lock-look first-person movement, now with basic
 * cylinder-vs-cylinder collision against the manifest's morphable props.
 * Pairs with
 * <PointerLockControls /> already in MapScene for the mouse-look part;
 * this component only handles keyboard-driven translation and keeps the
 * player within manifest.bounds. */
export function FirstPersonController({ startPosition, bounds, colliders = [], floorPlanes = [], playerPositionRef, thirdPerson = false, onPositionChange, disabled = false, mobileMoveInput = { x: 0, y: 0 }, mobileLookInput = 0, mobileSprint = false, jumpRequestCount = 0 }: FirstPersonControllerProps) {
  const { camera } = useThree();
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
  const mobileYawRef = useRef(0);

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
    const rotateYaw = mobileLookInput;

    if (rotateYaw !== 0) {
      mobileYawRef.current += rotateYaw * delta * 2.5; // rotation sensitivity
      camera.rotation.y += rotateYaw * delta * 2.5;
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

      if (!collidesAt(candidateX, candidateZ, feetHeight, colliders, floorPlanes)) {
        playerPositionRef.current.x = candidateX;
        playerPositionRef.current.z = candidateZ;
      } else {
        if (!collidesAt(candidateX, playerPositionRef.current.z, feetHeight, colliders, floorPlanes)) {
          playerPositionRef.current.x = candidateX;
        }
        if (!collidesAt(playerPositionRef.current.x, candidateZ, feetHeight, colliders, floorPlanes)) {
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
    const surfaceHeight = groundHeightAt(playerPositionRef.current.x, playerPositionRef.current.z, colliders, floorPlanes);

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
