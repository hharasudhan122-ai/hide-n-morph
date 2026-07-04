// Types mirror manifest-schema.md and supabase/schema.sql exactly.
// Keep these three things in sync: this file, the .sql, and any manifest.json.

export type Vec3Tuple = [number, number, number];

export interface Footprint {
  radius: number;
  height: number;
}

export interface MorphableProp {
  id: string;          // unique instance id, e.g. "vending_01"
  nodeName: string;     // mesh/node name WITHIN modelFile (used for placeholder
                         // mode debugging/logging; in real-asset mode each
                         // modelFile is its own standalone scene)
  modelFile?: string;   // path (relative to the map folder) to this prop's
                         // own .glb, e.g. "models/freezer.glb". Real Kenney
                         // assets ship one file per object type rather than
                         // one shared scene.glb with named sub-nodes — this
                         // field reflects that. Omit when usePlaceholderGeometry
                         // is true (placeholder mode never reads this).
  /** Some real-world props (e.g. Kenney's modular columns) are visually
   * built from N copies of modelFile stacked vertically — the static
   * world version renders all N segments via separate walls/sceneDressing
   * entries, but a morphed disguise needs to reproduce the SAME visual
   * height or it becomes an instant tell (a half-height "column" standing
   * next to a full-height real one). When set >1, MorphedRealProp stacks
   * this many copies of modelFile, each offset by stackSegmentHeight,
   * instead of rendering just one. Omit/1 for normal single-piece props. */
  stackCount?: number;
  /** Vertical offset between stacked segments, in meters — should match
   * whatever offset the static world version uses between its own
   * stacked instances (e.g. column.glb segments are placed 1.0m apart
   * in walls/sceneDressing). Only meaningful when stackCount > 1. */
  stackSegmentHeight?: number;
  /** See ClonedGltf's autoCenterXZ/autoFloorY — set true for imported
   * models (e.g. Sketchfab) whose baked-in transform chain makes manual
   * offset calculation unreliable. Auto-measures the actual rendered
   * bounding box instead of trusting a hand-computed number. */
  autoCenterXZ?: boolean;
  autoFloorY?: boolean;
  groupId: string;      // props sharing a groupId look identical
  position: Vec3Tuple;
  rotationY: number;    // degrees
  scale: Vec3Tuple;
  footprint: Footprint;
}

export interface DecoyProp {
  nodeName: string;
  position: Vec3Tuple;
}

export interface MapBounds {
  min: Vec3Tuple;
  max: Vec3Tuple;
}

export interface MapSpawns {
  seeker: Vec3Tuple[];
  hider: Vec3Tuple[];
}

export interface SceneDressingItem {
  modelFile: string; // path relative to map folder, e.g. "models/column.glb"
  position: Vec3Tuple;
  rotationY: number;
  scale: Vec3Tuple;
  /** See MorphableProp's autoCenterXZ/autoFloorY — same purpose, applies
   * to static (non-morphable) dressing items like the checkout desk. */
  autoCenterXZ?: boolean;
  autoFloorY?: boolean;
}

export interface WallSegment {
  modelFile: string; // "models/wall.glb" | "models/wall-corner.glb" |
                       // "models/wall-door-rotate.glb" | "models/wall-window.glb"
  position: Vec3Tuple;
  rotationY: number;
}

export interface MapManifest {
  id: string;
  name: string;
  version: number;
  sceneFile: string;
  thumbnail: string;
  bounds: MapBounds;
  spawns: MapSpawns;
  morphables: MorphableProp[];
  decoys?: DecoyProp[];
  /** Static, non-morphable scene dressing — shelves, displays, checkout
   * counter, columns, etc. Purely visual, never targeted by shooting or
   * morph logic, but DOES still block movement visually (no collision
   * yet though — see FirstPersonController, still bounds-only). */
  sceneDressing?: SceneDressingItem[];
  /** The structural shell — floor tiles and wall segments assembled from
   * Kenney's modular wall/corner/door/window pieces. Each entry is one
   * placed instance; building a full rectangular room means placing
   * enough wall segments end-to-end to cover each side, with corners at
   * the four corners and a door segment at the entrance. */
  walls?: WallSegment[];
  floorTiles?: SceneDressingItem[];
  /** Ceiling surface — same tile-grid approach as floorTiles, positioned
   * at bounds.max[1]. Purely visual (no collision; the player's actual
   * height ceiling is just bounds.max[1] itself via camera clamping if
   * that's ever added — for now nothing stops a high jump from visually
   * clipping through, since normal jump height never gets close to a
   * 3m+ ceiling anyway). */
  ceilingTiles?: SceneDressingItem[];
  /** When true, the scene skips loading sceneFile as a real .glb and
   * instead builds a procedural box/cylinder approximation from this
   * same manifest data. Lets you build and test movement/morph/shoot
   * before a real 3D model exists. Flip to false (or omit) once
   * scene.glb is a real asset. */
  usePlaceholderGeometry?: boolean;
}

export interface MapsIndexEntry {
  id: string;
  name: string;
  thumbnail: string;
}

export interface MapsIndex {
  maps: MapsIndexEntry[];
}

// ---------------------------------------------------------------
// Supabase row types
// ---------------------------------------------------------------

export type RoomStatus = 'lobby' | 'countdown' | 'playing' | 'ended';
export type PlayerRole = 'seeker' | 'hider' | null;

export interface RoomRow {
  id: string;
  code: string;
  map_id: string;
  status: RoomStatus;
  host_id: string | null;
  round_seconds: number;
  round_started_at: string | null;
  last_outcome: 'hiders_win' | 'seekers_win' | null;
  created_at: string;
  updated_at: string;
}

export interface PlayerRow {
  id: string;
  room_id: string;
  display_name: string;
  role: PlayerRole;
  hp: number;
  is_alive: boolean;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  rot_y: number;
  morphed_into: string | null;
  is_host: boolean;
  last_seen_at: string;
  joined_at: string;
}

export interface ShotRow {
  id: string;
  room_id: string;
  shooter_id: string;
  target_id: string | null;
  hit: boolean;
  damage: number;
  shooter_pos: [number, number, number] | null;
  shooter_dir: [number, number, number] | null;
  created_at: string;
}

// Convenience runtime shape — players.tsx works with this, not raw rows
export interface PlayerState {
  id: string;
  displayName: string;
  role: PlayerRole;
  hp: number;
  isAlive: boolean;
  position: Vec3Tuple;
  rotationY: number;
  morphedInto: string | null;
  isHost: boolean;
  isSelf: boolean;
}
