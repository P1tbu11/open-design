/**
 * The original swarm's pointer collision, kept in one place.
 *
 * Numbers are the reference's verbatim (`swarm-cursors/swarm-rebuild/swarm.js`,
 * `Engine#follow`): a 48px keep-out ring, a 260px/s shove along the normal, and
 * a bounce whose strength is the closing speed *relative to the pointer's own
 * movement*, reflected at 1.6. The pointer's velocity is smoothed with
 * `k = min(1, dt * 18)`.
 *
 * The relative term is what makes a hit read as a knock instead of a wall: a
 * mouse moving toward a cursor throws it, a mouse retreating only pushes it
 * out of the ring. That asymmetry is the "alive" half of the effect; the ring
 * itself pulls the cursor back to its orbit, which is the "sticks to you" half.
 *
 * Kept apart from the flock and the companion so the two consumers cannot
 * drift into two different collision feels.
 */

/** The ring the swarm never enters, and the distance a companion rests at. */
export const PRESS_RING = 48;

const PRESS_REFLECT = 1.6;
const PRESS_IMPULSE = 260;
const POINTER_VELOCITY_SMOOTHING = 18;

/** How fast a cursor's flinch decays. Reference: `press -= dt * 6`. */
export const PRESS_DECAY = 6;

export interface PressPoint {
  x: number;
  y: number;
}

export interface PressBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** The pointer's own velocity, smoothed across frames. */
export interface PressTrack {
  velocity: PressPoint;
  previous: PressPoint | null;
}

export function createPressTrack(): PressTrack {
  return { velocity: { x: 0, y: 0 }, previous: null };
}

/**
 * Advance the pointer's velocity. A pointer that leaves (null) forgets where it
 * was, so re-entering the stage is not read as one enormous swipe.
 */
export function trackPointer(track: PressTrack, pointer: PressPoint | null, dt: number): void {
  if (!pointer) {
    track.previous = null;
    track.velocity.x = 0;
    track.velocity.y = 0;
    return;
  }
  const last = track.previous;
  if (last && dt > 0) {
    const k = Math.min(1, dt * POINTER_VELOCITY_SMOOTHING);
    track.velocity.x += ((pointer.x - last.x) / dt - track.velocity.x) * k;
    track.velocity.y += ((pointer.y - last.y) / dt - track.velocity.y) * k;
  }
  track.previous = { x: pointer.x, y: pointer.y };
}

/**
 * Push a body out of the pointer's ring, bouncing it when the pointer is
 * closing on it. Returns true on the frames the body was actually hit, so the
 * caller can flinch it and click.
 */
export function pressBody(track: PressTrack, body: PressBody, pointer: PressPoint | null): boolean {
  if (!pointer) return false;
  const dx = body.x - pointer.x;
  const dy = body.y - pointer.y;
  const distance = Math.hypot(dx, dy) || 0.01;
  if (distance >= PRESS_RING) return false;
  const nx = dx / distance;
  const ny = dy / distance;
  body.x = pointer.x + nx * PRESS_RING;
  body.y = pointer.y + ny * PRESS_RING;
  const closing = (body.vx - track.velocity.x) * nx + (body.vy - track.velocity.y) * ny;
  if (closing < 0) {
    body.vx -= nx * closing * PRESS_REFLECT;
    body.vy -= ny * closing * PRESS_REFLECT;
  }
  body.vx += nx * PRESS_IMPULSE;
  body.vy += ny * PRESS_IMPULSE;
  return true;
}
