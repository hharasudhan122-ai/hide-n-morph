import { useRef, useState } from 'react';

export interface MobileControlsProps {
  onMoveChange: (movement: { x: number; y: number }) => void;
  /** Called with an incremental yaw delta (already sensitivity-scaled)
   *  every time the free-look layer registers finger movement. This
   *  replaces the old joystick-style "held value" look control — the
   *  caller (FirstPersonController, via a ref) just accumulates and
   *  drains these deltas once per frame. */
  onLookDelta: (deltaYaw: number) => void;
  onJump: () => void;
  onSprintChange: (active: boolean) => void;
  onAction: () => void;
  actionLabel: string;
  showLandscapeHint: boolean;
  onEnsureLandscape?: () => void;
}

const JOYSTICK_RADIUS = 64;
const JOYSTICK_DEADZONE = 0.12;
// Radians of camera turn per pixel of horizontal finger movement on the
// free-look layer. Tuned so a full landscape-width swipe (~800px) turns
// the camera a bit more than a full 360 — fast flicks feel responsive
// without being twitchy for small corrections.
const LOOK_SENSITIVITY = 0.0045;

function clampJoystickValue(value: number) {
  if (Math.abs(value) < JOYSTICK_DEADZONE) return 0;
  return Math.max(-1, Math.min(1, value));
}

function normalizeJoystick(dx: number, dy: number) {
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance < 1e-5) return { x: 0, y: 0 };
  const normalized = Math.min(distance, JOYSTICK_RADIUS) / JOYSTICK_RADIUS;
  return {
    x: clampJoystickValue((dx / JOYSTICK_RADIUS) * normalized),
    // Screen Y grows DOWNWARD, but pushing the stick UP (away from its
    // resting center) is what players expect to mean "walk forward" —
    // same as KeyW mapping to forward=+1 in FirstPersonController.
    // Negating dy here is what makes "push up = forward" instead of the
    // joystick feeling inverted/backwards.
    y: clampJoystickValue((-dy / JOYSTICK_RADIUS) * normalized),
  };
}

/**
 * Move joystick. Tracking is done via WINDOW-level pointermove/pointerup
 * listeners (added on pointerdown, removed on release) rather than
 * relying solely on the pad element's own onPointerMove + pointer
 * capture. Pointer capture isn't reliably honored for touch pointers on
 * every mobile browser, and once a drag exits the pad's small physical
 * bounds without capture working, the pad simply stops receiving move
 * events — which looks exactly like "the joystick doesn't work" the
 * moment someone pushes it past its own radius (which is normal, since
 * we clamp the OUTPUT to the radius regardless of how far the finger
 * actually travels). Listening on window sidesteps that entirely: we
 * filter by pointerId, so it doesn't matter what element is physically
 * under the finger once the drag has started.
 */
function useJoystick(onChange: (value: { x: number; y: number }) => void) {
  const [value, setValueState] = useState({ x: 0, y: 0 });
  const activePointer = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const cleanupRef = useRef<(() => void) | null>(null);

  const apply = (v: { x: number; y: number }) => {
    setValueState(v);
    onChange(v);
  };

  const end = () => {
    activePointer.current = null;
    cleanupRef.current?.();
    cleanupRef.current = null;
    apply({ x: 0, y: 0 });
  };

  const start = (pointerId: number, x: number, y: number) => {
    // Clean up any stale listener from a previous drag first.
    cleanupRef.current?.();
    activePointer.current = pointerId;
    origin.current = { x, y };

    const handleMove = (ev: PointerEvent) => {
      if (activePointer.current !== ev.pointerId) return;
      const dx = ev.clientX - origin.current.x;
      const dy = ev.clientY - origin.current.y;
      apply(normalizeJoystick(dx, dy));
    };
    const handleUp = (ev: PointerEvent) => {
      if (activePointer.current !== ev.pointerId) return;
      end();
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  };

  return { value, start, end };
}

/**
 * Free-look drag layer: an invisible full-screen surface. Touching down
 * anywhere on it and dragging rotates the camera by the horizontal
 * distance dragged (same "swipe anywhere to look around" scheme as
 * Free Fire / PUBG Mobile), rather than being confined to a small
 * joystick pad. Like the move joystick above, tracking uses
 * window-level listeners so the drag keeps working no matter how far
 * across the screen the finger travels.
 */
function useLookDrag(onDelta: (dx: number) => void) {
  const activePointer = useRef<number | null>(null);
  const lastX = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only track one look-finger at a time; ignore extra simultaneous
    // touches on this layer (e.g. a second finger tapping elsewhere).
    if (activePointer.current !== null) return;
    activePointer.current = e.pointerId;
    lastX.current = e.clientX;

    const handleMove = (ev: PointerEvent) => {
      if (activePointer.current !== ev.pointerId) return;
      const dx = ev.clientX - lastX.current;
      lastX.current = ev.clientX;
      if (dx !== 0) onDelta(dx * LOOK_SENSITIVITY);
    };
    const handleUp = (ev: PointerEvent) => {
      if (activePointer.current !== ev.pointerId) return;
      activePointer.current = null;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  };

  return onPointerDown;
}

export function MobileControls({
  onMoveChange,
  onLookDelta,
  onJump,
  onSprintChange,
  onAction,
  actionLabel,
  showLandscapeHint,
  onEnsureLandscape,
}: MobileControlsProps) {
  const moveJoy = useJoystick(onMoveChange);
  const [sprintActive, setSprintActive] = useState(false);

  const handleTouchStart = () => {
    try {
      onEnsureLandscape?.();
    } catch {
      // never let a landscape-lock failure break touch controls
    }
  };

  const handleLookPointerDown = useLookDrag(onLookDelta);

  const handleSprintDown = () => {
    handleTouchStart();
    setSprintActive(true);
    onSprintChange(true);
  };
  const handleSprintUp = () => {
    setSprintActive(false);
    onSprintChange(false);
  };

  return (
    <div className="mobile-controls-overlay">
      {showLandscapeHint && (
        <div className="mobile-landscape-warning">
          Rotate your phone to landscape for the best experience.
        </div>
      )}

      {/* Sits full-screen and BELOW the joystick/buttons in the DOM, so
         it's visually/hit-test "under" them — touches on the joystick
         or buttons are consumed by those elements first, while every
         other touch (the "empty screen") drags the camera around. */}
      <div
        className="mobile-look-layer"
        onPointerDown={(e) => {
          handleTouchStart();
          handleLookPointerDown(e);
        }}
      />

      <div className="mobile-controls-row">
        <div
          className="mobile-joystick-pad"
          onPointerDown={(e) => {
            handleTouchStart();
            moveJoy.start(e.pointerId, e.clientX, e.clientY);
          }}
        >
          <div className="joystick-label">Move</div>
        </div>
      </div>

      <div className="mobile-controls-actions">
        <button
          type="button"
          className={`mobile-action-button${sprintActive ? ' mobile-action-button-active' : ''}`}
          onPointerDown={handleSprintDown}
          onPointerUp={handleSprintUp}
          onPointerLeave={handleSprintUp}
          onPointerCancel={handleSprintUp}
        >
          Sprint
        </button>
        <button
          type="button"
          className="mobile-action-button"
          onPointerDown={() => {
            handleTouchStart();
            onJump();
          }}
        >
          Jump
        </button>
        <button
          type="button"
          className="mobile-action-button mobile-action-primary"
          onPointerDown={() => {
            handleTouchStart();
            onAction();
          }}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
