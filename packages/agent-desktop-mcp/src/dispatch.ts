import {
  parseEnvelope,
  toToolResult,
  wrapperError,
  type AgentDesktopEnvelope,
  type ToolTextResult,
} from './envelope.ts';
import { runAgentDesktop, type CliRunResult, type RunAgentDesktopOptions } from './run.ts';
import { buildCliArgs, CliArgError } from './tools.ts';

export interface HandleToolOptions {
  signal?: AbortSignal;
  bin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
}

export function resolveAgentDesktopBin(explicit?: string): string {
  const fromExplicit = explicit?.trim();
  if (fromExplicit) return fromExplicit;
  const fromEnv = process.env.AGENT_DESKTOP_BIN?.trim();
  if (fromEnv) return fromEnv;
  return 'agent-desktop';
}

export function interpretRun(command: string, run: CliRunResult): AgentDesktopEnvelope {
  if (run.spawnError) {
    const missing = run.spawnError.code === 'ENOENT';
    return wrapperError(
      command,
      missing
        ? {
            code: 'CLI_NOT_FOUND',
            message: `Could not start "${run.bin}". Install agent-desktop on this desktop (\`npm i -g agent-desktop\`) so it is on PATH, or set AGENT_DESKTOP_BIN.`,
            suggestion:
              'On macOS, grant Accessibility to the app that launches the daemon, then run `agent-desktop permissions`. A cloud VM cannot drive the user\'s GUI.',
            delivery: 'not_delivered',
            retry: 'safe',
          }
        : {
            code: 'SPAWN_FAILED',
            message: run.spawnError.message,
            suggestion: 'Check that the agent-desktop binary is executable on this machine.',
            delivery: 'not_delivered',
            retry: 'safe',
          },
    );
  }

  if (run.outputTooLarge) {
    return wrapperError(command, {
      code: 'OUTPUT_TOO_LARGE',
      message: 'agent-desktop wrote more output than the MCP wrapper will return.',
      suggestion:
        'The action may already have landed. Snapshot with interactiveOnly, compact, or skeleton, or pass a root ref, and read that tree before retrying.',
      delivery: 'unknown',
      retry: 'unsafe',
    });
  }

  const parsed = parseEnvelope(run.stdout);
  if (parsed) return parsed;

  if (run.cancelled) {
    return wrapperError(command, {
      code: 'CANCELLED',
      message: run.started
        ? 'The agent-desktop call was cancelled after the process started. The desktop action may already have been delivered.'
        : 'The agent-desktop call was cancelled before the process started.',
      suggestion: run.started
        ? 'Take a fresh snapshot and read the live UI before any other action. Do not retry blindly.'
        : 'Retry only if the user still wants the action.',
      delivery: run.started ? 'unknown' : 'not_delivered',
      retry: run.started ? 'unsafe' : 'safe',
    });
  }

  if (run.timedOut) {
    return wrapperError(command, {
      code: 'TIMEOUT',
      message: 'The agent-desktop process exceeded the MCP wrapper deadline and was stopped.',
      suggestion:
        'The action may have landed. Snapshot before retrying. Raise AGENT_DESKTOP_MCP_TIMEOUT_MS only when a legitimate wait needs longer than the default 120s.',
      delivery: 'unknown',
      retry: 'unsafe',
    });
  }

  const stderr = run.stderr.trim().slice(0, 2000);
  const exit = run.exitCode === null ? 'none' : String(run.exitCode);
  return wrapperError(command, {
    code: 'UNREADABLE_OUTPUT',
    message: `agent-desktop exited ${exit} without a JSON envelope.`,
    suggestion: stderr
      ? `stderr: ${stderr}`
      : 'Run `agent-desktop version` on this machine and confirm the CLI prints the JSON envelope.',
    delivery: 'unknown',
    retry: 'unsafe',
  });
}

export async function handleToolCall(
  name: string,
  raw: unknown,
  options: HandleToolOptions = {},
): Promise<ToolTextResult> {
  let argv: string[];
  try {
    argv = buildCliArgs(name, raw);
  } catch (err) {
    if (err instanceof CliArgError) {
      return toToolResult(
        wrapperError(name, {
          code: 'INVALID_ARGS',
          message: err.message,
          suggestion:
            'Check the tool arguments. Refs must be snapshot-qualified (@<snapshot_id>:eN).',
          delivery: 'not_delivered',
          retry: 'safe',
        }),
      );
    }
    throw err;
  }

  const runOptions: RunAgentDesktopOptions = {
    bin: resolveAgentDesktopBin(options.bin),
    args: argv,
  };
  if (options.signal) runOptions.signal = options.signal;
  if (options.env) runOptions.env = options.env;
  if (options.timeoutMs !== undefined) runOptions.timeoutMs = options.timeoutMs;
  if (options.maxStdoutBytes !== undefined) runOptions.maxStdoutBytes = options.maxStdoutBytes;

  const run = await runAgentDesktop(runOptions);
  return toToolResult(interpretRun(name, run));
}
