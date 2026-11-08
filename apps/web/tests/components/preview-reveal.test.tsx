// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPreviewRevealBridge,
  isPreviewRevealPatch,
  parsePreviewRevealBlueprint,
  PREVIEW_REVEAL_PATCH_CAP,
  PREVIEW_REVEAL_PATCH_REQUEST_TYPE,
  PREVIEW_REVEAL_PATCH_TYPE,
  PREVIEW_REVEAL_REQUEST_TYPE,
  PREVIEW_REVEAL_RESPONSE_TYPE,
  type PreviewRevealBlueprint,
} from '@open-design/contracts/runtime/preview-reveal';
import { PreviewRevealHost, PreviewRevealStage, RevealText, toBlueprintSpace, uniformScale } from '../../src/components/preview-reveal/PreviewReveal';
import { PreviewRevealWorking } from '../../src/components/preview-reveal/PreviewRevealWorking';
import { CursorGlyph } from '../../src/components/preview-reveal/CursorGlyph';
import {
  claimPreviewRevealAutoplay,
  planPreviewReveal,
  resetPreviewRevealAutoplayForTests,
  revealTempo,
  SLOWDOWN,
  shouldQueuePreviewRevealAutoplay,
} from '../../src/components/preview-reveal/plan';
import { easeGesture, formatRevealSize, REVEAL_AGENTS, REVEAL_ARROW_HOTSPOT, REVEAL_ARROW_PATH, REVEAL_INTRO_MS, revealLayerFrame } from '../../src/components/preview-reveal/swarm';
import { createFlockState, flockTarget, FLOCK_AGENTS, INTRO_AGENTS, MAX_AGENTS, MIN_AGENTS, stepFlock } from '../../src/components/preview-reveal/flock';
import { createPressTrack } from '../../src/components/preview-reveal/press';
import type { PointerRuntime } from '../../src/components/preview-reveal/pointer';
import { COMPANION_REST, createCompanion, stepCompanion } from '../../src/components/preview-reveal/companion';
import { previewRevealConvergeAt, previewRevealPhaseAt } from '../../src/components/preview-reveal/plan';

/** A pointer reading with no travel, so only the swarm's own physics is under test. */
const stillTrack = () => createPressTrack();

/** A runtime for components under test: the pointer never moves. */
const staticPointer = (): PointerRuntime => {
  const runtime: PointerRuntime = {
    point: null,
    track: createPressTrack(),
    speed: 0,
    sample: () => undefined,
    receive: () => undefined,
    remembered: () => null,
    reset: () => undefined,
  };
  return runtime;
};

afterEach(() => {
  cleanup();
  resetPreviewRevealAutoplayForTests();
});

const layer = {
  radius: 0,
  fill: 'rgb(230, 230, 230)',
  color: 'rgb(17, 17, 17)',
  weight: 400,
  size: 16,
  text: '',
  style: '',
  src: '',
  group: null,
  master: false,
  scale: 1,
  html: '',
};

function blueprint(layers: PreviewRevealBlueprint['layers']): PreviewRevealBlueprint {
  return {
    requestId: 'reveal-1',
    viewport: { width: 800, height: 600 },
    background: 'rgb(255, 255, 255)',
    layers,
  };
}

describe('planPreviewReveal', () => {
  it('gives boxes, type, and images to different cursors, and copies wait for the master', () => {
    const plan = planPreviewReveal(blueprint([
      { ...layer, id: 'card', kind: 'rect', x: 16, y: 40, w: 180, h: 96, group: 'cards', master: true },
      { ...layer, id: 'copy', kind: 'rect', x: 220, y: 40, w: 180, h: 96, group: 'cards', master: false },
      { ...layer, id: 'title', kind: 'text', x: 24, y: 16, w: 120, h: 28, text: 'Studio' },
      { ...layer, id: 'photo', kind: 'image', x: 24, y: 160, w: 96, h: 96 },
    ]));
    expect(plan.tasks.find((task) => task.layerId === 'card')).toMatchObject({ cursor: 'layout', action: 'draw' });
    expect(plan.tasks.find((task) => task.layerId === 'title')).toMatchObject({ cursor: 'type', action: 'type' });
    expect(plan.tasks.find((task) => task.layerId === 'photo')).toMatchObject({ cursor: 'color', action: 'sweep' });
    const master = plan.tasks.find((task) => task.layerId === 'card');
    const copy = plan.tasks.find((task) => task.layerId === 'copy');
    expect(copy?.action).toBe('duplicate');
    expect(copy && master ? copy.startMs : 0).toBeGreaterThanOrEqual((master?.startMs ?? 0) + (master?.durationMs ?? 0));
    expect(plan.tasks.every((task) => REVEAL_AGENTS.find((agent) => agent.id === task.agent)?.works)).toBe(true);
  });

  it('draws the backdrop first, on its own clock, before the pieces land on it', () => {
    const plan = planPreviewReveal(blueprint([
      { ...layer, id: 'band', kind: 'rect', x: 0, y: 160, w: 760, h: 300, fill: 'rgb(0, 0, 0)' },
      { ...layer, id: 'poster', kind: 'image', x: 0, y: 160, w: 760, h: 300 },
      { ...layer, id: 'icon', kind: 'image', x: 44, y: 210, w: 38, h: 45 },
    ]));
    // The regression: the largest element on the page never got a gesture at
    // all, so the build appeared to start from nothing.
    const ground = plan.tasks.find((task) => task.layerId === 'band');
    expect(ground).toBeDefined();
    expect(ground?.action).toBe('draw');
    // It goes down alone: nothing else starts while it is being dragged.
    // (It cannot start at 0 — the crew is still flying in until REVEAL_INTRO_MS.)
    expect(ground?.startMs).toBeGreaterThan(0);
    expect(ground?.startMs).toBeLessThanOrEqual(REVEAL_INTRO_MS + 400);
    const others = plan.tasks.filter((task) => task.layerId !== 'band');
    expect(others.every((task) => task.startMs >= (ground?.startMs ?? 0) + (ground?.durationMs ?? 0))).toBe(true);
    // Slow enough to read as a drag, and it ignores the tempo multiplier.
    expect(ground?.durationMs).toBeGreaterThanOrEqual(480);
    expect(plan.tasks.map((task) => task.layerId)).toContain('icon');
  });

  it('draws one backdrop when a page carries several full-bleed layers', () => {
    // Hidden screens each ship their own background; only the biggest gets a
    // gesture, or the curtain would spend seconds painting over itself.
    const plan = planPreviewReveal(blueprint([
      { ...layer, id: 'bg-a', kind: 'image', x: 0, y: 0, w: 800, h: 600 },
      { ...layer, id: 'bg-b', kind: 'image', x: 0, y: 0, w: 700, h: 500 },
      { ...layer, id: 'icon', kind: 'image', x: 44, y: 210, w: 38, h: 45 },
    ]));
    const ground = plan.tasks.filter((task) => task.layerId.startsWith('bg-'));
    expect(ground.map((task) => task.layerId)).toEqual(['bg-a']);
  });
});

describe('preview reveal tempo', () => {
  it('gives a draw on a crowded page long enough to see the marquee travel', () => {
    // The reference's schedule bottoms out at 90ms on a busy page — two frames —
    // which is why the drag used to be invisible. The floor is raised, and the
    // slowdown applies on top of it.
    const plan = planPreviewReveal(blueprint(
      Array.from({ length: 20 }, (_, index) => ({
        ...layer, id: `card-${index}`, kind: 'rect' as const,
        x: 16 + (index % 4) * 190, y: 16 + Math.floor(index / 4) * 120, w: 180, h: 96,
      })),
    ));
    const draws = plan.tasks.filter((task) => task.action === 'draw');
    expect(draws.length).toBeGreaterThan(0);
    // Worst case: still a visible gesture, and above the reference's floor.
    expect(Math.min(...draws.map((task) => task.durationMs))).toBeGreaterThan(100);
  });

  it('paces the build at 1.15x the reference, relative rhythm intact', () => {
    // The tempo formula is the reference's own; only the constant moves.
    expect(revealTempo(0, 6)).toBe(2.1);
    expect(revealTempo(30, 6)).toBeCloseTo(4.6 > 4.5 ? 4.5 : 4.6, 5);
    expect(revealTempo(1000, 6)).toBe(4.5);
    expect(SLOWDOWN).toBe(1.15);

    // A single idle card. Expected value is computed from the same two public
    // inputs the planner uses, so this asserts the pacing rather than a magic
    // number: reference schedule / reference tempo, then 15% longer.
    const plan = planPreviewReveal(blueprint([{ ...layer, id: 'one', kind: 'rect', x: 10, y: 10, w: 180, h: 96 }]));
    const draw = plan.tasks.find((task) => task.layerId === 'one');
    const expected = Math.round(SLOWDOWN * (260 / revealTempo(1, 6)));
    expect(draw?.durationMs).toBe(expected);
    // And that really is a hair slower than the reference, not slower in general.
    expect(expected).toBeGreaterThan(260 / revealTempo(1, 6));
  });
});

describe('preview reveal swarm', () => {
  it('writes the live size on a growing box and keeps the original arrow', () => {
    expect(formatRevealSize(180.4, 96.2)).toBe('180 × 96');
    expect(REVEAL_ARROW_HOTSPOT).toEqual({ x: 5, y: 3.5 });
    expect(REVEAL_ARROW_PATH.startsWith('M4.6 3.9')).toBe(true);
    expect(REVEAL_AGENTS.map((agent) => agent.color)).toEqual([
      '#0D99FF', '#F24E1E', '#A259FF', '#0ACF83', '#FFC700', '#1ABCFE',
      '#0D99FF', '#F24E1E', '#A259FF', '#0ACF83', '#FFC700',
    ]);
    const mid = revealLayerFrame({
      layer: { x: 10, y: 20, w: 200, h: 100 },
      master: null,
      action: 'draw',
      startMs: 0,
      durationMs: 500,
      now: 250,
    });
    expect(mid.w).toBeLessThan(200);
    expect(mid.h).toBeLessThan(100);
    expect(mid.showChrome).toBe(true);
    expect(mid.sizeLabel).toBe(`${Math.round(mid.w)} × ${Math.round(mid.h)}`);
  });

  it('flies the swarm to the pointer and keeps each arrow on its own path', () => {
    const anchor = { x: 400, y: 300 };
    const state = createFlockState(anchor, REVEAL_AGENTS.length);
    expect(state.cursors).toHaveLength(INTRO_AGENTS);
    expect(state.cursors.filter((cursor) => cursor.home)).toHaveLength(MIN_AGENTS);
    expect(new Set(state.cursors.map((cursor) => cursor.orbit)).size).toBeGreaterThan(6);
    expect(new Set(state.cursors.map((cursor) => cursor.speed)).size).toBeGreaterThan(6);

    const pointer = { x: 120, y: 300 };
    const started = state.cursors.map((cursor) => Math.hypot(cursor.x - pointer.x, cursor.y - pointer.y));
    for (let step = 0; step < 240; step += 1) {
      stepFlock({ state, dt: 1 / 60, time: step * 16, pointer, track: stillTrack(), pointerSpeed: 0, pending: 0, anchor, work: () => null, phase: 'flock' });
    }
    const ended = state.cursors.map((cursor) => Math.hypot(cursor.x - pointer.x, cursor.y - pointer.y));
    const before = started.reduce((sum, value) => sum + value, 0) / started.length;
    const after = ended.reduce((sum, value) => sum + value, 0) / ended.length;
    expect(after).toBeLessThan(before * 0.72);
    expect(Math.min(...ended)).toBeGreaterThan(20);
    expect(new Set(state.cursors.map((cursor) => `${Math.round(cursor.x)}:${Math.round(cursor.y)}`)).size).toBeGreaterThan(8);
    expect(state.cursors.some((cursor) => Math.abs(cursor.angle) > 12)).toBe(true);
  });

  it('gathers on the anchor when the pointer is away', () => {
    const anchor = { x: 300, y: 260 };
    const state = createFlockState({ x: 900, y: 600 }, REVEAL_AGENTS.length);
    for (let step = 0; step < 300; step += 1) {
      stepFlock({ state, dt: 1 / 60, time: step * 16, pointer: null, track: stillTrack(), pointerSpeed: 0, pending: 0, anchor, work: () => null, phase: 'flock' });
    }
    const live = state.cursors;
    const centre = live.reduce(
      (acc, cursor) => ({ x: acc.x + cursor.x / live.length, y: acc.y + cursor.y / live.length }),
      { x: 0, y: 0 },
    );
    expect(Math.hypot(centre.x - anchor.x, centre.y - anchor.y)).toBeLessThan(140);
  });

  it('never shows the marquee and the content at the same time', () => {
    for (const action of ['draw', 'type', 'sweep'] as const) {
      for (let step = 0; step <= 20; step += 1) {
        const frame = revealLayerFrame({
          layer: { x: 0, y: 0, w: 120, h: 60 },
          master: null,
          action,
          startMs: 0,
          durationMs: 500,
          now: (step / 20) * 500,
        });
        // A box is either still being dragged (chrome, no content) or showing its
        // content (no chrome). Both at once is the bug the user reported.
        expect(frame.showChrome && frame.fillOpacity > 0).toBe(false);
        if (action === 'type') {
          expect(frame.showChrome && frame.typed > 0).toBe(false);
        }
      }
    }
  });

  it('keeps a thin crew building and fills back up for the finale', () => {
    expect(flockTarget(0, 0, 'build')).toBe(MIN_AGENTS);
    // Speed and backlog both grow the crew, but neither saturates it.
    expect(flockTarget(400, 10, 'build')).toBe(MIN_AGENTS + 4 + 1);
    expect(flockTarget(100000, 1000, 'build')).toBe(MAX_AGENTS);
    expect(flockTarget(0, 0, 'flock')).toBe(FLOCK_AGENTS);
    // The ceiling is deliberately far below the reference's 48: a short build
    // curtain reads as noise with that many arrows on screen.
    expect(MAX_AGENTS).toBeLessThanOrEqual(24);
    expect(MIN_AGENTS).toBeLessThan(INTRO_AGENTS);

    const anchor = { x: 300, y: 300 };
    const state = createFlockState(anchor, REVEAL_AGENTS.length);
    // A busy build grows the crew, never past the original ceiling.
    for (let step = 0; step < 90; step += 1) {
      stepFlock({ state, dt: 1 / 60, time: step * 16, pointer: anchor, track: stillTrack(), pointerSpeed: 2400, pending: 40, anchor, work: () => null, phase: 'build' });
    }
    const grown = state.cursors.filter((cursor) => cursor.leaving === 0).length;
    expect(grown).toBeGreaterThan(MIN_AGENTS);
    expect(grown).toBeLessThanOrEqual(MAX_AGENTS);

    // An idle build sheds everyone who is not home crew.
    for (let step = 0; step < 400; step += 1) {
      stepFlock({ state, dt: 1 / 60, time: step * 16, pointer: null, track: stillTrack(), pointerSpeed: 0, pending: 0, anchor, work: () => null, phase: 'build' });
    }
    expect(state.cursors.filter((cursor) => cursor.leaving === 0).length).toBeGreaterThanOrEqual(MIN_AGENTS);
    expect(state.cursors.filter((cursor) => cursor.leaving === 0).length).toBeLessThan(INTRO_AGENTS + 1);

    // The finale refills to exactly FLOCK_AGENTS.
    for (let step = 0; step < 400; step += 1) {
      stepFlock({ state, dt: 1 / 60, time: step * 16, pointer: null, track: stillTrack(), pointerSpeed: 0, pending: 0, anchor, work: () => null, phase: 'flock' });
    }
    expect(state.cursors.filter((cursor) => cursor.leaving === 0).length).toBe(FLOCK_AGENTS);
  });
});

describe('preview reveal autoplay', () => {
  const ready = {
    streamingEnded: true,
    active: true,
    blocked: false,
    previewReady: true,
    reducedMotion: false,
  };

  it('plays once when a run has just finished onto a ready preview', () => {
    expect(shouldQueuePreviewRevealAutoplay(ready)).toBe(true);
    expect(shouldQueuePreviewRevealAutoplay({ ...ready, streamingEnded: false })).toBe(false);
    expect(shouldQueuePreviewRevealAutoplay({ ...ready, reducedMotion: true })).toBe(false);
    expect(shouldQueuePreviewRevealAutoplay({ ...ready, blocked: true })).toBe(false);
    expect(claimPreviewRevealAutoplay('project/a.html/1')).toBe(true);
    expect(claimPreviewRevealAutoplay('project/a.html/1')).toBe(false);
    expect(claimPreviewRevealAutoplay('project/a.html/2')).toBe(true);
  });
});

describe('preview reveal bridge', () => {
  it('measures the first screen and marks repeated siblings as copies', async () => {
    const previousRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function rect() {
      const node = this as HTMLElement;
      const x = Number(node.dataset.x ?? 0);
      const y = Number(node.dataset.y ?? 0);
      const w = Number(node.dataset.w ?? 0);
      const h = Number(node.dataset.h ?? 0);
      return {
        x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h,
        toJSON() { return this; },
      };
    };
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    document.body.innerHTML = `
      <h1 data-x="24" data-y="20" data-w="180" data-h="40" style="font-size:32px">Northwind</h1>
      <div data-x="24" data-y="80" data-w="160" data-h="90" style="background:#eee;border-radius:12px"></div>
      <div data-x="200" data-y="80" data-w="160" data-h="90" style="background:#eee;border-radius:12px"></div>
      <img data-x="24" data-y="190" data-w="80" data-h="80" alt="" src="https://example.test/a.png" />
      <p data-x="24" data-y="700" data-w="120" data-h="24">Below</p>
    `;
    const messages: unknown[] = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === PREVIEW_REVEAL_RESPONSE_TYPE) messages.push(event.data);
    };
    window.addEventListener('message', onMessage);
    const source = buildPreviewRevealBridge().replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    window.eval(source);
    window.postMessage({ type: PREVIEW_REVEAL_REQUEST_TYPE, version: 1, id: 'shot-1' }, '*');
    const started = Date.now();
    while (messages.length === 0 && Date.now() - started < 500) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    window.removeEventListener('message', onMessage);
    Element.prototype.getBoundingClientRect = previousRect;

    const shot = messages[0] as { id: string; layers: Array<{ kind: string; text?: string; group: string | null; master: boolean; y: number }> };
    expect(shot.id).toBe('shot-1');
    expect(shot.layers.some((item) => item.kind === 'text' && item.text === 'Northwind')).toBe(true);
    expect(shot.layers.some((item) => item.kind === 'image')).toBe(true);
    expect(shot.layers.some((item) => item.y >= 600)).toBe(false);
    const copies = shot.layers.filter((item) => item.group);
    expect(copies.length).toBeGreaterThanOrEqual(2);
    expect(copies.some((item) => item.master)).toBe(true);
  });
});

describe('PreviewRevealStage', () => {
  it('leaves the page when the viewer skips', () => {
    const onSkip = () => { skipped = true; };
    let skipped = false;
    render(
      <PreviewRevealStage
        blueprint={blueprint([{ ...layer, id: 'title', kind: 'text', x: 10, y: 10, w: 80, h: 24, text: 'Hi' }])}
        labels={{ skip: 'Skip', status: 'Assembling' }}
        pointer={staticPointer()}
        onDone={() => undefined}
        onSkip={onSkip}
      />,
    );
    fireEvent.click(screen.getByTestId('preview-reveal-skip'));
    expect(skipped).toBe(true);
    expect(screen.getByTestId('preview-reveal-cursor-layout')).toBeTruthy();
    expect(screen.getByTestId('preview-reveal-cursor-type')).toBeTruthy();
    expect(screen.getByTestId('preview-reveal-cursor-color')).toBeTruthy();
  });
});

describe('preview reveal finale', () => {
  it('reserves a converge phase after the last gesture and before the end', () => {
    const plan = planPreviewReveal(blueprint([
      { ...layer, id: 'title', kind: 'text', x: 10, y: 10, w: 180, h: 40, text: 'Northwind' },
      { ...layer, id: 'card', kind: 'rect', x: 10, y: 60, w: 180, h: 90 },
    ]));
    expect(plan.convergeMs).toBeGreaterThan(plan.buildMs);
    expect(plan.durationMs).toBeGreaterThan(plan.convergeMs);
    expect(previewRevealPhaseAt(plan, 0)).toBe('build');
    expect(previewRevealPhaseAt(plan, plan.buildMs)).toBe('flock');
    expect(previewRevealPhaseAt(plan, plan.convergeMs)).toBe('converge');
    expect(previewRevealConvergeAt(plan, plan.buildMs)).toBe(0);
    expect(previewRevealConvergeAt(plan, plan.convergeMs + (plan.durationMs - plan.convergeMs) / 2)).toBeCloseTo(0.5, 1);
    expect(previewRevealConvergeAt(plan, plan.durationMs)).toBe(1);
  });

  it('folds the whole crew into the converge point and leaves one arrow standing', () => {
    const anchor = { x: 400, y: 300 };
    const convergeAt = { x: 500, y: 340 };
    const state = createFlockState(anchor, REVEAL_AGENTS.length);
    for (let step = 0; step < 120; step += 1) {
      stepFlock({ state, dt: 1 / 60, time: step * 16, pointer: null, track: stillTrack(), pointerSpeed: 0, pending: 0, anchor, work: () => null, phase: 'flock' });
    }
    const before = state.cursors.filter((cursor) => cursor.leaving === 0);
    const spreadBefore = Math.max(...before.map((cursor) => Math.hypot(cursor.x - convergeAt.x, cursor.y - convergeAt.y)));

    for (let step = 0; step < 120; step += 1) {
      stepFlock({
        state,
        dt: 1 / 60,
        time: 2000 + step * 16,
        pointer: null,
        track: stillTrack(),
        pointerSpeed: 0,
        pending: 0,
        anchor,
        convergeAt,
        work: () => null,
        phase: 'converge',
        converge: step / 119,
      });
    }
    const after = state.cursors.filter((cursor) => cursor.leaving === 0);
    const spreadAfter = after.length === 0
      ? 0
      : Math.max(...after.map((cursor) => Math.hypot(cursor.x - convergeAt.x, cursor.y - convergeAt.y)));
    expect(spreadAfter).toBeLessThan(spreadBefore);
    expect(after.length).toBeLessThan(before.length);
    // Nothing may be spawned behind the merge, or the knot would never close.
    expect(state.cursors.filter((cursor) => cursor.leaving === 0).length).toBeLessThanOrEqual(FLOCK_AGENTS);
  });
});

describe('preview reveal companion', () => {
  const bounds = { width: 800, height: 600 };

  it('rests beside the pointer, outside the ring that would shove it', () => {
    const state = createCompanion({ x: 400, y: 300 }, bounds);
    expect(Math.hypot(COMPANION_REST.x, COMPANION_REST.y)).toBeGreaterThan(48);
    for (let step = 0; step < 180; step += 1) {
      stepCompanion({ state, track: stillTrack(), dt: 1 / 60, time: step * 16, pointer: { x: 400, y: 300 }, bounds });
    }
    const distance = Math.hypot(state.x - 400, state.y - 300);
    // Settled just outside the ring, and never inside it.
    expect(distance).toBeGreaterThanOrEqual(48);
    expect(distance).toBeLessThan(90);
  });

  it('follows the pointer instead of being left behind', () => {
    const state = createCompanion({ x: 400, y: 300 }, bounds);
    for (let step = 0; step < 60; step += 1) {
      stepCompanion({ state, track: stillTrack(), dt: 1 / 60, time: step * 16, pointer: { x: 400, y: 300 }, bounds });
    }
    const moved = { x: 600, y: 200 };
    for (let step = 0; step < 180; step += 1) {
      stepCompanion({ state, track: stillTrack(), dt: 1 / 60, time: 1000 + step * 16, pointer: moved, bounds });
    }
    expect(Math.hypot(state.x - moved.x, state.y - moved.y)).toBeLessThan(90);
  });

  it('gets knocked away by the pointer and springs back', () => {
    const state = createCompanion({ x: 400, y: 300 }, bounds);
    for (let step = 0; step < 180; step += 1) {
      stepCompanion({ state, track: stillTrack(), dt: 1 / 60, time: step * 16, pointer: { x: 400, y: 300 }, bounds });
    }
    const rest = { x: state.x, y: state.y };

    // The pointer arrives on top of it: the ring shoves it out, one click deep.
    const stamp = { x: rest.x, y: rest.y };
    let knocked = false;
    for (let step = 0; step < 4; step += 1) {
      const frame = stepCompanion({ state, track: stillTrack(), dt: 1 / 60, time: 4000 + step * 16, pointer: stamp, bounds });
      knocked = knocked || frame.knocked;
    }
    expect(knocked).toBe(true);
    expect(Math.hypot(state.x - stamp.x, state.y - stamp.y)).toBeGreaterThanOrEqual(48);
    expect(state.press).toBeGreaterThan(0);

    // Released, it comes straight back to rest beside the pointer.
    for (let step = 0; step < 240; step += 1) {
      stepCompanion({ state, track: stillTrack(), dt: 1 / 60, time: 5000 + step * 16, pointer: { x: 400, y: 300 }, bounds });
    }
    expect(Math.hypot(state.x - rest.x, state.y - rest.y)).toBeLessThan(40);
  });

  it('stays inside the preview no matter how hard it is thrown', () => {
    const state = createCompanion({ x: 795, y: 595 }, bounds);
    state.vx = 9000;
    state.vy = 9000;
    for (let step = 0; step < 240; step += 1) {
      stepCompanion({ state, track: stillTrack(), dt: 1 / 60, time: step * 16, pointer: { x: 799, y: 599 }, bounds });
    }
    expect(state.x).toBeLessThanOrEqual(bounds.width);
    expect(state.y).toBeLessThanOrEqual(bounds.height);
  });

  it('bounces harder when the pointer is closing on it than when it creeps', () => {
    // The reference's bounce is relative to the pointer's own velocity, so a
    // sweep through the cursor must throw it further than a slow drift.
    const fling = (pointerSpeed: number) => {
      const state = createCompanion({ x: 400, y: 340 }, bounds);
      const rest = { x: 366, y: 300 };
      for (let step = 0; step < 120; step += 1) {
        stepCompanion({ state, track: stillTrack(), dt: 1 / 60, time: step * 16, pointer: rest, bounds });
      }
      const track = createPressTrack();
      // Travelling up-right, i.e. straight through the cursor from the pointer's
      // own side, so the ring normal has a real direction.
      track.velocity.x = pointerSpeed;
      track.velocity.y = -pointerSpeed;
      // Land the pointer just inside the ring of where the cursor has settled.
      const pointer = { x: state.x - 20, y: state.y + 20 };
      stepCompanion({ state, track, dt: 1 / 60, time: 3000, pointer, bounds });
      return Math.hypot(state.vx, state.vy);
    };
    expect(fling(1800)).toBeGreaterThan(fling(200));
  });
});

describe('preview reveal scale mapping', () => {
  it('scales the surface uniformly, never stretching type', () => {
    // The regression: a per-axis scale stretched type whenever the stage and the
    // blueprint disagreed on aspect ratio (measured `scale(0.797, 1.049)`), so a
    // headline the page renders cleanly came out condensed and tall.
    const blueprintBox = { width: 740, height: 812 };
    const stage = { width: 1200, height: 1000 };
    const scale = uniformScale(blueprintBox, stage);
    // One number, and it fits inside both axes.
    expect(scale * blueprintBox.width).toBeLessThanOrEqual(stage.width + 0.001);
    expect(scale * blueprintBox.height).toBeLessThanOrEqual(stage.height + 0.001);
    // A square on the surface stays square on screen.
    expect(scale * blueprintBox.width).toBeCloseTo(scale * blueprintBox.width, 10);
    // It is the limiting axis, not an average of the two.
    expect(scale).toBe(Math.min(stage.width / 740, stage.height / 812));
  });

  it('maps the pointer through the same uniform scale and the letterbox', () => {
    const blueprintBox = { width: 740, height: 812 };
    const stage = { width: 1200, height: 1000 };
    const scale = uniformScale(blueprintBox, stage);
    // The stage centre is the surface centre, whatever the letterbox is.
    const centre = toBlueprintSpace({ x: stage.width / 2, y: stage.height / 2 }, stage, blueprintBox);
    expect(centre?.x).toBeCloseTo(blueprintBox.width / 2, 6);
    expect(centre?.y).toBeCloseTo(blueprintBox.height / 2, 6);
    // `scale` enlarges the surface onto the stage, so going the other way —
    // stage pixels back to surface units — divides by it.
    const offset = 100;
    const mapped = toBlueprintSpace({ x: stage.width / 2 + offset, y: stage.height / 2 }, stage, blueprintBox);
    expect(mapped?.x).toBeCloseTo(blueprintBox.width / 2 + offset / scale, 6);
    expect(mapped?.y).toBeCloseTo(blueprintBox.height / 2, 6);
    // And it is a true inverse: applying the same factor lands back on the offset.
    expect((mapped!.x - blueprintBox.width / 2) * scale).toBeCloseTo(offset, 6);
  });

  it('draws on a surface the size the blueprint was measured at', () => {
    // The regression: the crew and the box clones are measured in the iframe's
    // viewport, so drawing them straight onto a stage that has since been
    // resized paints the page's own artwork at its old pixel size and it shows
    // up multiplied. The surface has to carry the blueprint's dimensions.
    const view = blueprint([{ ...layer, id: 'shot', kind: 'image', x: 0, y: 0, w: 432, h: 290 }]);
    render(
      <PreviewRevealStage
        blueprint={view}
        labels={{ skip: 'Skip', status: 'Assembling' }}
        pointer={staticPointer()}
        onDone={() => undefined}
        onSkip={() => undefined}
      />,
    );
    const stage = screen.getByTestId('preview-reveal');
    // The drawing surface is the stage's second child, after the curtain.
    const surface = stage.children[1] as HTMLElement;
    expect(surface).toBeTruthy();
    // 800x600 is this blueprint's viewport; the surface is that exact box and
    // is scaled onto the stage, so the layer stays in blueprint units.
    expect(surface.style.width).toBe('800px');
    expect(surface.style.height).toBe('600px');
    expect(surface.style.transform).toContain('scale(');
  });
});

describe('preview reveal gesture easing', () => {
  it('spreads the drag across the whole beat instead of front-loading it', () => {
    // A box used `easeOut`, which is ~70% of the way open at a third of the
    // duration — the marquee looked like it snapped and then crawled.
    const at = (fraction: number) => easeGesture(fraction);
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(1);
    expect(at(0.5)).toBeCloseTo(0.5, 5);
    // Neither half runs away with the travel.
    expect(at(1 / 3)).toBeLessThan(0.4);
    expect(at(2 / 3)).toBeGreaterThan(0.6);
  });

  it('draws a box monotonically so the marquee never jumps backwards', () => {
    let previous = -1;
    for (let step = 0; step <= 24; step += 1) {
      const frame = revealLayerFrame({
        layer: { x: 10, y: 20, w: 200, h: 100 },
        master: null,
        action: 'draw',
        startMs: 0,
        durationMs: 600,
        now: (step / 24) * 600,
      });
      expect(frame.w).toBeGreaterThanOrEqual(previous);
      previous = frame.w;
    }
  });
});

describe('preview reveal crew invariant', () => {
  it('never lets the floor drop below the cursors that draw', () => {
    // A cursor may only take a task while it is home crew, and home crew is the
    // minimum population. If the floor ever falls under the drawing roster, a
    // cursor holding a box gets culled and the box stalls half-drawn.
    const drawing = REVEAL_AGENTS.filter((agent) => agent.works).length;
    expect(MIN_AGENTS).toBeGreaterThanOrEqual(drawing);
    expect(MIN_AGENTS).toBeLessThan(INTRO_AGENTS);
    expect(INTRO_AGENTS).toBeLessThanOrEqual(FLOCK_AGENTS);
    expect(FLOCK_AGENTS).toBeLessThanOrEqual(MAX_AGENTS);
  });

  it('keeps home crew on everyone who could be handed a task', () => {
    // Cursors with a role but no `works` flag only orbit for colour; they never
    // take a task and are free to be culled. The ones that *can* be handed a box
    // must be home crew, or a cull would strand a half-drawn box.
    const state = createFlockState({ x: 300, y: 300 }, REVEAL_AGENTS.length);
    const workers = state.cursors.filter((cursor) => {
      const agent = cursor.agent >= 0 ? REVEAL_AGENTS[cursor.agent] : undefined;
      return agent?.works === true;
    });
    expect(workers.length).toBeGreaterThan(0);
    for (const cursor of workers) expect(cursor.home).toBe(true);
  });
});

describe('preview reveal text sizing', () => {
  it('never scales a text clone, because the bridge already sized it', () => {
    // The regression: the bridge multiplies font-size by the page's own stage
    // scale and measures boxes with `getBoundingClientRect`, so a layer's `style`
    // string is already expressed in the overlay's coordinate space. Adding a
    // transform on top applied that scale a second time — on a page whose stage
    // is scaled to 0.158, 9px type painted at 1.4px.
    render(
      <RevealText
        className={undefined}
        styleText="font-size:18px;white-space:nowrap"
        html=""
        fallback="Hello"
        typed={1}
      />,
    );
    const styled = Array.from(document.querySelectorAll('div')).find(
      (el) => el.getAttribute('style')?.includes('font-size'),
    ) as HTMLElement | undefined;
    expect(styled).toBeTruthy();
    // The bridge's own sizes survive verbatim...
    expect(styled!.style.fontSize).toBe('18px');
    // ...and nothing re-scales them.
    expect(styled!.style.transform).toBe('');
  });
});

describe('preview reveal text clone scaling', () => {
  /**
   * Run the real bridge over a document and return the parsed blueprint.
   * `rect` is faked so an element can claim a painted size independent of its
   * layout size — that is exactly how a scaled page looks from inside.
   */
  async function snapshot(
    html: string,
    sizes: Record<string, { layout: number; painted: number }>,
  ): Promise<{ layers: Array<{ kind: string; text: string; style: string; scale: number }> }> {
    const previousRect = Element.prototype.getBoundingClientRect;
    const previousOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Element.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
      const id = this.dataset.probe;
      const entry = id ? sizes[id] : undefined;
      const painted = entry ? entry.painted : 100;
      return {
        x: 10, y: 10, left: 10, top: 10, right: 10 + painted, bottom: 40,
        width: painted, height: 30, toJSON() { return this; },
      };
    };
    // Layout width drives `scaleOf`'s ratio; a scaled page reports a bigger one.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        const id = this.dataset.probe;
        return id && sizes[id] ? sizes[id].layout : 100;
      },
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    document.body.innerHTML = html;

    const messages: unknown[] = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === PREVIEW_REVEAL_RESPONSE_TYPE) messages.push(event.data);
    };
    window.addEventListener('message', onMessage);
    const source = buildPreviewRevealBridge().replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    window.eval(source);
    window.postMessage({ type: PREVIEW_REVEAL_REQUEST_TYPE, version: 1, id: 'scale-probe' }, '*');
    const started = Date.now();
    while (messages.length === 0 && Date.now() - started < 500) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    window.removeEventListener('message', onMessage);
    Element.prototype.getBoundingClientRect = previousRect;
    if (previousOffset) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', previousOffset);
    return messages[0] as { layers: Array<{ kind: string; text: string; style: string; scale: number }> };
  }

  /** Pull `prop` out of a clone's inline style string. */
  function declared(style: string, prop: string): string | null {
    const match = new RegExp(`(?:^|;)${prop}:([^;]*)`).exec(style);
    return match ? match[1]!.trim() : null;
  }

  it('scales ANY property whose computed value is a px length', async () => {
    // These properties are deliberately ones nobody listed before: if the rule
    // ever regresses to a name whitelist again, this fails.
    const shot = await snapshot(
      `<p data-probe="t" style="font-size:20px;line-height:70px;text-indent:40px;word-spacing:12px;outline-offset:8px;stroke-width:2px">Scaled probe</p>`,
      { t: { layout: 200, painted: 100 } },
    );
    const layer = shot.layers.find((item) => item.kind === 'text');
    expect(layer).toBeDefined();
    // scale = painted / layout = 0.5
    expect(layer!.scale).toBeCloseTo(0.5, 5);
    expect(declared(layer!.style, 'font-size')).toBe('10px');
    // The property that caused this whole rewrite.
    expect(declared(layer!.style, 'line-height')).toBe('35px');
    // Longhands nobody has ever named in this file.
    expect(declared(layer!.style, 'text-indent')).toBe('20px');
    expect(declared(layer!.style, 'word-spacing')).toBe('6px');
    expect(declared(layer!.style, 'outline-offset')).toBe('4px');
    // A px length on an inline-SVG text property, which is likewise unnamed
    // elsewhere: the rule is positional, not a list of remembered names.
    expect(declared(layer!.style, 'stroke-width')).toBe('1px');
  });

  it('leaves keywords, ratios and zero lengths alone', async () => {
    const shot = await snapshot(
      `<p data-probe="t" style="font-size:20px;line-height:1.5;font-weight:700;letter-spacing:0px">Pass through</p>`,
      { t: { layout: 200, painted: 100 } },
    );
    const layer = shot.layers.find((item) => item.kind === 'text');
    expect(layer).toBeDefined();
    // A unitless ratio is scale-invariant, so it must survive untouched.
    expect(declared(layer!.style, 'line-height')).toBe('1.5');
    // A keyword stays a keyword.
    expect(declared(layer!.style, 'font-weight')).toBe('700');
    // Zero is zero at any scale, and keeps its unit.
    expect(declared(layer!.style, 'letter-spacing')).toBe('0px');
  });

  it('keeps an explicit normal line-height instead of inheriting the ancestor\'s', async () => {
    // 'normal' is a real instruction on line-height, not a no-op: inside a
    // `line-height:1.75` ancestor the page's own text is 13px, but a clone that
    // dropped the declaration inherited 17.5px instead. Dropping it would be the
    // same class of silent divergence this rewrite exists to remove.
    const shot = await snapshot(
      `<div style="line-height:1.75"><p data-probe="t" style="font-size:10px;line-height:normal">Normal</p></div>`,
      { t: { layout: 200, painted: 100 } },
    );
    const layer = shot.layers.find((item) => item.kind === 'text');
    expect(layer).toBeDefined();
    expect(declared(layer!.style, 'line-height')).toBe('normal');
  });

  it('keeps the clone style inside the transport budget', async () => {
    // The generic sweep copies far more than the old 34-property list did. The
    // protocol truncates `style` at 2400 characters, so an unfiltered sweep
    // silently loses the tail of the declaration block.
    const shot = await snapshot(
      `<p data-probe="t" style="font-size:20px;line-height:70px">Budget</p>`,
      { t: { layout: 200, painted: 100 } },
    );
    const layer = shot.layers.find((item) => item.kind === 'text');
    expect(layer).toBeDefined();
    expect(layer!.style.length).toBeLessThan(2_400);
  });
});

describe('preview reveal as the generation surface', () => {
  const stageProps = {
    labels: { skip: 'Skip', status: 'Assembling' },
    pointer: staticPointer(),
  };

  it('circles the crew while a page is being generated', () => {
    render(
      <PreviewRevealWorking
        sessionKey="project/a.html/1"
        pointer={staticPointer()}
        reducedMotion={false}
      />,
    );
    const surface = screen.getByTestId('preview-reveal-working');
    expect(surface).toBeTruthy();
    // It is a live region that says work is happening, not a decorative image.
    expect(surface.getAttribute('role')).toBe('status');
    expect(surface.getAttribute('aria-busy')).toBe('true');
    // and it carries a pool of arrows to animate.
    expect(surface.querySelectorAll('[data-working-cursor]').length).toBeGreaterThan(0);
  });

  it('shows the crew, not a skeleton, while the run is streaming', () => {
    // The whole point of the change: generation and the reveal are one surface,
    // so a streaming run renders the crew instead of a wireframe placeholder.
    const frameRef = { current: null } as RefObject<HTMLIFrameElement | null>;
    render(
      <PreviewRevealHost
        active
        blocked={false}
        streaming
        previewReady={false}
        sessionKey="project/a.html/1"
        frameRef={frameRef}
      />,
    );
    expect(screen.getByTestId('preview-reveal-working')).toBeTruthy();
    // The build stage is a later act; it must not be up yet.
    expect(screen.queryByTestId('preview-reveal')).toBeNull();
  });

  it('stands down entirely when the preview is not the active surface', () => {
    const frameRef = { current: null } as RefObject<HTMLIFrameElement | null>;
    render(
      <PreviewRevealHost
        active={false}
        blocked={false}
        streaming
        previewReady={false}
        sessionKey="project/a.html/1"
        frameRef={frameRef}
      />,
    );
    expect(screen.queryByTestId('preview-reveal-working')).toBeNull();
  });
});

describe('preview reveal handover', () => {
  const frameRef = { current: null } as RefObject<HTMLIFrameElement | null>;
  const host = (over: Partial<{ streaming: boolean; previewReady: boolean; active: boolean }> = {}) => (
    <PreviewRevealHost
      active={over.active ?? true}
      blocked={false}
      streaming={over.streaming ?? false}
      previewReady={over.previewReady ?? true}
      sessionKey="project/a.html/1"
      frameRef={frameRef}
    />
  );

  it('keeps the crew on screen while the stream has ended but the frame is not ready', () => {
    // The gap that would otherwise show nothing: the run is done, the iframe has
    // not finished navigating, so the build stage cannot start. Leaving the crew
    // up makes the two acts continuous.
    const { rerender } = render(host({ streaming: true, previewReady: false }));
    expect(screen.getByTestId('preview-reveal-working')).toBeTruthy();
    rerender(host({ streaming: false, previewReady: false }));
    // Still there: the handover has not happened yet.
    expect(screen.getByTestId('preview-reveal-working')).toBeTruthy();
  });

  it('stands down once the preview is not streaming and nothing is pending', () => {
    render(host({ streaming: false, previewReady: true }));
    expect(screen.queryByTestId('preview-reveal-working')).toBeNull();
    expect(screen.queryByTestId('preview-reveal')).toBeNull();
  });
});

describe('preview reveal patches', () => {
  /**
   * Boot the real bridge, mutate the document, then ask for a patch.
   * Returns the layers the bridge reported as changed.
   */
  async function patchAfter(mutate: () => void) {
    // The bridge arms itself once per window; release any observer a previous
    // case left behind so this document is only watched by one of them.
    const prior = (window as unknown as { __odPreviewRevealObserver?: { disconnect(): void } }).__odPreviewRevealObserver;
    prior?.disconnect();
    delete (window as unknown as { __odPreviewReveal?: boolean }).__odPreviewReveal;
    const previousRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
      const w = Number(this.dataset.w ?? 100);
      const h = Number(this.dataset.h ?? 30);
      return { x: 10, y: 10, left: 10, top: 10, right: 10 + w, bottom: 10 + h, width: w, height: h, toJSON() { return this; } };
    };
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    // Content first, then the bridge: the observer must only see changes that
    // happen while it is running, not the document being built beneath it.
    document.body.innerHTML = `<p data-w="180" data-h="30" style="font-size:20px">Untouched</p><p data-w="180" data-h="30" style="font-size:20px" id="target">Before</p>`;
    const source = buildPreviewRevealBridge().replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    window.eval(source);

    const messages: unknown[] = [];
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === PREVIEW_REVEAL_PATCH_TYPE) messages.push(event.data);
    };
    window.addEventListener('message', onMessage);

    mutate();
    // jsdom delivers mutation records on a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.postMessage({ type: PREVIEW_REVEAL_PATCH_REQUEST_TYPE, version: 1, id: 'patch-1' }, '*');
    const started = Date.now();
    while (messages.length === 0 && Date.now() - started < 500) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    window.removeEventListener('message', onMessage);
    Element.prototype.getBoundingClientRect = previousRect;
    const reply = messages[0] as { id: string; layers: Array<{ kind: string; text: string }> } | undefined;
    return reply;
  }

  it('reports only the elements that changed, not the whole page', async () => {
    // The point of a patch: re-drawing the untouched part of the page would
    // flash work the agent never did.
    const reply = await patchAfter(() => {
      const el = document.getElementById('target');
      if (el) el.textContent = 'After';
    });
    expect(reply).toBeDefined();
    expect(reply!.id).toBe('patch-1');
    expect(reply!.layers.length).toBeGreaterThan(0);
    expect(reply!.layers.length).toBeLessThanOrEqual(PREVIEW_REVEAL_PATCH_CAP);
    expect(reply!.layers.some((layer) => layer.text.includes('After'))).toBe(true);
    // The sibling nobody touched must not be in the patch.
    expect(reply!.layers.some((layer) => layer.text.includes('Untouched'))).toBe(false);
  });

  it('never reports an element that did not change', async () => {
    // Stated as a content assertion rather than "no reply": jsdom keeps every
    // bridge instance from earlier tests observing the document, so a clean
    // batch is not guaranteed. What must hold regardless is that the untouched
    // paragraph never appears as a patch layer.
    const reply = await patchAfter(() => {
      const el = document.getElementById('target');
      if (el) el.textContent = 'OnlyThisChanged';
    });
    expect(reply).toBeDefined();
    expect(reply!.layers.some((layer) => layer.text.includes('Untouched'))).toBe(false);
  });

  it('carries the same shape a full blueprint does', async () => {
    const reply = await patchAfter(() => {
      const el = document.getElementById('target');
      if (el) el.setAttribute('style', 'font-size:24px');
    });
    expect(reply).toBeDefined();
    // Parsed by the same validator, so the renderer can consume it unchanged.
    const parsed = parsePreviewRevealBlueprint(reply);
    expect(parsed).not.toBeNull();
    expect(isPreviewRevealPatch(reply)).toBe(true);
    expect(isPreviewRevealPatch({ type: PREVIEW_REVEAL_RESPONSE_TYPE })).toBe(false);
  });
});

describe('replay button glyph anchoring', () => {
  it('centres the toolbar glyph on its painted ink, not its hot spot', () => {
    // The regression: the toolbar reused the overlay's tip anchor, which shifts
    // the sprite by its hot spot. On a 28x28 viewBox whose ink is centred at
    // (12.85, 11.95) — not (14, 14) — that put the visible arrow 5.3px left and
    // 3.5px above the button centre.
    const { container } = render(
      <CursorGlyph color="#0D99FF" anchor="center" renderedSize={20} />,
    );
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg).toBeTruthy();
    // A centred glyph must not carry the tip's negative hot-spot shift.
    expect(svg.style.transform).not.toContain('-5px, -3.5px');
    // It shifts by the ink-to-viewBox-centre delta, scaled to the 20px box.
    const unit = 20 / 28;
    const expectedX = (14 - 12.85) * unit;
    const expectedY = (14 - 11.95) * unit;
    expect(svg.style.transform).toContain(`translate(${expectedX}px, ${expectedY}px)`);
  });

  it('keeps the tip anchor for overlay cursors', () => {
    // The overlay positions a cursor BY its pointer tip; changing that default
    // would move every arrow and the companion off the point they mark.
    const { container } = render(<CursorGlyph color="#0D99FF" />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.style.transform).toContain('translate(-5px, -3.5px)');
  });
});
