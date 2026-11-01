import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { handleToolCall } from '../src/dispatch.ts';
import { writeFakeAgentDesktop } from './fake-cli.ts';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fakeBin(mode: string): Promise<{ bin: string; env: NodeJS.ProcessEnv }> {
  const bin = await writeFakeAgentDesktop();
  dirs.push(path.dirname(bin));
  return {
    bin,
    env: { ...process.env, FAKE_AGENT_DESKTOP_MODE: mode },
  };
}

describe('handleToolCall', () => {
  it('returns the CLI success envelope and the argv it ran', async () => {
    const { bin, env } = await fakeBin('echo');
    const result = await handleToolCall(
      'click',
      { ref: '@s8f3k2p9:e8', headed: true, timeoutMs: 1500 },
      { bin, env },
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      command: 'click',
      data: { argv: ['--headed', 'click', '--timeout-ms', '1500', '--', '@s8f3k2p9:e8'] },
    });
  });

  it('passes a CLI error envelope through with isError', async () => {
    const { bin, env } = await fakeBin('error-envelope');
    const result = await handleToolCall('click', { ref: '@s8f3k2p9:e8' }, { bin, env });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'STALE_REF',
        disposition: { delivery: 'not_delivered', retry: 'safe' },
      },
    });
  });

  it('does not spawn when arguments are invalid', async () => {
    const result = await handleToolCall('type', { ref: '@s:e1' }, { bin: '/nonexistent/agent-desktop' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        disposition: { delivery: 'not_delivered', retry: 'safe' },
      },
    });
  });

  it('reports a missing CLI without claiming the action was delivered', async () => {
    const result = await handleToolCall('status', {}, { bin: '/nonexistent/agent-desktop' });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'CLI_NOT_FOUND',
        disposition: { delivery: 'not_delivered', retry: 'safe' },
      },
    });
    expect(JSON.stringify(result.structuredContent)).toContain('npm i -g agent-desktop');
  });

  it('returns CANCELLED with an unsafe retry after the process has started', async () => {
    const { bin, env } = await fakeBin('hang');
    const controller = new AbortController();
    const pending = handleToolCall('status', {}, { bin, env, signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      command: 'status',
      error: {
        code: 'CANCELLED',
        disposition: { delivery: 'unknown', retry: 'unsafe' },
      },
    });
  });

  it('returns a safe CANCELLED when aborted before launch', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await handleToolCall('status', {}, {
      bin: '/nonexistent/agent-desktop',
      signal: controller.signal,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'CANCELLED',
        disposition: { delivery: 'not_delivered', retry: 'safe' },
      },
    });
  });

  it('stops a hung CLI at the wrapper deadline', async () => {
    const { bin, env } = await fakeBin('hang');
    const result = await handleToolCall('list-apps', {}, { bin, env, timeoutMs: 200 });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'TIMEOUT',
        disposition: { retry: 'unsafe' },
      },
    });
  });

  it('reports unreadable stdout and oversized output', async () => {
    const garbage = await fakeBin('garbage');
    const unreadable = await handleToolCall('status', {}, garbage);
    expect(unreadable.structuredContent).toMatchObject({
      error: { code: 'UNREADABLE_OUTPUT' },
    });
    expect(JSON.stringify(unreadable.structuredContent)).toContain('cli blew up');

    const flood = await fakeBin('flood');
    const oversized = await handleToolCall('snapshot', { app: 'Finder' }, { ...flood, maxStdoutBytes: 64 });
    expect(oversized.structuredContent).toMatchObject({
      error: { code: 'OUTPUT_TOO_LARGE', disposition: { retry: 'unsafe' } },
    });
  });
});
