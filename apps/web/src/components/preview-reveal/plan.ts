import type { PreviewRevealBlueprint, PreviewRevealKind, PreviewRevealLayer } from '@open-design/contracts/runtime/preview-reveal';
import { REVEAL_AGENTS, REVEAL_INTRO_MS } from './swarm';

export type PreviewRevealCursor = 'layout' | 'type' | 'color';
export type PreviewRevealAction = 'draw' | 'type' | 'sweep' | 'duplicate';

export interface PreviewRevealTask {
  layerId: string;
  cursor: PreviewRevealCursor;
  /** Which swarm cursor performs the gesture. */
  agent: number;
  action: PreviewRevealAction;
  startMs: number;
  durationMs: number;
}

export interface PreviewRevealPlan {
  tasks: PreviewRevealTask[];
  /** When the last gesture ends; everything after this is the finale swarm. */
  buildMs: number;
  /** Where the finale starts folding the crew into one cursor. */
  convergeMs: number;
  durationMs: number;
}

/**
 * Gesture durations: the reference's own numbers, paced by one constant.
 *
 * The reference divides a nominal duration by a `2.1..4.5` tempo multiplier, so
 * a 260ms draw lands at 124ms when idle and ~58ms on a busy page. `SLOWDOWN` is
 * the only thing that should move: everything below is the reference verbatim,
 * so the whole build runs at a fixed `1.15x` its tempo and the relative rhythm
 * between a draw, a sweep and a type is exactly the original's.
 *
 * (The legibility the marquee needed comes from `easeGesture` spreading the
 * travel across the beat, not from stretching the beat itself.)
 */
const REFERENCE_DRAW_MS = 260;
const REFERENCE_SWEEP_MS = 320;
const REFERENCE_DUPLICATE_MS = 280;
const REFERENCE_TYPE_MIN_MS = 150;
const REFERENCE_TYPE_MAX_MS = 480;
const REFERENCE_CURSOR_GAP_MS = 26;

/** The one pacing knob: 1 is the reference, 1.15 is a hair slower than it. */
export const SLOWDOWN = 1.15;

const DRAW_MS = REFERENCE_DRAW_MS;
const SWEEP_MS = REFERENCE_SWEEP_MS;
const DUPLICATE_MS = REFERENCE_DUPLICATE_MS;
const TYPE_MIN_MS = REFERENCE_TYPE_MIN_MS;
const TYPE_MAX_MS = REFERENCE_TYPE_MAX_MS;
const CURSOR_GAP_MS = REFERENCE_CURSOR_GAP_MS;
/**
 * The background gets its own, longer gesture: it is the only thing on screen
 * while it is drawn, and a full-width slab needs more travel than a card to read
 * as a drag. This is absolute rather than reference-relative — the reference had
 * no such gesture, because it filtered the background out entirely.
 */
const BACKDROP_MS = 460;
/**
 * The shortest a card gesture may run.
 *
 * The reference's floor is 90ms, and on a crowded page the tempo saturates near
 * 4.5 so *every* draw lands there: two frames, and the marquee is gone before
 * the eye catches which way it was pulled. This floor only lifts those saturated
 * frames off the bottom. It is set below what an ordinary page's draw already
 * costs (~119ms of reference schedule), so a normal build never touches it and
 * the 1.15x pacing stays exactly 1.15x.
 */
const MIN_GESTURE_MS = 100;
/** Room for the swarm to circle the page once before the merge. */
const FLOCK_MS = 900;
/**
 * The finale: every arrow spirals in and lands on the pointer, leaving one.
 * Slightly under a second — long enough to read as a gathering, short enough
 * that it is still an ending rather than a second scene.
 */
const CONVERGE_MS = 1000;
const TAIL_MS = FLOCK_MS + CONVERGE_MS;

/** The reference's tempo formula, untouched: a busier build runs faster. */
export function revealTempo(pending: number, agentCount: number): number {
  const workers = Math.max(1, agentCount);
  const raw = 2.1 + (pending / workers) * 0.5;
  return Math.min(4.5, Math.max(2.1, raw));
}

const CURSOR_FOR_KIND: Record<PreviewRevealKind, PreviewRevealCursor> = {
  rect: 'layout',
  text: 'type',
  image: 'color',
};

/**
 * A band behind everything else: a full-width slab, or the page's own backdrop.
 *
 * It used to be filtered out entirely, which is why the build never drew one —
 * the largest element on the page silently never got a gesture. It cannot be
 * drawn *like the other boxes* though: dragging a 1400×400 slab in from its
 * corner at the same tempo as a 180×96 card paints the whole page grey for the
 * length of the drag and buries the pieces underneath.
 *
 * So it is drawn first, alone, and slowly: the crew has the page to itself, the
 * marquee sweeps out the full extent with nothing to obscure, and the pieces
 * land on top afterwards. That is also the reference's reading order — the
 * ground goes down before the things standing on it.
 */
function isBackdrop(layer: PreviewRevealLayer, viewport: { width: number; height: number }): boolean {
  if (layer.kind === 'text') return false;
  return layer.w >= viewport.width * 0.8 && layer.h >= viewport.height * 0.22;
}

export function planPreviewReveal(blueprint: PreviewRevealBlueprint): PreviewRevealPlan {
  const sorted = [...blueprint.layers].sort((a, b) => a.y - b.y || a.x - b.x);
  const backdrops = sorted.filter((layer) => isBackdrop(layer, blueprint.viewport));
  const layers = sorted.filter((layer) => !isBackdrop(layer, blueprint.viewport));
  const singles = layers.filter((layer) => !layer.group || layer.master);
  const duplicates = layers.filter((layer) => layer.group && !layer.master);
  const tasks: PreviewRevealTask[] = [];
  const agentFree = REVEAL_AGENTS.map((agent) => (
    agent.works ? REVEAL_INTRO_MS + (agent.id % 3) * 160 : Number.POSITIVE_INFINITY
  ));
  const masterEnd = new Map<string, number>();
  const WORKERS = Math.max(1, REVEAL_AGENTS.filter((agent) => agent.works).length);
  let remaining = singles.length + duplicates.length;

  const freeAt = (id: number): number => agentFree[id] ?? Number.POSITIVE_INFINITY;

  const pickAgent = (cursor: PreviewRevealCursor): number => {
    let best = REVEAL_AGENTS.find((agent) => agent.works && agent.role === cursor)?.id ?? 0;
    for (const agent of REVEAL_AGENTS) {
      if (!agent.works || agent.role !== cursor) continue;
      if (freeAt(agent.id) < freeAt(best)) best = agent.id;
    }
    return best;
  };

  const schedule = (
    layer: PreviewRevealLayer,
    action: PreviewRevealAction,
    cursor: PreviewRevealCursor,
    notBefore: number,
    fixedMs?: number,
  ) => {
    const nominal = fixedMs ?? (action === 'type'
      ? Math.min(TYPE_MAX_MS, Math.max(TYPE_MIN_MS, 16 * layer.text.length + 110))
      : action === 'sweep'
        ? SWEEP_MS
        : action === 'duplicate'
          ? DUPLICATE_MS
          : DRAW_MS);
    // Everything still queued beyond this point makes the crew work faster.
    // A fixed-duration gesture (the backdrop) keeps its own clock: it is the
    // one thing on screen at the time, so making it race helps nobody.
    const tempo = fixedMs ? 1 : revealTempo(remaining, WORKERS);
    // `SLOWDOWN` multiplies the *finished* duration, floor included. Scaling the
    // nominal alone would do nothing on a busy page: the tempo saturates near
    // 4.5, every gesture lands on the 90ms floor, and the knob gets swallowed by
    // it. This way the whole build is exactly `1.15x` the reference's schedule.
    const floor = fixedMs ? 90 : MIN_GESTURE_MS;
    const durationMs = Math.round(SLOWDOWN * Math.max(floor, nominal / tempo));
    remaining -= 1;
    const agent = pickAgent(cursor);
    const startMs = Math.max(freeAt(agent), notBefore);
    tasks.push({ layerId: layer.id, cursor, agent, action, startMs, durationMs });
    agentFree[agent] = startMs + durationMs + Math.round(CURSOR_GAP_MS * SLOWDOWN);
    if (layer.group && layer.master) masterEnd.set(layer.group, startMs + durationMs);
    return startMs + durationMs;
  };

  // The ground first, on its own clock, with the page to itself. Only the
  // largest slab is drawn: a page often carries several full-bleed backgrounds
  // (one per hidden screen), they cover the same pixels, and animating each in
  // turn would spend seconds painting over work nobody can see.
  let cursorAt = 0;
  const ground = backdrops.reduce<PreviewRevealLayer | null>(
    (best, layer) => (!best || layer.w * layer.h > best.w * best.h ? layer : best),
    null,
  );
  if (ground) {
    const action: PreviewRevealAction = ground.kind === 'image' ? 'sweep' : 'draw';
    cursorAt = schedule(ground, action, CURSOR_FOR_KIND[ground.kind], 0, BACKDROP_MS);
  }

  for (const layer of singles) {
    const action: PreviewRevealAction = layer.kind === 'text' ? 'type' : layer.kind === 'image' ? 'sweep' : 'draw';
    schedule(layer, action, CURSOR_FOR_KIND[layer.kind], cursorAt);
  }
  for (const layer of duplicates) {
    const afterMaster = layer.group ? masterEnd.get(layer.group) ?? 0 : 0;
    schedule(layer, 'duplicate', 'layout', Math.max(afterMaster, cursorAt));
  }

  const end = tasks.reduce((max, task) => Math.max(max, task.startMs + task.durationMs), 0);
  return {
    tasks,
    buildMs: end,
    convergeMs: end + FLOCK_MS,
    durationMs: end + TAIL_MS,
  };
}

/**
 * Where a curtain is in its arc. `build` draws the page, `flock` circles it,
 * and `converge` is the finale where every arrow folds into the one that
 * survives.
 */
export function previewRevealPhaseAt(plan: PreviewRevealPlan, elapsed: number): 'build' | 'flock' | 'converge' {
  if (elapsed < plan.buildMs) return 'build';
  if (elapsed < plan.convergeMs) return 'flock';
  return 'converge';
}

/** 0..1 through the converge, and 0 outside it. */
export function previewRevealConvergeAt(plan: PreviewRevealPlan, elapsed: number): number {
  if (elapsed < plan.convergeMs) return 0;
  return Math.min(1, (elapsed - plan.convergeMs) / Math.max(1, plan.durationMs - plan.convergeMs));
}

export interface PreviewRevealAutoplayInput {
  streamingEnded: boolean;
  active: boolean;
  blocked: boolean;
  previewReady: boolean;
  reducedMotion: boolean;
}

/** Autoplay is the moment a run just finished and the preview is actually on screen. */
export function shouldQueuePreviewRevealAutoplay(input: PreviewRevealAutoplayInput): boolean {
  return input.streamingEnded
    && input.active
    && input.blocked === false
    && input.previewReady
    && input.reducedMotion === false;
}

const playedKeys = new Set<string>();

/** One automatic play per file version for this page load. Replay does not consult this. */
export function claimPreviewRevealAutoplay(key: string): boolean {
  if (playedKeys.has(key)) return false;
  playedKeys.add(key);
  return true;
}

export function resetPreviewRevealAutoplayForTests(): void {
  playedKeys.clear();
}
