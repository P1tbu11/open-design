import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { writeFakeAgentDesktop } from './fake-cli.ts';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function encode(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function readFrames(child: ChildProcess): { next: () => Promise<unknown> } {
  let buffer = '';
  const queued: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  const push = (message: unknown) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queued.push(message);
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      push(JSON.parse(line) as unknown);
    }
  });
  return {
    next: () => {
      const existing = queued.shift();
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

describe('stdio MCP server', () => {
  it('lists desktop tools and returns a CLI envelope for status', async () => {
    const bin = await writeFakeAgentDesktop();
    dirs.push(path.dirname(bin));
    let stderr = '';
    const child = spawn(process.execPath, [cliPath], {
      env: { ...process.env, AGENT_DESKTOP_BIN: bin, FAKE_AGENT_DESKTOP_MODE: 'echo' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const frames = readFrames(child);
    const take = async () => {
      const message = await Promise.race([
        frames.next(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`timed out waiting for MCP frame\n${stderr}`)), 8000);
        }),
      ]);
      return message as { id?: number; result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } };
    };

    child.stdin?.write(encode({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    }));
    const initialized = await take();
    expect(initialized.id).toBe(1);
    expect(initialized.result).toBeTruthy();

    child.stdin?.write(encode({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    child.stdin?.write(encode({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    const listed = await take();
    const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
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

    child.stdin?.write(encode({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'status', arguments: {} },
    }));
    const called = await take();
    expect(called.id).toBe(3);
    expect(called.result?.isError).toBeUndefined();
    const text = called.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      command: 'status',
      data: { argv: ['status'] },
    });
  }, 15_000);
});
