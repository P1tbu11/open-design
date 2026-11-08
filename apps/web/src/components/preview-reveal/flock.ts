/**
 * Flocking cursor swarm, modelled on the original swarm-cursors follow loop.
 * Every cursor orbits one shared target, each with its own orbit radius,
 * spin, curl and speed, plus alignment with close neighbours. The target is
 * the user's pointer when it is over the stage, and the box being built when
 * the pointer has not moved in.
 *
 * Population follows the original numbers, hard-coded on purpose:
 * 18 cursors walk in, the build keeps 8..48 alive from a formula, and the
 * finale fills back up to 36.
 *
 * Distances and forces are the reference's own (`swarm-cursors/swarm-rebuild/
 * swarm.js`, `Engine#follow`): orbit 135, neighbour radius 90, pointer ring 48,
 * facing offset 128, alignment 0.7/0.3, and the speed/force ceilings below.
 * Change one of those and the flock stops behaving like the original.
 */

import { PRESS_DECAY, pressBody, createPressTrack, type PressTrack } from './press';
import { REVEAL_FACING_OFFSET } from './swarm';

/**
 * Population. The reference runs 18 walking in, 8..48 during the build and 36
 * for the finale; on a build curtain this short that many arrows read as noise
 * rather than as a crew — and most of them never touch the page, so they are
 * pure clutter. Ten arrive, the build holds 6..14 depending on how much is
 * queued, and the finale tops back up to 12 for the merge.
 */

/**
 * Every cursor below this id draws, and a cursor may only take a task while it
 * is home crew.
 */
const DRAWING_CURSORS = 6;

/**
 * The floor is exactly the drawing roster, not a hair lower: home crew is what
 * never leaves, so a lower floor would let the crew cull a cursor that is
 * mid-gesture and the box it is dragging would stall half-drawn.
 */
export const MIN_AGENTS = DRAWING_CURSORS;
export const MAX_AGENTS = 14;
export const FLOCK_AGENTS = 12;
export const INTRO_AGENTS = 10;

/** The original agent palette, cycled for helpers that own no task. */
const FLOCK_COLORS = [
  '#F24E1E', '#A259FF', '#1ABCFE', '#0ACF83', '#FF7262', '#FFC700',
  '#9747FF', '#E8467C', '#14AE5C', '#0D99FF', '#FF8A00', '#00B5CE',
];

export function flockColorOf(cursor: FlockCursor, roleColors: readonly string[]): string {
  const role = cursor.agent >= 0 ? roleColors[cursor.agent] : undefined;
  return role ?? FLOCK_COLORS[cursor.id % FLOCK_COLORS.length]!;
}

export interface FlockCursor {
  id: number;
  /** Index into the role roster, or -1 for a helper that never draws. */
  agent: number;
  /** The first arrivals never leave, the way the original keeps its home crew. */
  home: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  /** Per-cursor orbit radius bias, so the ring is never a perfect circle. */
  orbit: number;
  /** How much of the tangential (swirl) force this cursor gets. */
  spin: number;
  /** Which way it peels away when it drifts out of the ring. */
  curl: number;
  speed: number;
  force: number;
  /** 0..1, shrinks the arrow the way the original does on click. */
  press: number;
  /** 0 while present, grows to 1 while flying off. */
  leaving: number;
}

export interface FlockState {
  cursors: FlockCursor[];
  spawnCooldown: number;
  nextId: number;
}

export interface FlockPoint {
  x: number;
  y: number;
}

export interface FlockWork {
  x: number;
  y: number;
  /** 0 = fully in the swarm, 1 = sitting on the corner it is dragging. */
  blend: number;
}

/**
 * `build` draws the page, `flock` circles it, and `converge` is the finale:
 * the whole crew spirals in on the pointer until one arrow is left.
 *
 * The converge is geometric, not a force balance. The boid loop above is tuned
 * to *hold* a ring — its radial term is a spring around `ORBIT_RADIUS` — so
 * asking it to collapse by shrinking the radius fights itself and the crew only
 * tightens a little before the curtain ends. Rotating each cursor's polar offset
 * toward the knot and easing its length to zero is both simpler and exact, and
 * it keeps every per-cursor orbit phase, so the crew spirals in as a crowd
 * rather than sliding along straight lines.
 */
export type FlockPhase = 'build' | 'flock' | 'converge';

export interface FlockStepInput {
  state: FlockState;
  dt: number;
  time: number;
  /** Pointer position in stage space, or null when it is outside. */
  pointer: FlockPoint | null;
  /** Smoothed pointer velocity, shared with the collision so the bounce reads true. */
  track: PressTrack;
  /** Pointer travel in pixels per second, which is what grows the crew. */
  pointerSpeed: number;
  /** Tasks that have not finished yet, the original's `avail.length`. */
  pending: number;
  /** Where the swarm gathers when nothing better is happening. */
  anchor: FlockPoint;
  /**
   * The point the finale collapses into. Defaults to `anchor`; the host passes
   * the survivor's resting spot so the knot forms exactly where that arrow will
   * then live.
   */
  convergeAt?: FlockPoint;
  /** Per-cursor corner pin, when that cursor is drawing a box right now. */
  work: (cursor: FlockCursor) => FlockWork | null;
  phase: FlockPhase;
  /** 0..1 through the finale merge. Ignored outside the `converge` phase. */
  converge?: number;
}

const ORBIT_RADIUS = 135;
const NEIGHBOUR_RADIUS = 90;
const BUILD_SPAWN_S = 0.035;
const FLOCK_SPAWN_S = 0.04;
const LEAVE_S = 0.34;
/** A merged cursor disappears once inside this radius of the knot. */
const MERGE_RADIUS = 26;
/** Arrow tip sits upper-left, so the sprite needs this offset to face its travel. */
export const FLOCK_ANGLE_OFFSET = REVEAL_FACING_OFFSET;

function seeded(index: number): () => number {
  let state = (index + 1) * 0x9e3779b1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

function rand(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

let nextCursorId = 0;

function makeCursor(
  state: FlockState,
  anchor: FlockPoint,
  agent: number,
  home: boolean,
  spread: number,
): FlockCursor {
  const id = state.nextId;
  state.nextId += 1;
  const rng = seeded(id + nextCursorId);
  const fast = rng() < 0.25;
  const phase = rng() * Math.PI * 2;
  const radius = ORBIT_RADIUS + spread;
  return {
    id,
    agent,
    home,
    x: anchor.x + Math.cos(phase) * radius,
    y: anchor.y + Math.sin(phase) * radius * 0.7,
    vx: 0,
    vy: 0,
    angle: 0,
    orbit: rand(rng, 70, 170),
    spin: fast ? rand(rng, 2.2, 3.4) : rand(rng, 0.8, 1.8),
    curl: rand(rng, -1, 1),
    speed: fast ? rand(rng, 1000, 1500) : rand(rng, 300, 750),
    force: fast ? rand(rng, 3500, 6000) : rand(rng, 700, 1800),
    press: 0,
    leaving: 0,
  };
}

/**
 * The intro crew walks in. The first `MIN_AGENTS` are home crew and are the
 * only cursors that hold drawing roles, so the crew can shrink back to the floor
 * without ever losing a cursor that still has work.
 */
export function createFlockState(anchor: FlockPoint, roleCount: number): FlockState {
  nextCursorId = 0;
  const state: FlockState = { cursors: [], spawnCooldown: 0, nextId: 0 };
  for (let index = 0; index < INTRO_AGENTS; index += 1) {
    state.cursors.push(makeCursor(
      state,
      anchor,
      index < roleCount ? index : -1,
      index < MIN_AGENTS,
      index < roleCount ? 0 : 40 + (index - roleCount) * 6,
    ));
  }
  return state;
}

/**
 * Minimum crew plus pointer travel plus queued work, capped.
 *
 * The reference divides pending work by 2 against a 48-cursor ceiling; against
 * this much smaller crew both terms would saturate the cap on any real page
 * (a 28-layer page alone would add 7 bystanders who never touch it). They are
 * divided by 8 and 90 instead, so the crew grows because the page is genuinely
 * busy and not merely because it has layers.
 */
export function flockTarget(pointerSpeed: number, pending: number, phase: FlockPhase): number {
  if (phase !== 'build') return FLOCK_AGENTS;
  return clamp(
    MIN_AGENTS + Math.floor(pointerSpeed / 90) + Math.floor(pending / 8),
    MIN_AGENTS,
    MAX_AGENTS,
  );
}

function freeRole(state: FlockState, roleCount: number): number {
  const taken = new Set(state.cursors.filter((cursor) => cursor.leaving === 0 && cursor.agent >= 0).map((cursor) => cursor.agent));
  for (let index = 0; index < roleCount; index += 1) {
    if (!taken.has(index)) return index;
  }
  return -1;
}

/** Advance the population, then every cursor, by one frame. Mutates `state`. */
export function stepFlock(input: FlockStepInput): void {
  const { state, pointer, anchor } = input;
  const dt = Math.min(0.05, Math.max(0, input.dt));
  if (dt === 0) return;
  const merging = input.phase === 'converge';
  const roleCount = countRoles(state);
  const want = flockTarget(input.pointerSpeed, input.pending, input.phase);

  state.spawnCooldown -= dt;
  // The finale only ever sheds cursors: refilling behind a merge would make the
  // knot grow as it tightens.
  if (!merging) {
    for (let guard = 0; guard < 4; guard += 1) {
      const active = state.cursors.filter((cursor) => cursor.leaving === 0).length;
      if (active >= want || state.spawnCooldown > 0) break;
      const role = freeRole(state, roleCount);
      state.cursors.push(makeCursor(
        state,
        anchor,
        role,
        false,
        40 + roleCount * 6 + (active % 5) * 7,
      ));
      state.spawnCooldown = input.phase === 'flock' ? FLOCK_SPAWN_S : BUILD_SPAWN_S;
    }
  }

  // Anyone above the target flies off, unless it is home crew. During the merge
  // the crew is allowed to exceed the ceiling on its way in.
  if (!merging) {
    let active = state.cursors.filter((cursor) => cursor.leaving === 0).length;
    for (const cursor of state.cursors) {
      if (active <= want) break;
      if (cursor.home || cursor.leaving > 0) continue;
      cursor.leaving = 0.0001;
      active -= 1;
    }
  }

  for (const cursor of state.cursors) {
    if (cursor.leaving > 0) cursor.leaving = Math.min(1, cursor.leaving + dt / LEAVE_S);
  }
  if (state.cursors.some((cursor) => cursor.leaving >= 1)) {
    state.cursors = state.cursors.filter((cursor) => cursor.leaving < 1);
  }
  advance(state.cursors.filter((cursor) => cursor.leaving === 0), {
    dt,
    time: input.time,
    pointer,
    track: input.track,
    anchor,
    convergeAt: input.convergeAt ?? anchor,
    work: input.work,
    releasing: input.phase === 'flock',
    converge: merging ? clamp(input.converge ?? 0, 0, 1) : 0,
  });
}

function countRoles(state: FlockState): number {
  let max = 0;
  for (const cursor of state.cursors) {
    if (cursor.agent + 1 > max) max = cursor.agent + 1;
  }
  return max;
}

function advance(
  cursors: FlockCursor[],
  input: {
    dt: number;
    time: number;
    pointer: FlockPoint | null;
    track: PressTrack;
    anchor: FlockPoint;
    convergeAt: FlockPoint;
    work: (cursor: FlockCursor) => FlockWork | null;
    releasing: boolean;
    converge: number;
  },
): void {
  const { pointer, anchor } = input;
  const dt = input.dt;
  const time = input.time / 1000;
  const converge = input.converge;

  // The finale is not a force balance. The loop below is tuned to *hold* a ring
  // — its radial term is a spring around ORBIT_RADIUS — so shrinking that
  // radius fights itself and the crew only tightens a little. Instead each
  // cursor's polar offset is rotated and shortened toward the knot directly,
  // keeping its own orbit phase so the crew spirals in as a crowd.
  if (converge > 0) {
    mergeInto(cursors, input.convergeAt, converge, dt);
    return;
  }

  const origin = pointer ?? anchor;
  const radius = ORBIT_RADIUS * (1 + 0.18 * Math.sin(time * 0.55));
  const swirl = Math.tanh(Math.cos(time * 0.11) * 3);

  const desired: Array<[number, number]> = [];
  for (const cursor of cursors) {
    const work = input.work(cursor);
    // Once the build is over nobody splits off to a corner.
    const blend = work && !input.releasing ? clamp(work.blend, 0, 1) : 0;
    const dx = cursor.x - origin.x;
    const dy = cursor.y - origin.y;
    const distance = Math.hypot(dx, dy) || 0.01;
    const nx = dx / distance;
    const ny = dy / distance;
    const angle = Math.atan2(dy, dx);
    const ring = radius * (1 + 0.3 * Math.sin(3 * angle + time * 0.7)) + (cursor.orbit - 120) * 0.55;
    const tangential = 300 * (0.7 + cursor.spin * 0.2) * swirl * (1 - blend);
    const radial = clamp((ring - distance) * 4, -2600, 1400);
    const far = Math.min(1, Math.max(0, (distance - ring) / 600));
    let fx = -ny * tangential + nx * radial - ny * cursor.curl * 400 * far;
    let fy = nx * tangential + ny * radial + nx * cursor.curl * 400 * far;
    if (work && blend > 0) {
      // Pull onto the corner it is dragging, and hold it there.
      fx += (work.x - cursor.x) * 26 * blend;
      fy += (work.y - cursor.y) * 26 * blend;
    }
    desired.push([fx, fy]);
  }

  for (let index = 0; index < cursors.length; index += 1) {
    const cursor = cursors[index]!;
    let [fx, fy] = desired[index]!;
    let ax = 0;
    let ay = 0;
    let weight = 0;
    for (let other = 0; other < cursors.length; other += 1) {
      if (other === index) continue;
      const peer = cursors[other]!;
      const gap = Math.hypot(peer.x - cursor.x, peer.y - cursor.y);
      if (gap > NEIGHBOUR_RADIUS) continue;
      const share = 1 - gap / NEIGHBOUR_RADIUS;
      ax += peer.vx * share;
      ay += peer.vy * share;
      weight += share;
    }
    if (weight > 0) {
      fx = fx * 0.7 + (ax / weight) * 0.3;
      fy = fy * 0.7 + (ay / weight) * 0.3;
    }
    const spread = Math.max(0, Math.hypot(cursor.x - origin.x, cursor.y - origin.y) - 180);
    const maxSpeed = cursor.speed * (1.3 + Math.min(3.2, spread / 90));
    const length = Math.hypot(fx, fy);
    if (length > maxSpeed) {
      fx *= maxSpeed / length;
      fy *= maxSpeed / length;
    }
    let gx = (fx - cursor.vx) * 6;
    let gy = (fy - cursor.vy) * 6;
    const maxForce = cursor.force * (1.4 + Math.min(5, spread / 50));
    const force = Math.hypot(gx, gy);
    if (force > maxForce) {
      gx *= maxForce / force;
      gy *= maxForce / force;
    }
    cursor.vx += gx * dt;
    cursor.vy += gy * dt;
    cursor.x += cursor.vx * dt;
    cursor.y += cursor.vy * dt;
  }

  // Same collision the companion uses, so a knock feels identical in both.
  if (pointer) {
    for (const cursor of cursors) {
      if (pressBody(input.track, cursor, pointer)) cursor.press = 1;
    }
  }

  // The original turns a cursor while it is actually travelling, and relaxes
  // every flinch on the same 6/s clock.
  for (const cursor of cursors) {
    if (Math.hypot(cursor.vx, cursor.vy) >= 30) {
      const facing = (Math.atan2(cursor.vy, cursor.vx) * 180) / Math.PI + FLOCK_ANGLE_OFFSET;
      const delta = ((((facing - cursor.angle + 540) % 360) + 360) % 360) - 180;
      cursor.angle += delta * Math.min(1, dt * 8);
    }
    cursor.press = Math.max(0, cursor.press - dt * PRESS_DECAY);
  }
}

/**
 * The finale, in polar form.
 *
 * Every cursor keeps the bearing it already has and winds in on that bearing,
 * so the crowd reads as arrows spiralling down a funnel rather than sliding
 * along parallel lines. The wind is a fraction of a turn that grows with the
 * progress, and each cursor's own `spin`/`curl` decide how far it travels —
 * that is what keeps the group looking disordered on the way in.
 *
 * Arrivals are staggered by index: the crew disappears from the outside in
 * over the last part of the merge, instead of all vanishing on one frame.
 * The lowest-id cursor (the blue lead) is always the one left standing, and it
 * is the one the host hands to `PreviewCompanion`.
 */
function mergeInto(
  cursors: FlockCursor[],
  target: FlockPoint,
  progress: number,
  dt: number,
): void {
  if (cursors.length === 0) return;
  for (const cursor of cursors) {
    const dx = cursor.x - target.x;
    const dy = cursor.y - target.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0.5) {
      const bearing = Math.atan2(dy, dx);
      // A quarter-turn to a full turn of wind, longer for the cursors that
      // already spin hard: identical to how they behave in the ring.
      const wind = (0.25 + Math.abs(cursor.curl) * 0.55) * (cursor.curl < 0 ? -1 : 1) * progress;
      const nextBearing = bearing + wind;
      // Ease-in so the knot opens with a turn and closes with a snap.
      const pulled = distance * (1 - progress ** 1.35);
      const nx = target.x + Math.cos(nextBearing) * pulled;
      const ny = target.y + Math.sin(nextBearing) * pulled;
      cursor.vx = (nx - cursor.x) / Math.max(dt, 0.001);
      cursor.vy = (ny - cursor.y) / Math.max(dt, 0.001);
      cursor.x = nx;
      cursor.y = ny;
      const facing = (Math.atan2(cursor.vy, cursor.vx) * 180) / Math.PI + FLOCK_ANGLE_OFFSET;
      const delta = ((((facing - cursor.angle + 540) % 360) + 360) % 360) - 180;
      cursor.angle += delta * Math.min(1, dt * 12);
    }
    cursor.press = Math.max(0, cursor.press - dt * PRESS_DECAY);
  }

  // Bows out from the outside in. The lead arrow never bows out; it is the one
  // the host turns into the surviving cursor.
  const lead = cursors.reduce((best, cursor) => (cursor.id < best.id ? cursor : best), cursors[0]!);
  const reach = MERGE_RADIUS + 30 * (1 - progress);
  for (const cursor of cursors) {
    if (cursor === lead || cursor.leaving > 0) continue;
    // Stagger by id so they do not all reach the knot on the same frame.
    const lag = 0.55 + ((cursor.id * 37) % 100) / 260;
    if (progress >= lag && Math.hypot(cursor.x - target.x, cursor.y - target.y) <= reach) {
      cursor.leaving = 0.0001;
    }
  }
}