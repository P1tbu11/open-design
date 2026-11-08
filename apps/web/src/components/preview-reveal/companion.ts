/**
 * The cursor that stays behind after the curtain.
 *
 * The build is over, but the page is not: one arrow keeps the swarm's own
 * physics and stays beside the pointer, so the agent that assembled the page is
 * still visibly watching it. It is the same body the reference sweeps across
 * the page — spring pull, force-limited integration, velocity-facing rotation —
 * with a single cursor instead of a flock.
 *
 * Everything here is the reference's feel, not a new invention:
 *
 * - Rest sits just outside the pointer's `PRESS_RING`, so a mouse move toward
 *   the arrow really does hit it. That is what makes the knock and the return
 *   an event rather than an animation on a timer.
 * - The knock and the bounce are `pressBody` from `press.ts`, the reference's
 *   verbatim collision, shared with the flock so the two can never feel like
 *   different animals. The pointer velocity handed to it is the *live* reading
 *   (`PointerTrack` from the host), not a private copy: the reference's bounce
 *   is relative to the pointer's own motion, and with a still track that term
 *   silently becomes a flat shove.
 * - Rotation follows speed with the reference's facing offset and decays toward
 *   upright once it is slow, exactly like a cursor that has stopped travelling.
 */

import { PRESS_DECAY, pressBody, type PressBody, type PressPoint, type PressTrack } from './press';
import { REVEAL_FACING_OFFSET, REVEAL_PRESS_SCALE } from './swarm';

/**
 * Resting offset from the pointer, in stage pixels. Its length (52) has to
 * clear the 48px ring, or the arrow would start inside the keep-out and be
 * shoved the instant it appears.
 */
export const COMPANION_REST = { x: 34, y: 40 };

/** Within the reference's "fast cursor" range: 1000..1500 speed, 3500..6000 force. */
const MAX_SPEED = 1000;
const MAX_FORCE = 3600;
const ACCEL = 6;

/** Breathing, so a settled cursor is never perfectly still. */
const BREATH_MS = 2400;
const BREATH_PX = 3;
const SWAY_MS = 3600;
const SWAY_DEG = 3.5;
/** Below this speed the arrow is considered parked and turns upright. */
const REST_SPEED = 30;

const EDGE = 14;

export interface CompanionState extends PressBody {
  angle: number;
  /** 0..1 flinch, decays at the reference's rate. */
  press: number;
  /** True while the pointer is inside the keep-out ring, so a knock fires once. */
  touching: boolean;
}

export interface CompanionFrame {
  x: number;
  y: number;
  angle: number;
  scale: number;
  /** True on the rising edge: the pointer just ran into it. */
  knocked: boolean;
}

export interface CompanionInput {
  state: CompanionState;
  /** The shared pointer reading; supplies the relative velocity the bounce needs. */
  track: PressTrack;
  dt: number;
  /** Milliseconds since mount; drives breathing only, never position. */
  time: number;
  /** Pointer in stage space, or null when it has left the preview. */
  pointer: PressPoint | null;
  bounds: { width: number; height: number };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function createCompanion(pointer: PressPoint | null, bounds: { width: number; height: number }): CompanionState {
  const origin = pointer ?? { x: bounds.width / 2, y: bounds.height / 2 };
  return {
    x: origin.x + COMPANION_REST.x,
    y: origin.y + COMPANION_REST.y,
    vx: 0,
    vy: 0,
    angle: 0,
    press: 0,
    touching: false,
  };
}

/** Fling it away from `away`, so it settles back in front of the user. */
export function nudgeCompanion(state: CompanionState, away: PressPoint | null): boolean {
  if (!away) return false;
  const dx = state.x - away.x;
  const dy = state.y - away.y;
  const distance = Math.hypot(dx, dy) || 0.01;
  state.vx += (dx / distance) * 640;
  state.vy += (dy / distance) * 640;
  state.press = 1;
  return true;
}

/**
 * Advance one frame. `time` drives only the idle breath, so a paused tab comes
 * back with a settled cursor rather than a teleporting one.
 */
export function stepCompanion(input: CompanionInput): CompanionFrame {
  const { state, bounds, track } = input;
  const dt = Math.min(0.05, Math.max(0, input.dt));
  let knocked = false;
  if (dt > 0) {
    const pointer = input.pointer;
    const base = pointer ?? { x: state.x - COMPANION_REST.x, y: state.y - COMPANION_REST.y };
    const breath = Math.sin((input.time / BREATH_MS) * Math.PI * 2) * BREATH_PX;
    const restX = base.x + COMPANION_REST.x;
    const restY = base.y + COMPANION_REST.y + breath;

    // Spring toward rest, then integrate through the reference's speed and
    // force ceilings. The force ceiling is what lets a knock outrun the spring
    // for a few frames and still be caught again.
    let desiredX = (restX - state.x) * ACCEL;
    let desiredY = (restY - state.y) * ACCEL;
    const desiredLength = Math.hypot(desiredX, desiredY);
    if (desiredLength > MAX_SPEED) {
      desiredX *= MAX_SPEED / desiredLength;
      desiredY *= MAX_SPEED / desiredLength;
    }
    let ax = (desiredX - state.vx) * ACCEL;
    let ay = (desiredY - state.vy) * ACCEL;
    const acceleration = Math.hypot(ax, ay);
    if (acceleration > MAX_FORCE) {
      ax *= MAX_FORCE / acceleration;
      ay *= MAX_FORCE / acceleration;
    }
    state.vx += ax * dt;
    state.vy += ay * dt;
    state.x += state.vx * dt;
    state.y += state.vy * dt;

    // Same collision, same ring, same bounce as the flock mid-build. The sound
    // fires on the rising edge only: staying inside the ring would otherwise
    // click on every frame it is held against the pointer.
    const touching = pressBody(track, state, pointer);
    knocked = touching && !state.touching;
    state.touching = touching;
    if (knocked) state.press = 1;
    state.press = Math.max(0, state.press - dt * PRESS_DECAY);

    if (Math.hypot(state.vx, state.vy) >= REST_SPEED) {
      const facing = (Math.atan2(state.vy, state.vx) * 180) / Math.PI + REVEAL_FACING_OFFSET;
      const delta = ((((facing - state.angle + 540) % 360) + 360) % 360) - 180;
      state.angle += delta * Math.min(1, dt * 8);
    } else {
      // Parked: stand upright with a slow sway, the way an idle arrow would.
      const sway = Math.sin((input.time / SWAY_MS) * Math.PI * 2) * SWAY_DEG;
      state.angle += (sway - state.angle) * Math.min(1, dt * 1.2);
    }

    state.x = clamp(state.x, EDGE, Math.max(EDGE, bounds.width - EDGE));
    state.y = clamp(state.y, EDGE, Math.max(EDGE, bounds.height - EDGE));
  }
  return {
    x: state.x,
    y: state.y,
    angle: state.angle,
    scale: 1 - state.press * (1 - REVEAL_PRESS_SCALE),
    knocked,
  };
}
