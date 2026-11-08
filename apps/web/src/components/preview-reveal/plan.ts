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
  durationMs: number;
}

/**
 * Gesture durations, already through the original's tempo multiplier. The original
 * runs its generators at `clamp(2.1 + vel/900 + avail/agents*0.5, 2.1, 4.5) * speed`,
 * so a nominal wait of t takes t/tempo. We do the same arithmetic once, at plan time,
 * driven by how much work is still queued.
 */
const DRAW_MS = 260;
const SWEEP_MS = 320;
const DUPLICATE_MS = 280;
const TYPE_MIN_MS = 150;
const TYPE_MAX_MS = 480;
const CURSOR_GAP_MS = 26;
/** The finale needs room to refill the swell to 36 and let it circle once. */
const TAIL_MS = 2400;

/** The original tempo formula: a faster build the more work is still waiting. */
export function revealTempo(pending: number, agentCount: number): number {
  const workers = Math.max(1, agentCount);
  const raw = 2.1 + 0 + (pending / workers) * 0.5;
  return Math.min(4.5, Math.max(2.1, raw));
}

const CURSOR_FOR_KIND: Record<PreviewRevealKind, PreviewRevealCursor> = {
  rect: 'layout',
  text: 'type',
  image: 'color',
};

/** A band behind everything else. Drawing it paints a slab over the pieces that matter. */
function isBackdrop(layer: PreviewRevealLayer, viewport: { width: number; height: number }): boolean {
  if (layer.kind === 'text') return false;
  return layer.w >= viewport.width * 0.8 && layer.h >= viewport.height * 0.22;
}

export function planPreviewReveal(blueprint: PreviewRevealBlueprint): PreviewRevealPlan {
  const layers = [...blueprint.layers]
    .filter((layer) => !isBackdrop(layer, blueprint.viewport))
    .sort((a, b) => a.y - b.y || a.x - b.x);
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

  const schedule = (layer: PreviewRevealLayer, action: PreviewRevealAction, cursor: PreviewRevealCursor, notBefore: number) => {
    const nominal = action === 'type'
      ? Math.min(TYPE_MAX_MS, Math.max(TYPE_MIN_MS, 16 * layer.text.length + 110))
      : action === 'sweep'
        ? SWEEP_MS
        : action === 'duplicate'
          ? DUPLICATE_MS
          : DRAW_MS;
    // Everything still queued beyond this point makes the crew work faster.
    const tempo = revealTempo(remaining, WORKERS);
    const durationMs = Math.round(Math.max(90, nominal / tempo));
    remaining -= 1;
    const agent = pickAgent(cursor);
    const startMs = Math.max(freeAt(agent), notBefore);
    tasks.push({ layerId: layer.id, cursor, agent, action, startMs, durationMs });
    agentFree[agent] = startMs + durationMs + CURSOR_GAP_MS;
    if (layer.group && layer.master) masterEnd.set(layer.group, startMs + durationMs);
    return startMs + durationMs;
  };

  for (const layer of singles) {
    const action: PreviewRevealAction = layer.kind === 'text' ? 'type' : layer.kind === 'image' ? 'sweep' : 'draw';
    schedule(layer, action, CURSOR_FOR_KIND[layer.kind], 0);
  }
  for (const layer of duplicates) {
    const afterMaster = layer.group ? masterEnd.get(layer.group) ?? 0 : 0;
    schedule(layer, 'duplicate', 'layout', afterMaster);
  }

  const end = tasks.reduce((max, task) => Math.max(max, task.startMs + task.durationMs), 0);
  return { tasks, buildMs: end, durationMs: end + TAIL_MS };
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
