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
 */

export const MIN_AGENTS = 8;
export const MAX_AGENTS = 48;
export const FLOCK_AGENTS = 36;
export const INTRO_AGENTS = 18;

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

export type FlockPhase = 'build' | 'flock';

export interface FlockStepInput {
  state: FlockState;
  dt: number;
  time: number;
  /** Pointer position in stage space, or null when it is outside. */
  pointer: FlockPoint | null;
  /** Pointer travel in pixels per second, which is what grows the crew. */
  pointerSpeed: number;
  /** Tasks that have not finished yet, the original's `avail.length`. */
  pending: number;
  /** Where the swarm gathers when nothing better is happening. */
  anchor: FlockPoint;
  /** Per-cursor corner pin, when that cursor is drawing a box right now. */
  work: (cursor: FlockCursor) => FlockWork | null;
  phase: FlockPhase;
}

const ORBIT_RADIUS = 118;
const NEIGHBOUR_RADIUS = 96;
const POINTER_KEEPOUT = 46;
const BUILD_SPAWN_S = 0.035;
const FLOCK_SPAWN_S = 0.04;
const LEAVE_S = 0.34;
/** Arrow tip sits upper-left, so the sprite needs this offset to face its travel. */
export const FLOCK_ANGLE_OFFSET = 135;

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

/** 18 walk in; the first eight are home crew. The role roster never leaves, and every
 *  cursor that draws is inside those eight, so the crew can shrink without losing work. */
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

/** The original formula: minimum crew plus pointer travel plus pending work, capped. */
export function flockTarget(pointerSpeed: number, pending: number, phase: FlockPhase): number {
  if (phase === 'flock') return FLOCK_AGENTS;
  return clamp(
    MIN_AGENTS + Math.floor(pointerSpeed / 40) + Math.floor(pending / 2),
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
  const roleCount = countRoles(state);
  const want = flockTarget(input.pointerSpeed, input.pending, input.phase);

  state.spawnCooldown -= dt;
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

  // Anyone above the target flies off, unless it is home crew.
  let active = state.cursors.filter((cursor) => cursor.leaving === 0).length;
  for (const cursor of state.cursors) {
    if (active <= want) break;
    if (cursor.home || cursor.leaving > 0) continue;
    cursor.leaving = 0.0001;
    active -= 1;
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
    anchor,
    work: input.work,
    releasing: input.phase === 'flock',
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
    anchor: FlockPoint;
    work: (cursor: FlockCursor) => FlockWork | null;
    releasing: boolean;
  },
): void {
  const { pointer, anchor } = input;
  const dt = input.dt;
  const time = input.time / 1000;
  const origin = pointer ?? anchor;
  const radius = ORBIT_RADIUS * (1 + 0.18 * Math.sin(time * 0.55));
  const swirl = Math.tanh(Math.cos(time * 0.11) * 3);

  const desired: Array<[number, number]> = [];
  for (const cursor of cursors) {
    const work = input.work(cursor);
    // In the finale everyone only circles; no one splits off to a corner.
    const pin = input.releasing ? 0 : 1;
    const blend = work ? clamp(work.blend, 0, 1) * pin : 0;
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

  if (pointer) {
    for (const cursor of cursors) {
      const dx = cursor.x - pointer.x;
      const dy = cursor.y - pointer.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      if (distance >= POINTER_KEEPOUT) {
        cursor.press = Math.max(0, cursor.press - dt * 6);
        continue;
      }
      const nx = dx / distance;
      const ny = dy / distance;
      cursor.x = pointer.x + nx * POINTER_KEEPOUT;
      cursor.y = pointer.y + ny * POINTER_KEEPOUT;
      cursor.vx += nx * 260;
      cursor.vy += ny * 260;
      cursor.press = 1;
    }
  } else {
    for (const cursor of cursors) cursor.press = Math.max(0, cursor.press - dt * 6);
  }

  for (const cursor of cursors) {
    if (Math.hypot(cursor.vx, cursor.vy) < 26) continue;
    const facing = (Math.atan2(cursor.vy, cursor.vx) * 180) / Math.PI + FLOCK_ANGLE_OFFSET;
    const delta = ((((facing - cursor.angle + 540) % 360) + 360) % 360) - 180;
    cursor.angle += delta * Math.min(1, dt * 8);
  }
}
