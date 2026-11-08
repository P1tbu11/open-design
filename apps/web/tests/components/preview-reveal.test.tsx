// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPreviewRevealBridge,
  PREVIEW_REVEAL_REQUEST_TYPE,
  PREVIEW_REVEAL_RESPONSE_TYPE,
  type PreviewRevealBlueprint,
} from '@open-design/contracts/runtime/preview-reveal';
import { PreviewRevealStage } from '../../src/components/preview-reveal/PreviewReveal';
import {
  claimPreviewRevealAutoplay,
  planPreviewReveal,
  resetPreviewRevealAutoplayForTests,
  shouldQueuePreviewRevealAutoplay,
} from '../../src/components/preview-reveal/plan';
import { formatRevealSize, REVEAL_AGENTS, REVEAL_ARROW_HOTSPOT, REVEAL_ARROW_PATH, revealLayerFrame } from '../../src/components/preview-reveal/swarm';
import { createFlockState, flockTarget, FLOCK_AGENTS, INTRO_AGENTS, MAX_AGENTS, MIN_AGENTS, stepFlock } from '../../src/components/preview-reveal/flock';

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

  it('leaves a full-width backdrop out so the size numbers land on the pieces', () => {
    const plan = planPreviewReveal(blueprint([
      { ...layer, id: 'band', kind: 'rect', x: 0, y: 160, w: 760, h: 300, fill: 'rgb(0, 0, 0)' },
      { ...layer, id: 'poster', kind: 'image', x: 0, y: 160, w: 760, h: 300 },
      { ...layer, id: 'icon', kind: 'image', x: 44, y: 210, w: 38, h: 45 },
    ]));
    expect(plan.tasks.map((task) => task.layerId)).toEqual(['icon']);
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
      stepFlock({ state, dt: 1 / 60, time: step * 16, pointer, pointerSpeed: 0, pending: 0, anchor, work: () => null, phase: 'flock' });
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
      stepFlock({ state, dt: 1 / 60, time: step * 16, pointer: null, pointerSpeed: 0, pending: 0, anchor, work: () => null, phase: 'flock' });
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

  it('keeps 8..48 alive while building and fills back to 36 for the finale', () => {
    expect(flockTarget(0, 0, 'build')).toBe(MIN_AGENTS);
    expect(flockTarget(400, 10, 'build')).toBe(MIN_AGENTS + 10 + 5);
    expect(flockTarget(100000, 1000, 'build')).toBe(MAX_AGENTS);
    expect(flockTarget(0, 0, 'flock')).toBe(FLOCK_AGENTS);

    const anchor = { x: 300, y: 300 };
    const state = createFlockState(anchor, REVEAL_AGENTS.length);
    // A busy build grows the crew, never past the original ceiling.
    for (let step = 0; step < 90; step += 1) {
      stepFlock({ state, dt: 1 / 60, time: step * 16, pointer: anchor, pointerSpeed: 2400, pending: 40, anchor, work: () => null, phase: 'build' });
    }
    const grown = state.cursors.filter((cursor) => cursor.leaving === 0).length;
    expect(grown).toBeGreaterThan(INTRO_AGENTS);
    expect(grown).toBeLessThanOrEqual(MAX_AGENTS);

    // An idle build sheds everyone who is not home crew.
    for (let step = 0; step < 400; step += 1) {
      stepFlock({ state, dt: 1 / 60, time: step * 16, pointer: null, pointerSpeed: 0, pending: 0, anchor, work: () => null, phase: 'build' });
    }
    expect(state.cursors.filter((cursor) => cursor.leaving === 0).length).toBeGreaterThanOrEqual(MIN_AGENTS);
    expect(state.cursors.filter((cursor) => cursor.leaving === 0).length).toBeLessThan(INTRO_AGENTS + 1);

    // The finale refills to exactly 36.
    for (let step = 0; step < 400; step += 1) {
      stepFlock({ state, dt: 1 / 60, time: step * 16, pointer: null, pointerSpeed: 0, pending: 0, anchor, work: () => null, phase: 'flock' });
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
