import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FAKE_CLI = `#!/usr/bin/env node
const mode = process.env.FAKE_AGENT_DESKTOP_MODE || 'echo';
const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith('-')) || args[0] || '';
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'flood') {
  process.stdout.write(Buffer.alloc(1024 * 1024, 97));
  setInterval(() => {}, 1000);
} else if (mode === 'error-envelope') {
  process.stdout.write(JSON.stringify({
    version: '2.5',
    ok: false,
    command,
    error: {
      code: 'STALE_REF',
      message: '@s8f3k2p9:e7 not found in current RefMap',
      suggestion: 'Re-run a snapshot to obtain fresh refs.',
      disposition: { delivery: 'not_delivered', retry: 'safe' },
    },
  }));
  process.exit(1);
} else if (mode === 'garbage') {
  process.stderr.write('cli blew up');
  process.stdout.write('not json');
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({
    version: '2.5',
    ok: true,
    command,
    data: { argv: args },
  }));
}
`;

export async function writeFakeAgentDesktop(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-desktop-mcp-'));
  const bin = path.join(dir, 'agent-desktop');
  await writeFile(bin, FAKE_CLI, 'utf8');
  await chmod(bin, 0o755);
  return bin;
}
