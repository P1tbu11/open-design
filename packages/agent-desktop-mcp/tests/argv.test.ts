import { describe, expect, it } from 'vitest';

import { buildCliArgs, CliArgError, DESKTOP_TOOLS } from '../src/tools.ts';

describe('buildCliArgs', () => {
  it('maps snapshot flags onto the CLI', () => {
    expect(buildCliArgs('snapshot', {
      app: 'Finder',
      windowId: 'w-204749',
      surface: 'window',
      root: '@s8f3k2p9:e3',
      maxDepth: 4,
      timeoutMs: 3000,
      interactiveOnly: true,
      compact: true,
      skeleton: true,
      includeBounds: true,
    })).toEqual([
      'snapshot',
      '--app',
      'Finder',
      '--window-id',
      'w-204749',
      '--surface',
      'window',
      '--root',
      '@s8f3k2p9:e3',
      '--max-depth',
      '4',
      '--timeout-ms',
      '3000',
      '-i',
      '--compact',
      '--skeleton',
      '--include-bounds',
    ]);
  });

  it('omits snapshot flags that are false or absent', () => {
    expect(buildCliArgs('snapshot', { app: 'Figma', interactiveOnly: false })).toEqual([
      'snapshot',
      '--app',
      'Figma',
    ]);
  });

  it('maps click and keeps headed off unless asked', () => {
    expect(buildCliArgs('click', { ref: '@s8f3k2p9:e8' })).toEqual([
      'click',
      '--',
      '@s8f3k2p9:e8',
    ]);
    expect(buildCliArgs('click', { ref: '@s8f3k2p9:e8', headed: true, timeoutMs: 1500 })).toEqual([
      '--headed',
      'click',
      '--timeout-ms',
      '1500',
      '--',
      '@s8f3k2p9:e8',
    ]);
  });

  it('maps the other ref actions', () => {
    expect(buildCliArgs('double-click', { ref: '@s:e1' })[0]).toBe('double-click');
    expect(buildCliArgs('right-click', { ref: '@s:e1' })[0]).toBe('right-click');
    expect(buildCliArgs('clear', { ref: '@s:e1' })).toEqual(['clear', '--', '@s:e1']);
    expect(buildCliArgs('focus', { ref: '@s:e1' })).toEqual(['focus', '--', '@s:e1']);
  });

  it('passes type and set-value text after -- so a leading dash is not a flag', () => {
    expect(buildCliArgs('type', { ref: '@s:e2', text: '-hello', intervalMs: 10 })).toEqual([
      'type',
      '--interval-ms',
      '10',
      '--',
      '@s:e2',
      '-hello',
    ]);
    expect(buildCliArgs('set-value', { ref: '@s:e2', value: 'Notes' })).toEqual([
      'set-value',
      '--',
      '@s:e2',
      'Notes',
    ]);
  });

  it('maps press, scroll, inventory, permissions, and status', () => {
    expect(buildCliArgs('press', { combo: 'cmd+c', app: 'Finder', force: true })).toEqual([
      'press',
      '--app',
      'Finder',
      '--force',
      '--',
      'cmd+c',
    ]);
    expect(buildCliArgs('scroll', { ref: '@s:e4', direction: 'up', amount: 2 })).toEqual([
      'scroll',
      '--direction',
      'up',
      '--amount',
      '2',
      '--',
      '@s:e4',
    ]);
    expect(buildCliArgs('list-apps', { app: 'Figma', timeoutMs: 1000 })).toEqual([
      'list-apps',
      '--app',
      'Figma',
      '--timeout-ms',
      '1000',
    ]);
    expect(buildCliArgs('list-windows', {})).toEqual(['list-windows']);
    expect(buildCliArgs('permissions', { guide: true, request: false })).toEqual([
      'permissions',
      '--guide',
    ]);
    expect(buildCliArgs('status', {})).toEqual(['status']);
  });

  it('rejects unknown tools, missing refs, and unknown arguments before spawn', () => {
    expect(() => buildCliArgs('screenshot', {})).toThrow(CliArgError);
    expect(() => buildCliArgs('click', {})).toThrow(/ref/);
    expect(() => buildCliArgs('snapshot', { headed: true })).toThrow(/Unknown argument/);
    expect(() => buildCliArgs('scroll', { ref: '@s:e1', direction: 'sideways' })).toThrow(/direction/);
  });

  it('exposes the core observe and act tools', () => {
    const names = DESKTOP_TOOLS.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'snapshot',
      'click',
      'type',
      'set-value',
      'list-apps',
      'list-windows',
      'permissions',
      'status',
    ]));
  });
});
