// The agent-desktop CLI prints one JSON envelope on stdout (`ok` plus `data`
// or `error`). The wrapper adds a few codes of its own (CANCELLED,
// CLI_NOT_FOUND, …) in the same shape so a Run can branch on `error.code`
// and `error.disposition` without a special case for transport failures.

export interface AgentDesktopDisposition {
  delivery: string;
  retry: string;
}

export interface AgentDesktopErrorBody {
  code: string;
  message: string;
  suggestion?: string;
  disposition?: AgentDesktopDisposition;
  recovery?: unknown;
  details?: unknown;
}

export interface AgentDesktopEnvelope {
  version?: string;
  ok: boolean;
  command?: string;
  data?: unknown;
  error?: AgentDesktopErrorBody;
}

export interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export interface WrapperErrorInput {
  code: string;
  message: string;
  suggestion?: string;
  delivery: string;
  retry: string;
}

function tryParse(text: string): AgentDesktopEnvelope | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof (value as { ok?: unknown }).ok !== 'boolean') return null;
    return value as AgentDesktopEnvelope;
  } catch {
    return null;
  }
}

/** Parse one CLI envelope. Accepts pretty-printed JSON and a single leading
 * log line before the object. Returns null when stdout is not an envelope. */
export function parseEnvelope(stdout: string): AgentDesktopEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace > 0) {
    const sliced = tryParse(trimmed.slice(firstBrace));
    if (sliced) return sliced;
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? '';
    if (!line.startsWith('{')) continue;
    const parsed = tryParse(line);
    if (parsed) return parsed;
  }
  return null;
}

export function wrapperError(command: string, error: WrapperErrorInput): AgentDesktopEnvelope {
  const body: AgentDesktopErrorBody = {
    code: error.code,
    message: error.message,
    disposition: { delivery: error.delivery, retry: error.retry },
  };
  if (error.suggestion) body.suggestion = error.suggestion;
  return {
    version: '2.5',
    ok: false,
    command,
    error: body,
  };
}

export function toToolResult(envelope: AgentDesktopEnvelope): ToolTextResult {
  const structured = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
  const result: ToolTextResult = {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: structured,
  };
  if (envelope.ok !== true) result.isError = true;
  return result;
}
