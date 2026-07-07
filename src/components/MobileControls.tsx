import { useEffect, useRef, useState } from 'react';

export interface MobileControlsProps {
  onMoveChange: (movement: { x: number; y: number }) => void;
  onLookChange: (value: number) => void;
  onJump: () => void;
  onSprintChange: (active: boolean) => void;
  onAction: () => void;
  actionLabel: string;
  showLandscapeHint: boolean;
  onEnsureLandscape?: () => void;
}

const JOYSTICK_RADIUS = 64;
const JOYSTICK_DEADZONE = 0.12;

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
    y: clampJoystickValue((dy / JOYSTICK_RADIUS) * normalized),
  };
}

function useJoystick(onChange: (value: { x: number; y: number }) => void) {
  const [value, setValue] = useState({ x: 0, y: 0 });
  const activePointer = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const targetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onChange(value);
  }, [onChange, value]);

  const reset = () => {
    setValue({ x: 0, y: 0 });
    activePointer.current = null;
  };

  const start = (pointerId: number, x: number, y: number, target: HTMLDivElement | null) => {
    activePointer.current = pointerId;
    origin.current = { x, y };
    targetRef.current = target;
  };

  const move = (pointerId: number, x: number, y: number) => {
    if (activePointer.current !== pointerId) return;
    const dx = x - origin.current.x;
    const dy = y - origin.current.y;
    setValue(normalizeJoystick(dx, dy));
  };

  return {
    value,
    reset,
    start,
    move,
    activePointer: activePointer.current,
    targetRef,
  };
}

export function MobileControls({
  onMoveChange,
  onLookChange,
  onJump,
  onSprintChange,
  onAction,
  actionLabel,
  showLandscapeHint,
  onEnsureLandscape,
}: MobileControlsProps) {
  const moveJoy = useJoystick(onMoveChange);
  const lookJoy = useJoystick(({ x }) => onLookChange(x));
  const [sprintActive, setSprintActive] = useState(false);

  useEffect(() => {
    onSprintChange(sprintActive);
  }, [onSprintChange, sprintActive]);

  const handleTouchStart = () => {
    try {
     onEnsureLandscape?.();
    } catch {
    // never let a landscape-lock failure break touch controls
   }
  };

  return (
    <div className="mobile-controls-overlay">
      {showLandscapeHint && (
        <div className="mobile-landscape-warning">
          Rotate your phone to landscape for the best experience.
        </div>
      )}
      <div className="mobile-controls-row">
        <div
          className="mobile-joystick-pad"
          onPointerDown={(e) => {
            // Register the joystick FIRST, before anything that could
            // throw (setPointerCapture rejecting a touch-type pointer on
            // some Android/WebView versions, or the landscape-lock call).
            // Previously these ran first and, if they threw, the
            // exception aborted the rest of this handler — moveJoy.start()
            // never ran, activePointer stayed null, and every subsequent
            // pointermove was ignored, which is exactly "joystick does
            // nothing." Movement now registers no matter what happens next.
            const target = e.currentTarget as HTMLDivElement;
            moveJoy.start(e.pointerId, e.clientX, e.clientY, target);
            try {
              target.setPointerCapture(e.pointerId);
            } catch {
              // Movement still works via normal hit-testing; we just lose
              // tracking if the finger slides off this 120px circle.
            }
            handleTouchStart();
          }}
          onPointerMove={(e) => moveJoy.move(e.pointerId, e.clientX, e.clientY)}
          onPointerUp={(e) => {
            if (moveJoy.activePointer === e.pointerId) {
              try {
                (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
              } catch {
                // no-op — nothing to release if capture never succeeded
              }
              moveJoy.reset();
            }
          }}
          onPointerCancel={() => moveJoy.reset()}
        >
          <div className="joystick-label">Move</div>
        </div>

        <div
          className="mobile-joystick-pad mobile-joystick-pad-right"
          onPointerDown={(e) => {
            const target = e.currentTarget as HTMLDivElement;
            lookJoy.start(e.pointerId, e.clientX, e.clientY, target);
            try {
              target.setPointerCapture(e.pointerId);
            } catch {
              // see Move pad above
            }
            handleTouchStart();
          }}
          onPointerMove={(e) => lookJoy.move(e.pointerId, e.clientX, e.clientY)}
          onPointerUp={(e) => {
            if (lookJoy.activePointer === e.pointerId) {
              try {
                (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
              } catch {
                // no-op
              }
              lookJoy.reset();
            }
          }}
          onPointerCancel={() => lookJoy.reset()}
        >
          <div className="joystick-label">Rotate</div>
        </div>
      </div>

      <div className="mobile-controls-actions">
        <button
          type="button"
          className="mobile-action-button"
          onPointerDown={() => {
            setSprintActive(true);
            handleTouchStart();
          }}
          onPointerUp={() => setSprintActive(false)}
          onPointerLeave={() => setSprintActive(false)}
        >
          Sprint
        </button>
        <button
          type="button"
          className="mobile-action-button"
          onPointerDown={() => {
            onJump();
            handleTouchStart();
          }}
        >
          Jump
        </button>
        <button
          type="button"
          className="mobile-action-button mobile-action-primary"
          onPointerDown={() => {
            onAction();
            handleTouchStart();
          }}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
