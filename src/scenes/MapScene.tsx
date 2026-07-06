import { Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF, useAnimations, PointerLockControls } from '@react-three/drei';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import * as THREE from 'three';
import { useMapManifest } from '../hooks/useMapManifest';
import { useMorphSystem } from '../hooks/useMorphSystem';
import { useShooting } from '../hooks/useShooting';
import { FirstPersonController } from './FirstPersonController';
import { MobileControls } from '../components/MobileControls';
import type { FloorPlane, MapManifest, MorphableProp, PlayerRole, PlayerRow, Vec3Tuple } from '../types/game';

// p.pos_y is the LOCAL PLAYER's synced CAMERA position (eye height,
// matching FirstPersonController's PLAYER_HEIGHT = 1.7), not a
// ground-relative body position. Rendering another player's capsule
// or morphed-prop mesh directly AT that y-value floats them ~1.7m
// above the floor — exactly the bug reported after real assets made
// it visually obvious (placeholder cylinders happened to be tall
// enough to make the floating less noticeable).
//
// Fix: capsules render with their CENTER at half their own height
// above ground (so feet touch y=0); morphed real-asset props render
// at y=0 directly, since Kenney's models are typically modeled with
// their base at the origin, not centered at eye height. Both
// derive from EYE_HEIGHT rather than re-deriving p.pos_y's meaning
// in four separate places.
const CAPSULE_HEIGHT = 1.2; // must match the capsuleGeometry args below
const CAPSULE_GROUND_Y = CAPSULE_HEIGHT / 2; // center height so feet sit at y=0
const SYNCED_EYE_HEIGHT = 1.7; // must match FirstPersonController.PLAYER_HEIGHT

/** Recovers a player's actual height-above-ground from their synced
 * pos_y (which is the CAMERA's eye-height value, PLAYER_HEIGHT + however
 * high they currently are off the ground from a jump). Without this,
 * jump height was being silently discarded when rendering OTHER
 * players — they'd always render flat on the ground even while
 * actually airborne/standing on top of a prop, which is exactly the
 * "jump isn't visible to other players" bug. Clamped to >= 0 since a
 * value below 0 would only happen from a sync glitch, not a real
 * in-game state. */
function heightAboveGroundFromPosY(posY: number): number {
  return Math.max(0, posY - SYNCED_EYE_HEIGHT);
}

// Replace these with the GLB/GLTF files you placed under public/characters/
// e.g. copy the selected models from your UltimateCharacterPack into
// public/characters/seeker.glb and public/characters/hider.glb
const ROLE_MODEL_PATHS: Record<Exclude<PlayerRole, null>, string> = {
  seeker: '/characters/Knight_Golden_Male.gltf',
  hider: '/characters/Casual3_Female.gltf',
};

/** Simple ground-height lookup for animation airborne detection.
 * Mirrors FirstPersonController's groundHeightAt logic but lives here
 * so PlayerCharacter can use it without importing internals. */
function groundHeightAt(
  x: number,
  z: number,
  colliders: MorphableProp[],
): number {
  let highest = 0;
  for (const c of colliders) {
    const dx = x - c.position[0];
    const dz = z - c.position[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.3 + c.footprint.radius && c.footprint.height > highest) {
      highest = c.footprint.height;
    }
  }
  return highest;
}

interface PlayerCharacterProps {
  playerId: string;
  role: PlayerRole;
  position: [number, number, number];
  rotationY: number;
  scale?: [number, number, number];
  hp: number;
  lastShotTime: number;
  morphables: MorphableProp[];
}

function PlayerCharacter({
  playerId,
  role,
  position,
  rotationY,
  scale = [0.75, 0.75, 0.75],
  hp,
  lastShotTime,
  morphables,
}: PlayerCharacterProps) {
  const modelPath = ROLE_MODEL_PATHS[role ?? 'hider'];
  const gltf = useGLTF(modelPath) as unknown as { scene: THREE.Object3D; animations: THREE.AnimationClip[] };
  const ref = useRef<THREE.Group>(null);

  // 1. Hit Reaction State (RecieveHit)
  const [localIsHit, setLocalIsHit] = useState(false);
  const prevHpRef = useRef(hp);

  useEffect(() => {
    if (hp < prevHpRef.current && hp > 0) {
      setLocalIsHit(true);
      const timer = setTimeout(() => {
        setLocalIsHit(false);
      }, 500);
      return () => clearTimeout(timer);
    }
    prevHpRef.current = hp;
  }, [hp]);

  // 2. Shooting State (Shoot_OneHanded)
  const [localIsShooting, setLocalIsShooting] = useState(false);
  useEffect(() => {
    if (lastShotTime === 0) return;
    const elapsed = Date.now() - lastShotTime;
    if (elapsed < 500) {
      setLocalIsShooting(true);
      const timer = setTimeout(() => {
        setLocalIsShooting(false);
      }, 500 - elapsed);
      return () => clearTimeout(timer);
    }
  }, [lastShotTime]);

  // 3. Movement Action State (Idle, Walk, Run) and Jumping State (Jump)
  const previousPosition = useRef<[number, number, number]>(position);
  const lastUpdateTimeRef = useRef<number>(Date.now());
  const [movementAction, setMovementAction] = useState<'Idle' | 'Walk' | 'Run'>('Idle');
  const [isAirborne, setIsAirborne] = useState(false);

  useEffect(() => {
    const now = Date.now();
    const dt = (now - lastUpdateTimeRef.current) / 1000;
    lastUpdateTimeRef.current = now;

    const dx = position[0] - previousPosition.current[0];
    const dz = position[2] - previousPosition.current[2];
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    previousPosition.current = position;

    // Movement detection
    if (horizDist < 0.02) {
      setMovementAction('Idle');
    } else {
      const speed = dt > 0.01 ? horizDist / dt : 0;
      if (speed > 4.8) {
        setMovementAction('Run');
      } else {
        setMovementAction('Walk');
      }
    }

    // Airborne detection (feetHeight is position[1])
    const feetHeight = position[1];
    const surfaceHeight = groundHeightAt(position[0], position[2], morphables);
    setIsAirborne(feetHeight > surfaceHeight + 0.15);
  }, [position, morphables]);

  // Determine active action
  let action: 'Idle' | 'Walk' | 'Run' | 'Jump' | 'Shoot_OneHanded' | 'RecieveHit' = 'Idle';
  if (localIsHit) {
    action = 'RecieveHit';
  } else if (localIsShooting) {
    action = 'Shoot_OneHanded';
  } else if (isAirborne) {
    action = 'Jump';
  } else {
    action = movementAction;
  }

  const clonedScene = useMemo(() => {
    if (!gltf?.scene) return null;
    const clone = cloneSkeleton(gltf.scene);
    clone.traverse((child: THREE.Object3D) => {
      // Sanitize the node names to match Three's PropertyBinding mapping (e.g. Foot.R -> FootR)
      if (child.name) {
        child.name = THREE.PropertyBinding.sanitizeNodeName(child.name);
      }
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.frustumCulled = false;
        child.userData.playerId = playerId;
        child.visible = true;

        try {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          const applyColorToMaterial = (material: any, colorHex: number) => {
            if (material && 'color' in material) {
              material.color.setHex(colorHex);
              material.needsUpdate = true;
            }
          };

          if (role === 'seeker') {
            for (const mat of materials) {
              const name = (mat?.name ?? '').toLowerCase();
              if (name.includes('armor') || name.includes('detail') || name.includes('red') || name.includes('helmet')) {
                applyColorToMaterial(mat, 0xffcc33);
              }
            }
          } else if (role === 'hider') {
            for (const mat of materials) {
              const name = (mat?.name ?? '').toLowerCase();
              if (name.includes('hair')) {
                applyColorToMaterial(mat, 0xff66cc);
              }
            }
          }
        } catch (e) {
          // ignore material tint errors
        }
      }
    });
    return clone;
  }, [gltf.scene, playerId, role]);

  const { actions } = useAnimations(gltf.animations, ref);

  useEffect(() => {
    if (!actions) return;
    const chosenAction = actions[action] ?? actions.Idle ?? actions.Walk ?? Object.values(actions)[0];
    if (chosenAction) {
      chosenAction.reset().fadeIn(0.15).play();
      return () => {
        chosenAction.fadeOut(0.15);
      };
    }
  }, [actions, action]);

  // Client-side smooth movement/rotation interpolation (lerping)
  const targetPositionRef = useRef<[number, number, number]>(position);
  const targetRotationYRef = useRef<number>(rotationY);

  useEffect(() => {
    targetPositionRef.current = position;
  }, [position]);

  useEffect(() => {
    targetRotationYRef.current = rotationY;
  }, [rotationY]);

  // Set initial position/rotation directly on mount
  useEffect(() => {
    if (ref.current) {
      ref.current.position.set(...position);
      ref.current.rotation.set(0, rotationY, 0);
    }
  }, []);

  useFrame((_, delta) => {
    if (!ref.current) return;
    const t = 1 - Math.exp(-15 * delta); // frame-rate independent interpolation weight
    
    // Smooth position lerp
    const currentPos = ref.current.position;
    const targetPos = targetPositionRef.current;
    currentPos.x = THREE.MathUtils.lerp(currentPos.x, targetPos[0], t);
    currentPos.y = THREE.MathUtils.lerp(currentPos.y, targetPos[1], t);
    currentPos.z = THREE.MathUtils.lerp(currentPos.z, targetPos[2], t);
    
    // Smooth rotation angle lerp (handles wrap-around correctly)
    let diff = targetRotationYRef.current - ref.current.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    ref.current.rotation.y += diff * t;
  });

  if (!clonedScene) return null;

  return (
    <group ref={ref} scale={scale}>
      <primitive object={clonedScene} />
    </group>
  );
}


interface MapSceneProps {
  mapId: string;
  /** Which spawn pool to use and how to position the camera initially.
   * Picks the first available spawn point for the given role — caller
   * is responsible for picking a specific index if multiple players
   * share a role (avoids everyone spawning stacked on top of each other). */
  role: PlayerRole;
  spawnIndex?: number;
  /** called once the manifest + glb are both ready, with a lookup of
   *  morphable id -> the actual mesh clone to render for a morphed player */
  onReady?: (morphMeshes: Map<string, THREE.Object3D>) => void;
  /** fired every frame with the local player's current position/rotation —
   *  caller throttles this to ~10-15Hz before sending to Supabase. */
  onPositionChange?: (position: [number, number, number], rotationY: number) => void;
  /** every OTHER connected player (self already excluded by the caller),
   *  rendered as a capsule at their last-synced position, or as the
   *  exact prop they're morphed into if morphed_into is set. */
  otherPlayers?: PlayerRow[];
  /** this player's own id and current morph state — needed by the morph
   *  system (useMorphSystem lives inside the Canvas via useThree, so it
   *  has to be wired through here rather than called directly by
   *  GameScreen, which is outside the Canvas). Both are required
   *  together; omit both for a seeker (who can't morph anyway). */
  selfPlayerId?: string;
  selfPlayer?: PlayerRow | null;
  currentMorphId?: string | null;
  /** fired whenever the "prop you could morph into right now" changes,
   *  so the caller can render an HTML prompt ("Press E to morph")
   *  OUTSIDE the canvas, where normal DOM/CSS overlay works. */
  onMorphPromptChange?: (prop: MorphableProp | null) => void;
  /** fired right after a seeker's shot successfully hits another
   *  player, with that player's id and whether the hit converted them
   *  to a seeker. Only relevant when role === 'seeker'; ignored
   *  entirely for hiders since they never have a gun. */
  onHitRegistered?: (targetPlayerId: string, converted: boolean) => void;
  lastShotTimes?: Record<string, number>;
  seekerIntroActive?: boolean;
  onShoot?: () => void;
}

export function MapScene({
  mapId,
  role,
  spawnIndex = 0,
  onReady,
  onPositionChange,
  otherPlayers = [],
  selfPlayerId,
  selfPlayer,
  currentMorphId = null,
  onMorphPromptChange,
  onHitRegistered,
  lastShotTimes = {},
  seekerIntroActive = false,
  onShoot,
}: MapSceneProps) {
  const { manifest, loading, error } = useMapManifest(mapId);

  const [thirdPerson, setThirdPerson] = useState(false);
  const [mobileActive, setMobileActive] = useState(false);
  const [landscapeHint, setLandscapeHint] = useState(false);
  const [moveInput, setMoveInput] = useState({ x: 0, y: 0 });
  const [lookInput, setLookInput] = useState(0);
  const [sprintActive, setSprintActive] = useState(false);
  const [jumpRequestCount, setJumpRequestCount] = useState(0);
  const [morphRequestCount, setMorphRequestCount] = useState(0);
  const [shootRequestCount, setShootRequestCount] = useState(0);
  const [scenePlanes, setScenePlanes] = useState<FloorPlane[]>([]);
  const spawnPool: Vec3Tuple[] = manifest
    ? role === 'seeker'
      ? manifest.spawns.seeker
      : manifest.spawns.hider
    : [[0, SYNCED_EYE_HEIGHT, 0]];
  const initialStart = (spawnPool[spawnIndex % spawnPool.length] ?? spawnPool[0]) as Vec3Tuple;
  const [startPosition, setStartPosition] = useState<Vec3Tuple>(initialStart);
  const playerPositionRef = useRef(new THREE.Vector3(startPosition[0], SYNCED_EYE_HEIGHT, startPosition[2]));

  useEffect(() => {
    function handleToggleKey(e: KeyboardEvent) {
      if (e.code !== 'KeyV') return;
      setThirdPerson((prev) => !prev);
    }

    function handleTouchStart() {
      setMobileActive(true);
      if (window.screen && window.screen.orientation) {
        const isLandscape = window.screen.orientation.type.startsWith('landscape');
        setLandscapeHint(!isLandscape);
      }
    }

    window.addEventListener('keydown', handleToggleKey);
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    return () => {
      window.removeEventListener('keydown', handleToggleKey);
      window.removeEventListener('touchstart', handleTouchStart);
    };
  }, []);

  function insidePlane(x: number, z: number, plane: FloorPlane): boolean {
    return x >= plane.minX && x <= plane.maxX && z >= plane.minZ && z <= plane.maxZ;
  }

  // When scene-derived floor planes become available, clamp the
  // configured spawn position to the detected surface so players do
  // not appear above roofs or under ceilings. startPosition is the
  // camera-eye vector (y = SYNCED_EYE_HEIGHT above the surface).
  useEffect(() => {
    if (!manifest || scenePlanes.length === 0 || !startPosition) return;
    const x = startPosition[0];
    const z = startPosition[2];
    // check morphable colliders for any prop under the spawn
    let highest = 0;
    for (const c of manifest.morphables) {
      const dx = x - c.position[0];
      const dz = z - c.position[2];
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 0.3 + c.footprint.radius && c.footprint.height > highest) highest = c.footprint.height;
    }
    // check scene-derived planes but ignore ceilings for spawn height
    for (const p of scenePlanes) {
      if (!p.isCeiling && insidePlane(x, z, p) && p.height > highest) {
        highest = p.height;
      }
    }
    const newStart: Vec3Tuple = [x, highest + SYNCED_EYE_HEIGHT, z];
    if (newStart[1] !== startPosition[1]) {
      setStartPosition(newStart);
    }
  }, [scenePlanes, manifest, startPosition]);

  if (error) {
    return <div className="map-error">Failed to load map "{mapId}": {error}</div>;
  }
  if (loading || !manifest) {
    return <div className="map-loading">Loading map…</div>;
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas camera={{ fov: 75, near: 0.1, far: 100 }} shadows={false} dpr={1.0}>
        <Suspense fallback={null}>
          <SceneContents
            manifest={manifest}
            onReady={onReady}
            onSceneReady={(planes: FloorPlane[]) => setScenePlanes(planes)}
            otherPlayers={otherPlayers}
            role={role}
            selfPlayer={selfPlayer}
            thirdPerson={thirdPerson}
            playerPositionRef={playerPositionRef}
            lastShotTimes={lastShotTimes}
          />
        </Suspense>
        <PointerLockControls />
        {thirdPerson && <ThirdPersonCamera selfPlayer={selfPlayer} enabled={thirdPerson} maxCameraY={manifest.bounds.max[1]} />}
        <FirstPersonController
          startPosition={startPosition}
          bounds={manifest.bounds}
          colliders={manifest.morphables}
          wallColliders={manifest.buildingWalls}
          floorPlanes={scenePlanes}
          playerPositionRef={playerPositionRef}
          thirdPerson={thirdPerson}
          onPositionChange={onPositionChange}
          disabled={role === 'seeker' && seekerIntroActive}
          mobileMoveInput={moveInput}
          mobileLookInput={lookInput}
          mobileSprint={sprintActive}
          jumpRequestCount={jumpRequestCount}
        />
        {selfPlayerId && role === 'hider' && (
          <MorphController
            playerId={selfPlayerId}
            morphables={manifest.morphables}
            currentMorphId={currentMorphId}
            triggerMorph={morphRequestCount}
            onPromptChange={onMorphPromptChange}
            maxSafeY={manifest.bounds.max[1] + SYNCED_EYE_HEIGHT}
          />
        )}
        {role === 'seeker' && selfPlayerId && selfPlayer && (
          <ShootController
            roomId={selfPlayer.room_id}
            selfPlayerId={selfPlayerId}
            onHit={onHitRegistered}
            onShoot={onShoot}
            disabled={role === 'seeker' && seekerIntroActive}
            triggerShoot={shootRequestCount}
          />
        )}
      </Canvas>
      <div style={{ position: 'absolute', bottom: 12, right: 12, background: 'rgba(0,0,0,0.5)', color: 'white', padding: '8px 10px', borderRadius: 6, fontSize: 13, pointerEvents: 'none' }}>
        View: {thirdPerson ? '3rd person' : '1st person'} (press V)
      </div>
      {selfPlayer && (
        <div style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(0,0,0,0.5)', color: 'white', padding: '8px 10px', borderRadius: 6, fontSize: 13, pointerEvents: 'none' }}>
          X: {selfPlayer.pos_x.toFixed(1)} &nbsp; Y: {selfPlayer.pos_y.toFixed(1)} &nbsp; Z: {selfPlayer.pos_z.toFixed(1)}
        </div>
      )}
      {mobileActive && (
        <MobileControls
          onMoveChange={setMoveInput}
          onLookChange={setLookInput}
          onJump={() => setJumpRequestCount((prev) => prev + 1)}
          onSprintChange={setSprintActive}
          onAction={() => {
            if (role === 'seeker') {
              setShootRequestCount((prev) => prev + 1);
            } else {
              setMorphRequestCount((prev) => prev + 1);
            }
          }}
          actionLabel={role === 'seeker' ? 'Shoot' : currentMorphId ? 'Un-morph' : 'Morph'}
          showLandscapeHint={landscapeHint}
          onEnsureLandscape={() => {
            const screenAny = window.screen as any;
            if (screenAny.orientation && typeof screenAny.orientation.lock === 'function') {
              screenAny.orientation.lock('landscape').catch(() => {
                setLandscapeHint(true);
              });
            }
          }}
        />
      )}
    </div>
  );
}

/** Thin wrapper so useMorphSystem (which needs useThree/useFrame, only
 * available inside <Canvas>) can still report its state up to an HTML
 * overlay rendered outside the canvas — bridges via a callback fired
 * from a useEffect rather than returning JSX, since this component
 * renders nothing itself. */
function MorphController({
  playerId,
  morphables,
  currentMorphId,
  triggerMorph,
  onPromptChange,
  maxSafeY,
}: {
  playerId: string;
  morphables: MorphableProp[];
  currentMorphId: string | null;
  triggerMorph?: number;
  onPromptChange?: (prop: MorphableProp | null) => void;
  maxSafeY?: number;
}) {
  const { nearbyProp } = useMorphSystem({
    playerId,
    morphables,
    currentMorphId,
    enabled: true,
    triggerMorph,
    maxSafeCameraY: maxSafeY,
  });

  const lastReported = useRef<string | null>(null);
  if (onPromptChange && nearbyProp?.id !== lastReported.current) {
    lastReported.current = nearbyProp?.id ?? null;
    onPromptChange(nearbyProp);
  }

  return null;
}

/** Thin wrapper so useShooting (needs useThree, only available inside
 * <Canvas>) can report hits up to GameScreen, which lives outside the
 * canvas and owns round-lifecycle decisions (win-check, HUD messages). */
function ShootController({
  roomId,
  selfPlayerId,
  onHit,
  onShoot,
  triggerShoot,
  disabled = false,
}: {
  roomId: string;
  selfPlayerId: string;
  onHit?: (targetPlayerId: string, converted: boolean) => void;
  onShoot?: () => void;
  triggerShoot?: number;
  disabled?: boolean;
}) {
  useShooting({ enabled: true, roomId, selfPlayerId, onHit, onShoot, triggerShoot, disabled });
  return null;
}

/** Renders every other connected player as a capsule, color-coded by
 * role (red = seeker, blue = hider) so it's visually obvious who's who
 * during testing. Position comes straight from the last realtime sync —
 * no client-side interpolation yet, so movement will look a bit
 * stepped/laggy at ~12Hz updates until that's added. */
function OtherPlayers({ players, morphables, lastShotTimes = {} }: { players: PlayerRow[]; morphables: MorphableProp[]; lastShotTimes?: Record<string, number> }) {
  return (
    <group>
      {players.map((p) => {
        if (p.morphed_into) {
          const prop = morphables.find((m) => m.id === p.morphed_into);
          if (prop) {
            // IMPORTANT: position/rotation come from the PLAYER's live
            // synced data (p.pos_x/y/z, p.rot_y), NOT from the static
            // manifest prop's fixed location. The manifest prop only
            // supplies the visual SHAPE (footprint radius/height,
            // group color) — what the disguise looks like. A morphed
            // hider walks around freely looking like a vending machine;
            // they are not welded to the real vending machine's spot.
            //
            // This also means the shooting raycast (which targets
            // wherever this mesh actually is) correctly hits the
            // morphed player wherever they've walked to, not the
            // original prop's location — shooting the real, static
            // vending machine elsewhere in the store does nothing.
            //
            // userData.playerId tags this mesh for the shooting system —
            // ShootController raycasts against the scene and reads this
            // back to know WHICH player got hit.
            return (
              <mesh
                key={p.id}
                position={[p.pos_x, heightAboveGroundFromPosY(p.pos_y), p.pos_z]}
                rotation={[0, p.rot_y, 0]}
                scale={prop.scale}
                castShadow
                userData={{ playerId: p.id }}
              >
                <cylinderGeometry args={[prop.footprint.radius, prop.footprint.radius, prop.footprint.height, 8]} />
                <meshStandardMaterial color={colorForGroup(prop.groupId)} />
              </mesh>
            );
          }
          // morphed_into references an id not found in this map's
          // manifest (shouldn't normally happen) — fall through to the
          // PlayerCharacter below rather than render nothing, so a data
          // mismatch remains visible and debuggable.
        }

        if (p.role) {
          return (
            <PlayerCharacter
              key={p.id}
              playerId={p.id}
              role={p.role}
              position={[p.pos_x, heightAboveGroundFromPosY(p.pos_y), p.pos_z]}
              rotationY={p.rot_y}
              scale={[0.75, 0.75, 0.75]}
              hp={p.hp}
              lastShotTime={lastShotTimes[p.id] ?? 0}
              morphables={morphables}
            />
          );
        }

        return (
          <mesh
            key={p.id}
            position={[p.pos_x, CAPSULE_GROUND_Y + heightAboveGroundFromPosY(p.pos_y), p.pos_z]}
            rotation={[0, p.rot_y, 0]}
            castShadow
            userData={{ playerId: p.id }}
          >
            <capsuleGeometry args={[0.3, 1.2, 4, 8]} />
            <meshStandardMaterial color="#666666" />
          </mesh>
        );
      })}
    </group>
  );
}

function SceneContents(props: SceneContentsProps) {
  const {
    manifest,
    onReady,
    onSceneReady,
    otherPlayers,
    role,
    selfPlayer,
    thirdPerson,
    playerPositionRef,
    lastShotTimes = {},
  } = props;
  // Debug overlay: draw manifest bounds and spawn points in-scene so
  // it's easy to visually confirm where players can walk and where
  // stairs/spawn points are located.
  function DebugOverlay({ manifest }: { manifest: MapManifest }) {
    const { bounds, spawns } = manifest;
    const boxMemo = useMemo(() => {
      const min = new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]);
      const max = new THREE.Vector3(bounds.max[0], bounds.max[1], bounds.max[2]);
      const size = new THREE.Vector3().subVectors(max, min);
      const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
      const geom = new THREE.BoxGeometry(size.x, size.y, size.z);
      const edges = new THREE.EdgesGeometry(geom);
      const mat = new THREE.LineBasicMaterial({ color: 0x00ff00 });
      return { edges, mat, center };
    }, [manifest.id, manifest.bounds]);

    const hiderSpawns = spawns?.hider ?? [];
    const seekerSpawns = spawns?.seeker ?? [];
    const buildingWalls = manifest.buildingWalls ?? [];

    return (
      <group>
        <lineSegments geometry={boxMemo.edges} material={boxMemo.mat} position={[boxMemo.center.x, boxMemo.center.y, boxMemo.center.z]} renderOrder={999} />
        {hiderSpawns.map((s, i) => (
          <mesh key={`hider-${i}`} position={[s[0], s[1] ?? 0.1, s[2]]} renderOrder={998}>
            <sphereGeometry args={[0.25, 8, 8]} />
            <meshBasicMaterial color={0x0077ff} depthTest={false} depthWrite={false} />
          </mesh>
        ))}
        {seekerSpawns.map((s, i) => (
          <mesh key={`seeker-${i}`} position={[s[0], s[1] ?? 0.1, s[2]]} renderOrder={998}>
            <coneGeometry args={[0.25, 0.5, 8]} />
            <meshBasicMaterial color={0xff3300} depthTest={false} depthWrite={false} />
          </mesh>
        ))}
        {/* Orange wireframe per invisible wall collider — lets you SEE
            exactly where a buildingWalls entry sits against the real
            building geometry underneath it, so placing/nudging box
            coordinates in the manifest is a visual "does the box line up
            with the wall" check rather than a guessing game. */}
        {buildingWalls.map((w) => {
          const sizeX = w.maxX - w.minX;
          const sizeY = w.maxY - w.minY;
          const sizeZ = w.maxZ - w.minZ;
          const cx = (w.minX + w.maxX) / 2;
          const cy = (w.minY + w.maxY) / 2;
          const cz = (w.minZ + w.maxZ) / 2;
          return (
            <mesh key={w.id} position={[cx, cy, cz]} renderOrder={997}>
              <boxGeometry args={[sizeX, sizeY, sizeZ]} />
              <meshBasicMaterial color={0xff8800} wireframe depthTest={false} depthWrite={false} />
            </mesh>
          );
        })}
      </group>
    );
  }
  if (manifest.usePlaceholderGeometry) {
    return (
      <>
        <PlaceholderSceneContents
          manifest={manifest}
          onReady={onReady}
          onSceneReady={onSceneReady}
          otherPlayers={otherPlayers}
          role={role}
          selfPlayer={selfPlayer}
          thirdPerson={thirdPerson}
          playerPositionRef={playerPositionRef}
          lastShotTimes={lastShotTimes}
        />
        <DebugOverlay manifest={manifest} />
      </>
    );
  }
  return (
    <>
      <GltfSceneContents
        manifest={manifest}
        onReady={onReady}
        onSceneReady={onSceneReady}
        otherPlayers={otherPlayers}
        role={role}
        selfPlayer={selfPlayer}
        thirdPerson={thirdPerson}
        playerPositionRef={playerPositionRef}
        lastShotTimes={lastShotTimes}
      />
      <DebugOverlay manifest={manifest} />
    </>
  );
}

function GltfSceneContents(props: GltfSceneContentsProps) {
  const {
    manifest,
    onReady,
    onSceneReady,
    otherPlayers,
    role,
    selfPlayer,
    thirdPerson,
    playerPositionRef,
    lastShotTimes = {},
  } = props;
  const registered = useRef(false);

  // Which morphable instance IDs are currently occupied by some OTHER
  // player who's morphed into them — used to hide the static original
  // prop at that exact spot (see the morphables.map render further
  // below). Derived from otherPlayers only; the local player's own
  // morph state doesn't need to be included since first-person view
  // never renders the local player's own body/disguise anyway.
  const occupiedMorphIds = useMemo(() => {
    const set = new Set<string>();
    for (const p of otherPlayers) {
      if (p.morphed_into) set.add(p.morphed_into);
    }
    return set;
  }, [otherPlayers]);

  // Collect every distinct modelFile referenced anywhere in the manifest
  // (morphables, sceneDressing, walls, floorTiles) — each is its own
  // standalone .glb per Kenney's actual asset structure (one file per
  // object type, NOT one shared scene with named sub-nodes, which is
  // what the original nodeName-lookup design assumed). useGLTF caches
  // by URL, so loading the same file for multiple instances is cheap.
  const modelPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const m of manifest.morphables) if (m.modelFile) paths.add(m.modelFile);
    for (const d of manifest.sceneDressing ?? []) paths.add(d.modelFile);
    for (const w of manifest.walls ?? []) paths.add(w.modelFile);
    for (const f of manifest.floorTiles ?? []) paths.add(f.modelFile);
    for (const f of manifest.ceilingTiles ?? []) paths.add(f.modelFile);
    return Array.from(paths);
  }, [manifest]);

  // useGLTF supports an array of URLs and returns an array of results in
  // the same order — this preloads everything up front rather than one
  // at a time, avoiding pop-in as different prop types load late.
  // Cast through unknown: drei's bundled types are sometimes stricter
  // than the actual runtime overload for array input — if this throws
  // a type error on your machine, the runtime behavior is still
  // correct; widen the useGLTF import type or check your drei version.
  //
  // modelPaths is expected to be non-empty by the time this component
  // mounts — SceneContents (the dispatcher above) only renders this
  // branch for non-placeholder maps, which by definition must have at
  // least one real modelFile reference. If you hit the console.error
  // below with an empty list, the manifest itself is incomplete (e.g.
  // morphables/walls/floorTiles entries missing their modelFile field)
  // rather than something this component can safely paper over.
  if (modelPaths.length === 0) {
    console.error(
      `[map:${manifest.id}] usePlaceholderGeometry is false but no modelFile references were found anywhere in the manifest — nothing to load.`
    );
  }
  const gltfResults = useGLTF(
    modelPaths.map((p) => `/maps/${manifest.id}/${p}`)
  ) as unknown as Array<{ scene: THREE.Object3D }>;

  // Load the shared scene GLB (one big scene.glb) if the manifest
  // provides a sceneFile. This lets authors ship a full scene and still
  // combine it with smaller per-prop modelFile entries for morphables.
  const sceneGltf = manifest.sceneFile
    ? (useGLTF(`/maps/${manifest.id}/${manifest.sceneFile}`) as unknown as { scene: THREE.Object3D })
    : null;

  // Compute scene-derived floor and ceiling planes from authored GLTF
  // geometry. This gives us hard traversal surfaces for major horizontal
  // floors and ceilings without requiring explicit manifest markup.
  useEffect(() => {
    if (!sceneGltf?.scene) {
      onSceneReady?.([]);
      return;
    }
    try {
      sceneGltf.scene.updateWorldMatrix(true, true);
      const planes: FloorPlane[] = [];
      sceneGltf.scene.traverse((node: THREE.Object3D) => {
        if (!(node as any).isMesh) return;
        const mesh = node as THREE.Mesh;
        if (!mesh.geometry) return;

        const box = new THREE.Box3().setFromObject(mesh);
        const size = new THREE.Vector3();
        box.getSize(size);
        const area = size.x * size.z;
        if (area < 4 || size.y > 1.5) return;

        let averageNormalY = 0;
        const geometry = mesh.geometry as THREE.BufferGeometry;
        const normalAttr = geometry.attributes.normal;
        if (normalAttr) {
          const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
          const sampleCount = Math.min(normalAttr.count, 200);
          const step = Math.max(1, Math.floor(normalAttr.count / sampleCount));
          const tempNormal = new THREE.Vector3();
          let total = 0;
          for (let i = 0; i < normalAttr.count; i += step) {
            tempNormal.fromBufferAttribute(normalAttr, i).applyMatrix3(normalMatrix).normalize();
            averageNormalY += tempNormal.y;
            total += 1;
          }
          if (total > 0) averageNormalY /= total;
        } else {
          const worldUp = new THREE.Vector3(0, 1, 0).applyMatrix4(mesh.matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld)).normalize();
          averageNormalY = worldUp.y;
        }

        if (Math.abs(averageNormalY) < 0.6) return;
        const isCeiling = averageNormalY < 0;
        const height = isCeiling ? box.min.y : box.max.y;
        planes.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, height, isCeiling });
      });
      onSceneReady?.(planes);
    } catch (e) {
      onSceneReady?.([]);
    }
  }, [sceneGltf?.scene, onSceneReady]);

  const sceneByPath = useMemo(() => {
    const map = new Map<string, THREE.Object3D>();
    modelPaths.forEach((path, i) => {
      map.set(path, gltfResults[i].scene);
    });
    return map;
  }, [modelPaths, gltfResults]);

  // Morph targets: clone the matching modelFile's scene per morphable
  // instance, since each one needs its OWN Object3D (clones can be
  // independently shown/hidden when a hider morphs into it — sharing
  // the same instance across all candidates would mean morphing into
  // one secretly moves/hides all of them).
  const morphMeshes = useMemo(() => {
    const lookup = new Map<string, THREE.Object3D>();
    const missing: string[] = [];

    for (const prop of manifest.morphables) {
      if (!prop.modelFile) {
        missing.push(`${prop.id} (no modelFile set)`);
        continue;
      }
      const source = sceneByPath.get(prop.modelFile);
      if (!source) {
        missing.push(`${prop.id} -> ${prop.modelFile}`);
        continue;
      }
      let targetNode = source;
      if (prop.nodeName) {
        const subNode = source.getObjectByName(prop.nodeName);
        if (subNode) {
          targetNode = subNode;
        }
      }
      lookup.set(prop.id, targetNode.clone());
    }

    if (missing.length > 0) {
      console.error(
        `[map:${manifest.id}] morphables referencing missing/unset modelFile:\n` +
          missing.join(', ')
      );
    }

    return lookup;
  }, [manifest, sceneByPath]);

  if (!registered.current && morphMeshes.size > 0) {
    registered.current = true;
    onReady?.(morphMeshes);
  }

  return (
    <>
      {/* Render the authored full-scene GLB first so it's the visual backdrop */}
      {sceneGltf?.scene && <primitive object={sceneGltf.scene} />}
      <hemisphereLight args={[0xffffff, 0x444444, 0.9]} />
      <ambientLight intensity={1.0} />

      {/* Floor: instanced, since a 34x24m room at 1m tiles is 800+
          individual tiles — one InstancedMesh sharing the floor's
          geometry/material is dramatically cheaper than 800 separate
          draw calls from cloning the GLTF scene that many times. */}
      <InstancedProps items={manifest.floorTiles ?? []} sceneByPath={sceneByPath} />
      <InstancedProps items={manifest.ceilingTiles ?? []} sceneByPath={sceneByPath} />

      {/* Walls: also commonly repeated (same wall.glb stacked/placed many
          times around the perimeter) — same instancing treatment. */}
      <InstancedProps items={manifest.walls ?? []} sceneByPath={sceneByPath} />

      {/* Scene dressing (columns, displays, checkout counter, etc) —
          lower count, cloned individually rather than instanced since
          these are visually distinct enough that batching by modelFile
          alone is less valuable here. */}
      {(manifest.sceneDressing ?? []).map((item, i) => {
        const source = sceneByPath.get(item.modelFile);
        if (!source) return null;
        return (
          <ClonedGltf
            key={`dressing-${i}`}
            source={source}
            position={item.position}
            rotationY={item.rotationY}
            scale={item.scale}
            autoCenterXZ={item.autoCenterXZ}
            autoFloorY={item.autoFloorY}
          />
        );
      })}

      {/* The morphable props themselves, rendered as static world
       * objects so hiders have something real to walk up to and morph
       * into in the first place. This was missing entirely in
       * real-asset mode — only the morph-target CLONE lookup (above,
       * morphMeshes) existed, with nothing placing the originals in
       * the world. Placeholder mode never had this gap since
       * PlaceholderSceneContents always rendered both from one loop.
       *
       * IMPORTANT: any instance currently occupied by a morphed hider
       * is skipped here — otherwise you'd see the real static prop
       * AND the morphed player's clone of that same prop stacked in
       * the exact same spot the moment someone morphs into it, which
       * both looks wrong (z-fighting) and breaks the "blend into a
       * crowd of real ones" illusion this mechanic depends on. */}
      {manifest.morphables.map((prop) => {
        // By default we hide the static original at an instance when
        // some OTHER player has morphed into it to avoid z-fighting
        // (the morphed player's clone would otherwise be rendered
        // stacked exactly on top). However seekers should still be
        // able to see the originals for clarity during play/testing;
        // only skip rendering the static original for non-seekers.
        if (occupiedMorphIds?.has(prop.id) && role !== 'seeker') return null;
        if (!prop.modelFile) return null;
        const source = sceneByPath.get(prop.modelFile);
        if (!source) return null;
        return (
          <ClonedGltf
            key={prop.id}
            source={source}
            nodeName={prop.nodeName}
            position={prop.position}
            rotationY={prop.rotationY}
            scale={prop.scale}
            autoCenterXZ={prop.autoCenterXZ}
            autoFloorY={prop.autoFloorY}
          />
        );
      })}

      <SelfPlayerThirdPerson
        selfPlayer={selfPlayer}
        role={role}
        morphables={manifest.morphables}
        sceneByPath={sceneByPath}
        thirdPerson={thirdPerson}
        lastShotTimes={lastShotTimes}
        playerPositionRef={playerPositionRef}
      />
      <RealAssetOtherPlayers
        players={otherPlayers}
        morphables={manifest.morphables}
        sceneByPath={sceneByPath}
        role={role}
        lastShotTimes={lastShotTimes}
      />
    </>
  );
}

/** Real-asset-mode version of other-player rendering: an unmorphed
 * player now renders as an animated seeker/hider model, while a MORPHED
 * player still renders the ACTUAL cloned prop model from sceneByPath.
 * This replaces the placeholder capsule fallback with the character
 * asset pack. */
function RealAssetOtherPlayers({
  players,
  morphables,
  sceneByPath,
  role,
  lastShotTimes,
}: {
  players: PlayerRow[];
  morphables: MorphableProp[];
  sceneByPath: Map<string, THREE.Object3D>;
  role: PlayerRole;
  lastShotTimes: Record<string, number>;
}) {
  return (
    <group>
      {players.map((p) => {
        if (p.morphed_into) {
          const prop = morphables.find((m) => m.id === p.morphed_into);
          if (prop?.modelFile) {
            const source = sceneByPath.get(prop.modelFile);
            if (source) {
              return (
                <MorphedRealProp
                  key={p.id}
                  playerId={p.id}
                  source={source}
                  nodeName={prop.nodeName}
                  position={[p.pos_x, heightAboveGroundFromPosY(p.pos_y), p.pos_z]}
                  rotationY={(p.rot_y * 180) / Math.PI}
                  scale={prop.scale}
                  stackCount={prop.stackCount}
                  stackSegmentHeight={prop.stackSegmentHeight}
                  autoCenterXZ={prop.autoCenterXZ ?? false}
                  autoFloorY={prop.autoFloorY ?? false}
                  viewerRole={role}
                />
              );
            }
          }
        }

        if (p.role) {
          return (
            <PlayerCharacter
              key={p.id}
              playerId={p.id}
              role={p.role}
              position={[p.pos_x, heightAboveGroundFromPosY(p.pos_y), p.pos_z]}
              rotationY={p.rot_y}
              scale={[0.75, 0.75, 0.75]}
              hp={p.hp}
              lastShotTime={lastShotTimes[p.id] ?? 0}
              morphables={morphables}
            />
          );
        }

        return (
          <mesh
            key={p.id}
            position={[p.pos_x, CAPSULE_GROUND_Y + heightAboveGroundFromPosY(p.pos_y), p.pos_z]}
            rotation={[0, p.rot_y, 0]}
            castShadow
            userData={{ playerId: p.id }}
          >
            <capsuleGeometry args={[0.3, 1.2, 4, 8]} />
            <meshStandardMaterial color="#666666" />
          </mesh>
        );
      })}
    </group>
  );
}

/** One morphed player's real-asset disguise: a clone of the actual prop
 * model (not a placeholder shape), positioned at the player's LIVE
 * synced position — same "moves freely, isn't welded to the original
 * prop's spot" behavior as the placeholder version, just with the real
 * mesh instead of a colored cylinder. Tagged with userData.playerId so
 * the shooting raycaster can identify and damage the correct player. */
function MorphedRealProp({
  playerId,
  source,
  nodeName,
  position,
  rotationY,
  scale,
  stackCount = 1,
  stackSegmentHeight = 0,
  autoCenterXZ = false,
  autoFloorY = false,
  viewerRole,
}: {
  playerId: string;
  source: THREE.Object3D;
  nodeName?: string;
  position: [number, number, number];
  rotationY: number;
  scale: [number, number, number];
  stackCount?: number;
  stackSegmentHeight?: number;
  autoCenterXZ?: boolean;
  autoFloorY?: boolean;
  viewerRole: PlayerRole;
}) {
  // One independent clone per stacked segment — cloning the same source
  // N times rather than reusing one clone N times, since each needs its
  // own transform/position in the scene graph (sharing one Object3D
  // instance across multiple <primitive> placements isn't how R3F/Three
  // works — each placement needs a distinct object).
  const clones = useMemo(() => {
    const result: THREE.Object3D[] = [];
    for (let i = 0; i < stackCount; i++) {
      let targetNode = source;
      if (nodeName) {
        const subNode = source.getObjectByName(nodeName);
        if (subNode) {
          targetNode = subNode;
        }
      }
      const clone = targetNode.clone();
      // Defensive: explicitly zero out the clone's own local transform
      // before applying any auto-centering. This ensures the clone's
      // rendered geometry is positioned relative to the player's world
      // position instead of an arbitrary imported origin.
      clone.position.set(0, 0, 0);
      clone.rotation.set(0, 0, 0);
      clone.scale.set(1, 1, 1);
      clone.updateMatrix();

      const box = new THREE.Box3().setFromObject(clone);
      const center = box.getCenter(new THREE.Vector3());
      if (autoCenterXZ || Math.abs(center.x) > 1e-4 || Math.abs(center.z) > 1e-4) {
        clone.position.x -= center.x;
        clone.position.z -= center.z;
      }
      if (autoFloorY || Math.abs(box.min.y) > 1e-4) {
        clone.position.y -= box.min.y;
      }
      clone.updateMatrix();

      clone.traverse((child) => {
        child.userData.playerId = playerId;
        if (child instanceof THREE.Mesh) {
          child.frustumCulled = false;
          // If the CURRENT viewer is a seeker, force certain material
          // properties so the morphed disguise is visible even if the
          // original asset's material/shader behaves oddly in the
          // seeker's camera (lighting, transparency, or depth issues).
          if (viewerRole === 'seeker' && child.material) {
            try {
              (child.material as THREE.Material & { side?: number }).side = THREE.DoubleSide;
              // ensure the material is active and updated
              (child.material as any).transparent = false;
              (child.material as any).opacity = 1;
              (child.material as any).needsUpdate = true;
            } catch (e) {
              // ignore material patch errors
            }
          }
        }
        // Defensive: ensure nothing accidentally left the clone or its
        // children hidden via `visible = false` from another codepath.
        child.visible = true;
      });

      // Ensure world matrices are up-to-date so any later Box3 or
      // world-space queries reflect the true transformed position of
      // this clone when it's inserted under a parent group at the
      // player's synced world position. Some GLTFs have nested
      // transforms that require updateMatrixWorld to be correct.
      clone.updateMatrixWorld(true);

      result.push(clone);
    }
    return result;
  }, [source, playerId, stackCount, autoCenterXZ, autoFloorY, viewerRole]);

  // Log the incoming player-synced position so we can compare it
  // against the manifest prop's fixed position when diagnosing the
  // mismatch between what the local hider sees and what other clients
  // render. The RealAssetOtherPlayers caller also logs prop.manifest
  // positions — compare these two to see if the database-synced
  // player position differs from the manifest instance's coordinates.
  console.log('[morphed-prop:render] player', playerId, 'renderPosition', position, 'pivotCentering', { autoCenterXZ, autoFloorY });

  const ref = useRef<THREE.Group>(null);
  const targetPositionRef = useRef<[number, number, number]>(position);
  const targetRotationYRadRef = useRef<number>((rotationY * Math.PI) / 180);

  useEffect(() => {
    targetPositionRef.current = position;
  }, [position]);

  useEffect(() => {
    targetRotationYRadRef.current = (rotationY * Math.PI) / 180;
  }, [rotationY]);

  // Set initial position/rotation directly on mount
  useEffect(() => {
    if (ref.current) {
      ref.current.position.set(...position);
      ref.current.rotation.set(0, (rotationY * Math.PI) / 180, 0);
    }
  }, []);

  useFrame((_, delta) => {
    if (!ref.current) return;
    const t = 1 - Math.exp(-15 * delta); // frame-rate independent interpolation weight
    
    // Smooth position lerp
    const currentPos = ref.current.position;
    const targetPos = targetPositionRef.current;
    currentPos.x = THREE.MathUtils.lerp(currentPos.x, targetPos[0], t);
    currentPos.y = THREE.MathUtils.lerp(currentPos.y, targetPos[1], t);
    currentPos.z = THREE.MathUtils.lerp(currentPos.z, targetPos[2], t);
    
    // Smooth rotation angle lerp (handles wrap-around correctly)
    let diff = targetRotationYRadRef.current - ref.current.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    ref.current.rotation.y += diff * t;
  });

  return (
    <group ref={ref} scale={scale}>
      {clones.map((clone, i) => {
        try {
          // Ensure clone world matrices are current before computing bbox
          clone.updateMatrixWorld(true);
          let meshCount = 0;
          clone.traverse((c) => { if (c instanceof THREE.Mesh) meshCount++; });
          const box = new THREE.Box3().setFromObject(clone);
          const size = box.getSize(new THREE.Vector3());
          console.debug('[morphed-prop] player', playerId, 'clone', i, 'meshes', meshCount, 'bboxSize', size.toArray());
        } catch (e) {
          console.debug('[morphed-prop] error inspecting clone', e);
        }
        return (
          <group key={i} position={[0, i * stackSegmentHeight, 0]}>
            <primitive object={clone} />
          </group>
        );
      })}
    </group>
  );
}

function SelfPlayerThirdPerson({
  selfPlayer,
  role,
  morphables,
  sceneByPath,
  thirdPerson,
  lastShotTimes,
  playerPositionRef,
}: {
  selfPlayer?: PlayerRow | null;
  role: PlayerRole;
  morphables: MorphableProp[];
  sceneByPath?: Map<string, THREE.Object3D>;
  thirdPerson: boolean;
  lastShotTimes: Record<string, number>;
  playerPositionRef: MutableRefObject<THREE.Vector3>;
}) {
  if (!thirdPerson || !selfPlayer) return null;

  const localY = playerPositionRef.current.y;
  const position: [number, number, number] = [
    playerPositionRef.current.x,
    heightAboveGroundFromPosY(localY),
    playerPositionRef.current.z,
  ];

  // This mesh only exists in the scene while thirdPerson is true (it's
  // the player's OWN visual body, drawn so they can see themselves).
  // FirstPersonController's ground raycast fires straight down from
  // directly above this same x/z through the whole scene — without this
  // tag it hits this very mesh (torso/head, well above the real floor),
  // which the controller then treats as ground and snaps the player up
  // onto. That inflates position.y, which redraws this mesh even
  // higher, which the next frame's ray hits again — a runaway feedback
  // loop that only manifests in 3rd person (in 1st person this mesh
  // isn't rendered at all, so the ray never self-intersects). Tagging
  // the group lets the raycast skip it while leaving every other piece
  // of scene geometry (real ground, props, other players) untouched.
  const selfMeshUserData = { excludeFromGroundRay: true };

  if (selfPlayer.morphed_into) {
    const prop = morphables.find((m) => m.id === selfPlayer.morphed_into);
    if (prop?.modelFile && sceneByPath) {
      const source = sceneByPath.get(prop.modelFile);
      if (source) {
        return (
          <group userData={selfMeshUserData}>
            <MorphedRealProp
              playerId={selfPlayer.id}
              source={source}
              nodeName={prop.nodeName}
              position={position}
              rotationY={(selfPlayer.rot_y * 180) / Math.PI}
              scale={prop.scale}
              stackCount={prop.stackCount}
              stackSegmentHeight={prop.stackSegmentHeight}
              autoCenterXZ={prop.autoCenterXZ ?? false}
              autoFloorY={prop.autoFloorY ?? false}
              viewerRole={role}
            />
          </group>
        );
      }
    }

    const fallbackRadius = prop?.footprint.radius ?? 0.3;
    const fallbackHeight = prop?.footprint.height ?? 1.2;
    const fallbackColor = prop ? colorForGroup(prop.groupId) : '#3366cc';

    return (
      <mesh
        userData={selfMeshUserData}
        position={[position[0], position[1] + fallbackHeight / 2, position[2]]}
        rotation={[0, selfPlayer.rot_y, 0]}
        castShadow
      >
        <cylinderGeometry args={[fallbackRadius, fallbackRadius, fallbackHeight, 8]} />
        <meshStandardMaterial color={fallbackColor} />
      </mesh>
    );
  }

  return (
    <group userData={selfMeshUserData}>
      <PlayerCharacter
        playerId={selfPlayer.id}
        role={role}
        position={position}
        rotationY={selfPlayer.rot_y}
        scale={[0.75, 0.75, 0.75]}
        hp={selfPlayer.hp}
        lastShotTime={lastShotTimes[selfPlayer.id] ?? 0}
        morphables={morphables}
      />
    </group>
  );
}

function ThirdPersonCamera({ selfPlayer, enabled, maxCameraY }: { selfPlayer?: PlayerRow | null; enabled: boolean; maxCameraY?: number }) {
  const { camera } = useThree();
  const lastPosition = useRef(new THREE.Vector3());
  const lastPlayerY = useRef<number | null>(null);
  const lastPlayerXZ = useRef(new THREE.Vector2());

  useFrame(() => {
    if (!enabled || !selfPlayer) return;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.normalize();

    const distance = 4.0;
    const height = 1.6;
    const desiredPosition = new THREE.Vector3(
      selfPlayer.pos_x - forward.x * distance,
      selfPlayer.pos_y + height,
      selfPlayer.pos_z - forward.z * distance
    );

    // Prevent third-person camera from shooting off to the sky by clamping
    // to the map's maximum Y bound (with a small safety margin).
    const maxY = typeof maxCameraY === 'number' ? maxCameraY + 5 : 200;

    // Defensive guard: if the player's reported Y jumps upward while
    // their horizontal position hasn't changed meaningfully (standing
    // still), ignore the sudden increase and keep the camera near the
    // last known safe player Y. This prevents a small runaway feedback
    // loop that was pulling stationary players into the sky.
    const prevY = lastPlayerY.current ?? selfPlayer.pos_y;
    const prevXZ = lastPlayerXZ.current ?? new THREE.Vector2(selfPlayer.pos_x, selfPlayer.pos_z);
    const dxz = Math.hypot(selfPlayer.pos_x - prevXZ.x, selfPlayer.pos_z - prevXZ.y);
    const dy = selfPlayer.pos_y - (prevY ?? selfPlayer.pos_y);

    if (dy > 0.5 && dxz < 0.2) {
      // Sudden upward movement while stationary -> ignore large jump.
      console.warn('[ThirdPersonCamera] suppressed sudden upward pos for', selfPlayer.id, prevY, '->', selfPlayer.pos_y);
      desiredPosition.y = (prevY ?? selfPlayer.pos_y) + 0.1 + height;
    } else {
      if (desiredPosition.y > maxY) desiredPosition.y = maxY;
      lastPlayerY.current = selfPlayer.pos_y;
      lastPlayerXZ.current.set(selfPlayer.pos_x, selfPlayer.pos_z);
    }

    lastPosition.current.lerp(desiredPosition, 0.15);
    camera.position.copy(lastPosition.current);
  });

  return null;
}

/** Renders many copies of a small set of distinct models via
 * InstancedMesh, grouped by modelFile so each group shares one
 * geometry/material and renders in a single draw call regardless of
 * instance count. Necessary for floor tiles (800+ instances) and long
 * wall runs to stay performant — cloning the GLTF scene per-instance
 * the naive way would otherwise create one drawcall per tile. */
function InstancedProps({
  items,
  sceneByPath,
}: {
  items: { modelFile: string; position: [number, number, number]; rotationY: number; scale?: [number, number, number] }[];
  sceneByPath: Map<string, THREE.Object3D>;
}) {
  const groups = useMemo(() => {
    const byPath = new Map<string, typeof items>();
    for (const item of items) {
      const list = byPath.get(item.modelFile) ?? [];
      list.push(item);
      byPath.set(item.modelFile, list);
    }
    return byPath;
  }, [items]);

  return (
    <>
      {Array.from(groups.entries()).map(([path, instances]) => {
        const source = sceneByPath.get(path);
        if (!source) return null;

        // Pull the first mesh found in the source scene to get its
        // geometry/material for instancing. Kenney's per-object files
        // are single-mesh scenes (verified directly against the binary
        // GLB data while building this), so taking the first mesh
        // found is safe here — multi-mesh source files would need a
        // different approach (one InstancedMesh per sub-mesh).
        let geometry: THREE.BufferGeometry | null = null;
        let material: THREE.Material | THREE.Material[] | null = null;
        source.traverse((child) => {
          if (!geometry && child instanceof THREE.Mesh) {
            geometry = child.geometry;
            material = child.material;
          }
        });
        if (!geometry || !material) return null;

        return (
          <InstancedGroup
            key={path}
            geometry={geometry}
            material={material}
            instances={instances}
          />
        );
      })}
    </>
  );
}

function InstancedGroup({
  geometry,
  material,
  instances,
}: {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  instances: { position: [number, number, number]; rotationY: number; scale?: [number, number, number] }[];
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();

    instances.forEach((inst, i) => {
      euler.set(0, (inst.rotationY * Math.PI) / 180, 0);
      quaternion.setFromEuler(euler);
      const scale = inst.scale ?? [1, 1, 1];
      matrix.compose(
        new THREE.Vector3(...inst.position),
        quaternion,
        new THREE.Vector3(...scale)
      );
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;

    // CRITICAL: InstancedMesh's default bounding sphere/box is computed
    // from the base geometry alone — effectively a tiny sphere near the
    // origin, since it has no idea instances are about to be scattered
    // across positions far from there. Without recomputing AFTER setting
    // every instance's matrix, Three.js's frustum culling thinks this
    // entire mesh (all 800+ floor tiles, or all 232 wall segments) only
    // "exists" near the origin and culls the whole thing the moment the
    // camera's view frustum doesn't happen to include that tiny origin
    // sphere — producing exactly the "floor/walls disappear depending on
    // where I look, come back when I move" symptom this was causing.
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
  }, [instances]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, Array.isArray(material) ? material[0] : material, instances.length]}
      castShadow
      receiveShadow
    />
  );
}

/** Single cloned copy of a loaded GLTF scene, positioned/rotated/scaled
 * per a manifest entry. Used for scene-dressing items where instancing
 * isn't worth the complexity (lower counts, more visual variety). */
function ClonedGltf({
  source,
  position,
  rotationY,
  scale,
  autoCenterXZ = false,
  autoFloorY = false,
  nodeName,
}: {
  source: THREE.Object3D;
  position: [number, number, number];
  rotationY: number;
  scale: [number, number, number];
  /** Some imported models (notably Sketchfab exports with unusual nested
   * transforms) have their actual mesh geometry sitting far from the
   * node's own local origin — sometimes 10+ units away — because of
   * baked-in transform chains that are impractical to reverse-engineer
   * by hand from raw accessor data (confirmed the hard way: got this
   * wrong once already for a model whose Sketchfab root rotation swaps
   * which raw axis ends up vertical). When true, this measures the
   * CLONE's actual rendered bounding box after cloning and shifts it so
   * the box's horizontal (X/Z) center lands at the local origin —
   * meaning `position` then correctly places the visual center of the
   * model, regardless of whatever offset was baked into the source. */
  autoCenterXZ?: boolean;
  /** Same idea as autoCenterXZ but for the vertical axis — shifts the
   * clone so its lowest point sits at local y=0 (the floor), instead of
   * trusting a manually-computed offset. */
  autoFloorY?: boolean;
  nodeName?: string;
}) {
  const cloned = useMemo(() => {
    let targetNode = source;
    if (nodeName) {
      const subNode = source.getObjectByName(nodeName);
      if (subNode) {
        targetNode = subNode;
      }
    }
    const clone = targetNode.clone();
    if (autoCenterXZ || autoFloorY) {
      const box = new THREE.Box3().setFromObject(clone);
      const center = box.getCenter(new THREE.Vector3());
      if (autoCenterXZ) {
        clone.position.x -= center.x;
        clone.position.z -= center.z;
      }
      if (autoFloorY) {
        clone.position.y -= box.min.y;
      }
      clone.updateMatrix();
    }
    // Prevent accidental frustum-based disappearance for complex
    // imported GLTFs by ensuring every mesh in the clone is not
    // frustum-culled. Some shared-cache bounding behavior can cause
    // an object to be visible in one camera but invisible in another.
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) child.frustumCulled = false;
    });
    return clone;
  }, [source, autoCenterXZ, autoFloorY, nodeName]);

  // IMPORTANT: the auto-center/auto-floor offset above is baked into
  // `cloned`'s own .position — but <primitive position={position}>
  // would ALSO try to drive that exact same .position property via
  // R3F's prop reconciliation, silently overwriting the offset on
  // re-render (R3F sets object3D properties directly from JSX props,
  // and two different code paths writing to the same .position field
  // conflict). Fix: wrap in an outer <group> that owns the `position`
  // prop, with the offset-bearing clone nested inside as a child —
  // the two no longer touch the same property, so both survive.
  return (
    <group position={position} rotation={[0, (rotationY * Math.PI) / 180, 0]} scale={scale}>
      <primitive object={cloned} />
    </group>
  );
}

// Stable color per groupId so every instance in a group looks identical —
// this is the whole point of the morph mechanic (blend into a crowd of
// matching props). Hash the string to a hue rather than hand-listing
// every groupId, so new maps/groups get a color automatically.
 

function colorForGroup(groupId: string): string {
  let hash = 0;
  for (let i = 0; i < groupId.length; i++) {
    hash = (hash * 31 + groupId.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 55%, 50%)`;
}

type SceneContentsProps = {
  manifest: MapManifest;
  onReady?: (morphMeshes: Map<string, THREE.Object3D>) => void;
  onSceneReady?: (planes: FloorPlane[]) => void;
  otherPlayers: PlayerRow[];
  role: PlayerRole;
  selfPlayer?: PlayerRow | null;
  thirdPerson: boolean;
  playerPositionRef: MutableRefObject<THREE.Vector3>;
  lastShotTimes?: Record<string, number>;
};

type GltfSceneContentsProps = Omit<SceneContentsProps, 'playerPositionRef'> & {
  playerPositionRef: MutableRefObject<THREE.Vector3>;
};

type PlaceholderSceneContentsProps = Omit<SceneContentsProps, 'playerPositionRef'> & {
  playerPositionRef: MutableRefObject<THREE.Vector3>;
};

function PlaceholderSceneContents(props: PlaceholderSceneContentsProps) {
  const {
    manifest,
    onReady,
    onSceneReady,
    otherPlayers,
    selfPlayer,
    thirdPerson,
    playerPositionRef,
    role,
    lastShotTimes = {},
  } = props;
  const registered = useRef(false);
  const groupRef = useRef<THREE.Group>(null);

  // Build real Object3D boxes/cylinders directly (not JSX) so the
  // resulting lookup is identical in shape to what GltfSceneContents
  // produces — onReady's contract (id -> Object3D) doesn't change
  // depending on which rendering path is active.
  const morphMeshes = useMemo(() => {
    const lookup = new Map<string, THREE.Object3D>();
    for (const prop of manifest.morphables) {
      const geometry = new THREE.CylinderGeometry(
        prop.footprint.radius,
        prop.footprint.radius,
        prop.footprint.height,
        8
      );
      const material = new THREE.MeshStandardMaterial({ color: colorForGroup(prop.groupId) });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = prop.nodeName;
      mesh.position.set(...prop.position);
      mesh.rotation.y = (prop.rotationY * Math.PI) / 180;
      mesh.scale.set(...prop.scale);
      lookup.set(prop.id, mesh);
    }
    return lookup;
  }, [manifest]);

  if (!registered.current && morphMeshes.size > 0) {
    registered.current = true;
    onReady?.(morphMeshes);
  }

  // Placeholder scene has no authored floors beyond the ground, so
  // inform the parent that there are no extra scene-derived planes.
  useEffect(() => {
    onSceneReady?.([]);
  }, [onSceneReady]);

  const floorWidth = manifest.bounds.max[0] - manifest.bounds.min[0];
  const floorDepth = manifest.bounds.max[2] - manifest.bounds.min[2];
  const floorCenterX = (manifest.bounds.max[0] + manifest.bounds.min[0]) / 2;
  const floorCenterZ = (manifest.bounds.max[2] + manifest.bounds.min[2]) / 2;

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 10, 5]} intensity={0.8} castShadow />

      {/* Floor, sized from manifest.bounds so it matches whatever map
          this is without hardcoding dimensions. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[floorCenterX, 0, floorCenterZ]} receiveShadow>
        <planeGeometry args={[floorWidth, floorDepth]} />
        <meshStandardMaterial color="#888" />
      </mesh>

      {/* Every morphable prop, rendered as a real box/cylinder placeholder
          colored by groupId. */}
      <group ref={groupRef}>
        {manifest.morphables.map((prop) => (
          <mesh
            key={prop.id}
            position={prop.position}
            rotation={[0, (prop.rotationY * Math.PI) / 180, 0]}
            scale={prop.scale}
            castShadow
          >
            <cylinderGeometry args={[prop.footprint.radius, prop.footprint.radius, prop.footprint.height, 8]} />
            <meshStandardMaterial color={colorForGroup(prop.groupId)} />
          </mesh>
        ))}

        {/* Decoys rendered as small green spheres — visually distinct
            from morphables so it's obvious during testing which is which. */}
        {manifest.decoys?.map((decoy, i) => (
          <mesh key={`decoy-${i}`} position={decoy.position}>
            <sphereGeometry args={[0.25, 8, 8]} />
            <meshStandardMaterial color="#2a6a3a" />
          </mesh>
        ))}
      </group>

      <SelfPlayerThirdPerson
        selfPlayer={selfPlayer}
        role={role}
        morphables={manifest.morphables}
        thirdPerson={thirdPerson}
        lastShotTimes={lastShotTimes}
        playerPositionRef={playerPositionRef}
      />
      <OtherPlayers players={otherPlayers} morphables={manifest.morphables} lastShotTimes={lastShotTimes} />
    </>
  );
}

/** Quick visual debug helper — renders wireframe boxes at every morphable
 * and spawn point from the manifest, useful before the real .glb exists
 * or to sanity-check manifest coordinates against the actual model. */
export function ManifestDebugOverlay({ manifest }: { manifest: MapManifest }) {
  return (
    <group>
      {manifest.morphables.map((p) => (
        <mesh key={p.id} position={p.position} rotation={[0, degToRad(p.rotationY), 0]}>
          <cylinderGeometry args={[p.footprint.radius, p.footprint.radius, p.footprint.height, 8]} />
          <meshBasicMaterial color="lime" wireframe />
        </mesh>
      ))}
      {manifest.spawns.hider.map((pos, i) => (
        <mesh key={`hider-spawn-${i}`} position={pos}>
          <sphereGeometry args={[0.2, 8, 8]} />
          <meshBasicMaterial color="cyan" />
        </mesh>
      ))}
      {manifest.spawns.seeker.map((pos, i) => (
        <mesh key={`seeker-spawn-${i}`} position={pos}>
          <sphereGeometry args={[0.2, 8, 8]} />
          <meshBasicMaterial color="red" />
        </mesh>
      ))}
    </group>
  );
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
