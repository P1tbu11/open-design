import { describe, expect, it } from 'vitest';

import { parseEnvelope, toToolResult, wrapperError } from '../src/envelope.ts';

const success = {
  version: '2.5',
  ok: true,
  command: 'snapshot',
  data: {
    app: 'Finder',
    snapshot_id: 's8f3k2p9',
    ref_count: 1,
    complete: true,
    tree: { role: 'window', children: [{ ref_id: '@s8f3k2p9:e8', role: 'treeitem' }] },
  },
};

describe('parseEnvelope', () => {
  it('parses a success envelope and a pretty-printed one', () => {
    expect(parseEnvelope(JSON.stringify(success))).toEqual(success);
    expect(parseEnvelope(`${JSON.stringify(success, null, 2)}\n`)).toEqual(success);
  });

  it('parses an error envelope with disposition', () => {
    const error = {
      version: '2.5',
      ok: false,
      command: 'click',
      error: {
        code: 'STALE_REF',
        message: 'gone',
        disposition: { delivery: 'not_delivered', retry: 'safe' },
      },
    };
    expect(parseEnvelope(JSON.stringify(error))).toEqual(error);
  });

  it('accepts a log line before the envelope and ignores non-JSON', () => {
    expect(parseEnvelope(`warning: helper\n${JSON.stringify(success)}`)).toEqual(success);
    expect(parseEnvelope('')).toBeNull();
    expect(parseEnvelope('not json')).toBeNull();
    expect(parseEnvelope('{"ok":"yes"}')).toBeNull();
  });
});

describe('toToolResult', () => {
  it('returns structured success without isError', () => {
    const result = toToolResult(success);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, command: 'snapshot' });
    expect(result.content[0]?.text).toContain('"ok":true');
  });

  it('marks wrapper and CLI failures as tool errors', () => {
    const result = toToolResult(wrapperError('click', {
      code: 'CANCELLED',
      message: 'stopped',
      suggestion: 'snapshot again',
      delivery: 'unknown',
      retry: 'unsafe',
    }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      command: 'click',
      error: {
        code: 'CANCELLED',
        disposition: { delivery: 'unknown', retry: 'unsafe' },
        suggestion: 'snapshot again',
      },
    });
  });
});
