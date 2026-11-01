import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';

const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_MAX_STDOUT = 32 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const KILL_GRACE_MS = 500;

export interface CliSpawnError {
  code?: string;
  message: string;
}

export interface CliRunResult {
  bin: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  termSignal: NodeJS.Signals | null;
  cancelled: boolean;
  started: boolean;
  timedOut: boolean;
  outputTooLarge: boolean;
  spawnError: CliSpawnError | null;
}

export interface RunAgentDesktopOptions {
  bin: string;
  args: string[];
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
}

export function resolveDeadlineMs(override?: number): number {
  if (override !== undefined) return override;
  const raw = process.env.AGENT_DESKTOP_MCP_TIMEOUT_MS;
  if (!raw) return DEFAULT_DEADLINE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600_000) return DEFAULT_DEADLINE_MS;
  return parsed;
}

function emptyResult(bin: string, patch: Partial<CliRunResult>): CliRunResult {
  return {
    bin,
    stdout: '',
    stderr: '',
    exitCode: null,
    termSignal: null,
    cancelled: false,
    started: false,
    timedOut: false,
    outputTooLarge: false,
    spawnError: null,
    ...patch,
  };
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  timer.unref?.();
}

/**
 * Run one agent-desktop command. The child is killed when `signal` aborts or
 * the wrapper deadline fires. A cancel after the process has started does not
 * prove the desktop action was withheld — callers report that as retry unsafe.
 */
export async function runAgentDesktop(options: RunAgentDesktopOptions): Promise<CliRunResult> {
  const bin = options.bin;
  if (options.signal?.aborted) {
    return emptyResult(bin, { cancelled: true, started: false });
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  let outputTooLarge = false;
  let cancelled = false;
  let timedOut = false;
  let spawnError: CliSpawnError | null = null;

  const child = spawn(bin, options.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: options.env ?? process.env,
  });
  const started = true;

  const onAbort = () => {
    cancelled = true;
    stopChild(child);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const deadline = setTimeout(() => {
    timedOut = true;
    stopChild(child);
  }, resolveDeadlineMs(options.timeoutMs));
  deadline.unref?.();

  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;

  child.stdout?.on('data', (chunk: Buffer) => {
    if (outputTooLarge) return;
    if (stdoutSize + chunk.length > maxStdout) {
      outputTooLarge = true;
      stopChild(child);
      return;
    }
    stdoutChunks.push(chunk);
    stdoutSize += chunk.length;
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrSize >= MAX_STDERR) return;
    const room = MAX_STDERR - stderrSize;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    stderrChunks.push(slice);
    stderrSize += slice.length;
  });

  const closed = await new Promise<{ code: number | null; termSignal: NodeJS.Signals | null }>(
    (resolve) => {
      let settled = false;
      const finish = (code: number | null, termSignal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        resolve({ code, termSignal });
      };
      child.once('error', (err: NodeJS.ErrnoException) => {
        spawnError = { message: err.message };
        if (err.code) spawnError.code = err.code;
        finish(null, null);
      });
      child.once('close', (code, termSignal) => {
        finish(code, termSignal);
      });
    },
  );

  clearTimeout(deadline);
  options.signal?.removeEventListener('abort', onAbort);

  return {
    bin,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    exitCode: closed.code,
    termSignal: closed.termSignal,
    cancelled,
    started,
    timedOut,
    outputTooLarge,
    spawnError,
  };
}
