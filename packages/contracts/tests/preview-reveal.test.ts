import { describe, expect, it } from 'vitest';

import {
  buildPreviewRevealBridge,
  parsePreviewRevealBlueprint,
  PREVIEW_REVEAL_LAYER_CAP,
  PREVIEW_REVEAL_RESPONSE_TYPE,
} from '../src/runtime/preview-reveal';

const layer = {
  id: 'l0',
  kind: 'rect' as const,
  x: 12,
  y: 24,
  w: 200,
  h: 80,
  radius: 8,
  fill: 'rgb(240, 240, 240)',
  color: 'rgb(17, 17, 17)',
  weight: 400,
  size: 16,
  text: '',
  src: '',
  group: null,
  master: false,
};

describe('parsePreviewRevealBlueprint', () => {
  it('accepts a measured first-screen blueprint', () => {
    const parsed = parsePreviewRevealBlueprint({
      type: PREVIEW_REVEAL_RESPONSE_TYPE,
      version: 1,
      id: 'reveal-1',
      viewport: { width: 800, height: 600 },
      background: 'rgb(255, 255, 255)',
      layers: [layer, { ...layer, id: 'l1', kind: 'text', text: 'Hello', src: 'javascript:alert(1)' }],
    });
    expect(parsed?.requestId).toBe('reveal-1');
    expect(parsed?.layers).toHaveLength(2);
    expect(parsed?.layers[1]?.text).toBe('Hello');
    expect(parsed?.layers[1]?.src).toBe('');
  });

  it('drops hostile colors, extra layers, and unrelated messages', () => {
    const layers = Array.from({ length: PREVIEW_REVEAL_LAYER_CAP + 8 }, (_, index) => ({
      ...layer,
      id: `l${index}`,
      fill: index === 0 ? 'url(https://evil.test/x)' : layer.fill,
    }));
    const parsed = parsePreviewRevealBlueprint({
      type: PREVIEW_REVEAL_RESPONSE_TYPE,
      version: 1,
      id: 'reveal-2',
      viewport: { width: 400, height: 300 },
      background: 'expression(alert(1))',
      layers,
    });
    expect(parsed?.background).toBe('rgb(255, 255, 255)');
    expect(parsed?.layers).toHaveLength(PREVIEW_REVEAL_LAYER_CAP);
    expect(parsed?.layers[0]?.fill).toBe('');
    expect(parsePreviewRevealBlueprint({ type: 'od:preview-scroll' })).toBeNull();
  });
});

describe('buildPreviewRevealBridge', () => {
  it('ships one inert listener the host can wake with a snapshot request', () => {
    const script = buildPreviewRevealBridge();
    expect(script.startsWith('<script data-od-preview-reveal>')).toBe(true);
    expect(script.match(/<\/script>/g)).toHaveLength(1);
    expect(script).toContain('od:preview-reveal-snapshot');
    expect(script).toContain('od:preview-reveal-blueprint');
  });
});
