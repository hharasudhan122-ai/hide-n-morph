import { useEffect, useRef, useState } from 'react';

export interface MobileControlsProps {
  onMoveChange: (movement: { x: number; y: number }) => void;
  /**
   * Called with incremental yaw/pitch deltas (already sensitivity-scaled)
   * every time the free-look layer registers finger movement. This is a
   * touchpad-style free-look: both axes are dragged simultaneously, like a
   * laptop trackpad or a mouse — not just a left/right swipe.
   * The caller (FirstPersonController, via a ref) accumulates and drains
   * these deltas once per frame.
   */
  onLookDelta: (deltaYaw: number, deltaPitch: number) => void;
  onJump: () => void;
  onSprintChange: (active: boolean) => void;
  onAction: () => void;
  actionLabel: string;
  showLandscapeHint: boolean;
  onEnsureLandscape?: () => void;
}

const JOYSTICK_RADIUS = 64;
const JOYSTICK_DEADZONE = 0.12;
// Radians of camera turn per pixel of finger movement on the free-look
// layer. Tuned so a full landscape-width swipe (~800px) turns the camera
// a bit more than a full 360 — fast flicks feel responsive without being
// twitchy for small corrections. Same sensitivity is used for both axes.
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
 * anywhere on it and dragging rotates the camera — BOTH horizontally
 * (yaw) and vertically (pitch), like a laptop trackpad/mouse — rather
 * than being confined to a small joystick pad or a single axis.
 *
 * Sign convention: dragging the finger RIGHT turns the view RIGHT, and
 * dragging UP tilts the view UP — matching how mouse-look works on
 * desktop. (Previously this only tracked dx and passed it through
 * un-negated, which produced the opposite of the intended turn — drag
 * left rotated the view right and vice versa. Both dx and dy are
 * negated below before scaling; flip either sign back if your
 * FirstPersonController's convention turns out to expect the opposite.)
 */
function useLookDrag(onDelta: (deltaYaw: number, deltaPitch: number) => void) {
  const activePointer = useRef<number | null>(null);
  const lastX = useRef(0);
  const lastY = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  const reset = () => {
    activePointer.current = null;
    cleanupRef.current?.();
    cleanupRef.current = null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only track one look-finger at a time; ignore extra simultaneous
    // touches on this layer (e.g. a second finger tapping elsewhere).
    if (activePointer.current !== null) return;
    activePointer.current = e.pointerId;
    lastX.current = e.clientX;
    lastY.current = e.clientY;

    const handleMove = (ev: PointerEvent) => {
      if (activePointer.current !== ev.pointerId) return;
      const dx = ev.clientX - lastX.current;
      const dy = ev.clientY - lastY.current;
      lastX.current = ev.clientX;
      lastY.current = ev.clientY;
      if (dx !== 0 || dy !== 0) {
        // Negated: drag right -> look right, drag up -> look up.
        onDelta(-dx * LOOK_SENSITIVITY, -dy * LOOK_SENSITIVITY);
      }
    };
    const handleUp = (ev: PointerEvent) => {
      if (activePointer.current !== ev.pointerId) return;
      reset();
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

  return { onPointerDown, reset };
}

// Inline style applied to every touch-draggable surface (look layer,
// joystick pad, buttons). touch-action: none is the actual fix for
// "vertical/diagonal drag doesn't work" — without it, the browser's
// default gesture handling (page scroll, iOS rubber-banding, Chrome
// pull-to-refresh) intercepts the vertical component of a drag before
// our pointermove listener ever sees it. Horizontal-only drags "work"
// today only because there's nothing to scroll sideways, so the
// browser has nothing to steal. overscrollBehavior is a second layer
// of the same fix specifically against pull-to-refresh/rubber-banding.
const NO_GESTURE_STYLE: React.CSSProperties = {
  touchAction: 'none',
  overscrollBehavior: 'none',
  WebkitUserSelect: 'none',
  userSelect: 'none',
  WebkitTouchCallout: 'none',
};

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
  const look = useLookDrag(onLookDelta);
  const [sprintActive, setSprintActive] = useState(false);
  // onEnsureLandscape only needs to run once — it used to fire on
  // EVERY joystick/look/button touch, which is what made the false
  // "rotate to landscape" warning reappear on essentially any tap
  // (including the morph/action button). See onEnsureLandscape in
  // MapScene.tsx for the actual state-correctness fix; this ref just
  // stops us from hammering the lock() call for no reason.
  const triedLandscapeLock = useRef(false);

  const handleTouchStart = () => {
    if (triedLandscapeLock.current) return;
    triedLandscapeLock.current = true;
    try {
      onEnsureLandscape?.();
    } catch {
      // never let a landscape-lock failure break touch controls
    }
  };

  // Safety net against "stuck" controls: if the tab is backgrounded mid-
  // touch (notification pull-down, app switch, screen lock, incoming
  // call, etc.) mobile browsers can silently drop the pointerup/
  // pointercancel event entirely. Without this, the joystick or look
  // drag latches onto its last value forever and never resets, because
  // nothing ever tells it the touch ended — which looks exactly like
  // "movement/rotation got stuck". Blur and visibilitychange fire
  // reliably in all of those cases, so we use them to force everything
  // back to a neutral, released state.
  useEffect(() => {
    const forceReset = () => {
      moveJoy.end();
      look.reset();
      setSprintActive(false);
      onSprintChange(false);
    };
    const handleVisibility = () => {
      if (document.hidden) forceReset();
    };
    window.addEventListener('blur', forceReset);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('blur', forceReset);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        // pointerEvents: 'none' means this banner can NEVER block a
        // touch underneath it, even in the (now-fixed) edge case where
        // it shows up incorrectly. Purely informational, never an
        // input blocker.
        <div className="mobile-landscape-warning" style={{ pointerEvents: 'none' }}>
          Rotate your phone to landscape for the best experience.
        </div>
      )}

      {/* Sits full-screen and BELOW the joystick/buttons in the DOM, so
         it's visually/hit-test "under" them — touches on the joystick
         or buttons are consumed by those elements first, while every
         other touch (the "empty screen") drags the camera around, in
         any direction, like a trackpad.
         style=NO_GESTURE_STYLE is the fix for "dragging up/down/diagonal
         doesn't look up/down" — without touch-action: none here, the
         browser intercepts the vertical component of the drag as a
         page-scroll/pull-to-refresh gesture before onPointerDown's
         window-level pointermove listener ever sees it. */}
      <div
        className="mobile-look-layer"
        style={NO_GESTURE_STYLE}
        onPointerDown={(e) => {
          handleTouchStart();
          look.onPointerDown(e);
        }}
      />

      <div className="mobile-controls-row">
        <div
          className="mobile-joystick-pad"
          style={NO_GESTURE_STYLE}
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
          style={NO_GESTURE_STYLE}
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
          style={NO_GESTURE_STYLE}
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
          style={NO_GESTURE_STYLE}
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
