// Maps MCP tool arguments onto `agent-desktop` argv. Flag names follow the
// CLI (see vercel-labs/agent-desktop src/cli_args). Values are passed as
// separate argv entries, never through a shell, so refs that start with `@`
// are not expanded.

export class CliArgError extends Error {
  readonly code = 'INVALID_ARGS' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CliArgError';
  }
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
}

export interface DesktopTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  toArgs: (args: Record<string, unknown>) => string[];
}

export const SERVER_INSTRUCTIONS = [
  'Local accessibility-tree Computer Use via the Vercel Labs agent-desktop CLI (https://github.com/vercel-labs/agent-desktop).',
  'This is not screenshot computer use. Observe with snapshot, act on a snapshot-qualified ref (@<snapshot_id>:eN), then snapshot again to verify.',
  'The CLI must already be installed on this same desktop (`npm i -g agent-desktop`). On macOS, Accessibility must be granted to the app that runs the daemon. A cloud VM cannot drive the user\'s GUI.',
  'Retry or repeat an action only when error.disposition.retry is "safe", or after a fresh snapshot shows the action did not land. A cancelled call may already have been delivered.',
  'Actions are headless semantic calls unless headed is true. Set headed only when the user explicitly allows physical pointer and focus changes.',
].join('\n');

const SURFACES = [
  'window',
  'focused',
  'menu',
  'menubar',
  'sheet',
  'popover',
  'alert',
  'desktop',
  'taskbar',
  'system-tray',
  'quick-settings',
  'notification-center',
  'toolbar',
  'dock',
  'spotlight',
  'menu-bar-extras',
  'system-tray-overflow',
  'start-menu',
  'action-center',
] as const;

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

const refProp = {
  type: 'string',
  description:
    'Snapshot-qualified element ref (@<snapshot_id>:eN), for example @s8f3k2p9:e8. A bare @eN is rejected.',
};

const headedProp = {
  type: 'boolean',
  description:
    'Pass the global --headed flag so the CLI may use physical input. Leave unset unless the user explicitly allows pointer and focus changes.',
};

const timeoutProp = {
  type: 'integer',
  minimum: 0,
  maximum: 120_000,
  description: 'Override the CLI --timeout-ms for this call. Omit to use the CLI default.',
};

const appProp = {
  type: 'string',
  description: 'Application name, as returned by list-apps. Example: Finder or Figma.',
};

const windowIdProp = {
  type: 'string',
  description: 'Window id from list-windows. Use it when several windows share one app name.',
};

function schema(
  properties: Record<string, Record<string, unknown>>,
  required: string[] = [],
): JsonSchema {
  const next: JsonSchema = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) next.required = required;
  return next;
}

export function readArgs(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliArgError('Tool arguments must be an object');
  }
  return raw as Record<string, unknown>;
}

function assertKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new CliArgError(`Unknown argument "${key}"`);
    }
  }
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  max: number,
  trim: boolean,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(args, key) || args[key] === undefined) return undefined;
  const value = args[key];
  if (typeof value !== 'string') {
    throw new CliArgError(`"${key}" must be a string`);
  }
  const text = trim ? value.trim() : value;
  if (text.length === 0) throw new CliArgError(`"${key}" must be a non-empty string`);
  if (text.length > max) throw new CliArgError(`"${key}" is too long`);
  return text;
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
  max: number,
  trim: boolean,
): string {
  const value = optionalString(args, key, max, trim);
  if (value === undefined) throw new CliArgError(`"${key}" is required`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(args, key) || args[key] === undefined) return undefined;
  if (typeof args[key] !== 'boolean') throw new CliArgError(`"${key}" must be a boolean`);
  return args[key] as boolean;
}

function optionalInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(args, key) || args[key] === undefined) return undefined;
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new CliArgError(`"${key}" must be an integer from ${min} to ${max}`);
  }
  return value;
}

function pushTimeout(argv: string[], args: Record<string, unknown>): void {
  const timeout = optionalInt(args, 'timeoutMs', 0, 120_000);
  if (timeout !== undefined) argv.push('--timeout-ms', String(timeout));
}

function withHeaded(argv: string[], args: Record<string, unknown>, command: string): void {
  if (optionalBoolean(args, 'headed') === true) argv.push('--headed');
  argv.push(command);
}

function refCommand(command: string, args: Record<string, unknown>): string[] {
  assertKeys(args, ['ref', 'timeoutMs', 'headed']);
  const ref = requiredString(args, 'ref', 512, true);
  const argv: string[] = [];
  withHeaded(argv, args, command);
  pushTimeout(argv, args);
  argv.push('--', ref);
  return argv;
}

function snapshotArgs(args: Record<string, unknown>): string[] {
  assertKeys(args, [
    'app',
    'windowId',
    'surface',
    'root',
    'maxDepth',
    'timeoutMs',
    'interactiveOnly',
    'compact',
    'skeleton',
    'includeBounds',
  ]);
  const app = optionalString(args, 'app', 512, true);
  const windowId = optionalString(args, 'windowId', 512, true);
  const surface = optionalString(args, 'surface', 64, true);
  if (surface !== undefined && !SURFACES.includes(surface as (typeof SURFACES)[number])) {
    throw new CliArgError(`"surface" must be one of: ${SURFACES.join(', ')}`);
  }
  const root = optionalString(args, 'root', 512, true);
  const maxDepth = optionalInt(args, 'maxDepth', 0, 255);
  const argv = ['snapshot'];
  if (app) argv.push('--app', app);
  if (windowId) argv.push('--window-id', windowId);
  if (surface) argv.push('--surface', surface);
  if (root) argv.push('--root', root);
  if (maxDepth !== undefined) argv.push('--max-depth', String(maxDepth));
  pushTimeout(argv, args);
  if (optionalBoolean(args, 'interactiveOnly') === true) argv.push('-i');
  if (optionalBoolean(args, 'compact') === true) argv.push('--compact');
  if (optionalBoolean(args, 'skeleton') === true) argv.push('--skeleton');
  if (optionalBoolean(args, 'includeBounds') === true) argv.push('--include-bounds');
  return argv;
}

function typeArgs(args: Record<string, unknown>): string[] {
  assertKeys(args, ['ref', 'text', 'timeoutMs', 'intervalMs', 'headed']);
  const ref = requiredString(args, 'ref', 512, true);
  const text = requiredString(args, 'text', 100_000, false);
  const interval = optionalInt(args, 'intervalMs', 1, 2000);
  const argv: string[] = [];
  withHeaded(argv, args, 'type');
  pushTimeout(argv, args);
  if (interval !== undefined) argv.push('--interval-ms', String(interval));
  argv.push('--', ref, text);
  return argv;
}

function setValueArgs(args: Record<string, unknown>): string[] {
  assertKeys(args, ['ref', 'value', 'timeoutMs', 'headed']);
  const ref = requiredString(args, 'ref', 512, true);
  const value = requiredString(args, 'value', 100_000, false);
  const argv: string[] = [];
  withHeaded(argv, args, 'set-value');
  pushTimeout(argv, args);
  argv.push('--', ref, value);
  return argv;
}

function pressArgs(args: Record<string, unknown>): string[] {
  assertKeys(args, ['combo', 'app', 'windowId', 'force', 'headed']);
  const combo = requiredString(args, 'combo', 128, true);
  const app = optionalString(args, 'app', 512, true);
  const windowId = optionalString(args, 'windowId', 512, true);
  const argv: string[] = [];
  withHeaded(argv, args, 'press');
  if (app) argv.push('--app', app);
  if (windowId) argv.push('--window-id', windowId);
  if (optionalBoolean(args, 'force') === true) argv.push('--force');
  argv.push('--', combo);
  return argv;
}

function scrollArgs(args: Record<string, unknown>): string[] {
  assertKeys(args, ['ref', 'direction', 'amount', 'timeoutMs', 'headed']);
  const ref = requiredString(args, 'ref', 512, true);
  const direction = optionalString(args, 'direction', 16, true);
  if (
    direction !== undefined &&
    !SCROLL_DIRECTIONS.includes(direction as (typeof SCROLL_DIRECTIONS)[number])
  ) {
    throw new CliArgError('"direction" must be up, down, left, or right');
  }
  const amount = optionalInt(args, 'amount', 1, 1000);
  const argv: string[] = [];
  withHeaded(argv, args, 'scroll');
  if (direction) argv.push('--direction', direction);
  if (amount !== undefined) argv.push('--amount', String(amount));
  pushTimeout(argv, args);
  argv.push('--', ref);
  return argv;
}

function inventoryArgs(command: string, args: Record<string, unknown>): string[] {
  assertKeys(args, ['app', 'timeoutMs']);
  const app = optionalString(args, 'app', 512, true);
  const argv = [command];
  if (app) argv.push('--app', app);
  pushTimeout(argv, args);
  return argv;
}

function permissionsArgs(args: Record<string, unknown>): string[] {
  assertKeys(args, ['request', 'guide']);
  const argv = ['permissions'];
  if (optionalBoolean(args, 'request') === true) argv.push('--request');
  if (optionalBoolean(args, 'guide') === true) argv.push('--guide');
  return argv;
}

function statusArgs(args: Record<string, unknown>): string[] {
  assertKeys(args, []);
  return ['status'];
}

const clickDescription =
  'Activate the element for ref through the accessibility API. The ref must come from the latest snapshot. Snapshot again to verify. A click often returns delivered_unverified: that means the action was sent, not that the app did what you hoped.';

export const DESKTOP_TOOLS: readonly DesktopTool[] = [
  {
    name: 'snapshot',
    description:
      'Read an application accessibility tree and return element refs. Prefer interactiveOnly for a first look. For a dense app such as Figma, start with skeleton and compact, then snapshot again with root set to one region. This does not take a screenshot.',
    inputSchema: schema({
      app: appProp,
      windowId: windowIdProp,
      surface: {
        type: 'string',
        enum: [...SURFACES],
        description: 'Accessibility surface to read. Defaults to the window.',
      },
      root: {
        type: 'string',
        description: 'Snapshot-qualified ref to start from, instead of the window root.',
      },
      maxDepth: {
        type: 'integer',
        minimum: 0,
        maximum: 255,
        description: 'Maximum tree depth. The CLI default is 10.',
      },
      timeoutMs: timeoutProp,
      interactiveOnly: {
        type: 'boolean',
        description: 'Pass -i so the tree keeps interactive elements only.',
      },
      compact: {
        type: 'boolean',
        description: 'Collapse single-child unnamed nodes.',
      },
      skeleton: {
        type: 'boolean',
        description: 'Shallow overview with children_count on cut branches.',
      },
      includeBounds: {
        type: 'boolean',
        description: 'Include element bounds. Omit unless you need coordinates.',
      },
    }),
    toArgs: snapshotArgs,
  },
  {
    name: 'click',
    description: clickDescription,
    inputSchema: schema(
      { ref: refProp, timeoutMs: timeoutProp, headed: headedProp },
      ['ref'],
    ),
    toArgs: (args) => refCommand('click', args),
  },
  {
    name: 'double-click',
    description:
      'Double-click the element for ref. Same ref rules as click. Many targets need headed for a real double-click; leave headed unset until the user allows physical input.',
    inputSchema: schema(
      { ref: refProp, timeoutMs: timeoutProp, headed: headedProp },
      ['ref'],
    ),
    toArgs: (args) => refCommand('double-click', args),
  },
  {
    name: 'triple-click',
    description: 'Triple-click the element for ref. Same ref rules as click.',
    inputSchema: schema(
      { ref: refProp, timeoutMs: timeoutProp, headed: headedProp },
      ['ref'],
    ),
    toArgs: (args) => refCommand('triple-click', args),
  },
  {
    name: 'right-click',
    description: 'Secondary-click the element for ref. Same ref rules as click.',
    inputSchema: schema(
      { ref: refProp, timeoutMs: timeoutProp, headed: headedProp },
      ['ref'],
    ),
    toArgs: (args) => refCommand('right-click', args),
  },
  {
    name: 'type',
    description:
      'Type text into the element for ref. The ref must be snapshot-qualified. Do not use this to submit a form twice: check disposition.retry before repeating.',
    inputSchema: schema(
      {
        ref: refProp,
        text: { type: 'string', description: 'Text to type. A leading dash is passed through as text, not as a flag.' },
        timeoutMs: timeoutProp,
        intervalMs: {
          type: 'integer',
          minimum: 1,
          maximum: 2000,
          description: 'Type one keystroke every N milliseconds instead of inserting the text at once.',
        },
        headed: headedProp,
      },
      ['ref', 'text'],
    ),
    toArgs: typeArgs,
  },
  {
    name: 'set-value',
    description:
      'Replace the value of the element for ref in one accessibility write. Prefer this over type when the control exposes a value. Snapshot again to verify.',
    inputSchema: schema(
      {
        ref: refProp,
        value: { type: 'string', description: 'Value to set.' },
        timeoutMs: timeoutProp,
        headed: headedProp,
      },
      ['ref', 'value'],
    ),
    toArgs: setValueArgs,
  },
  {
    name: 'clear',
    description: 'Clear the value of the element for ref.',
    inputSchema: schema(
      { ref: refProp, timeoutMs: timeoutProp, headed: headedProp },
      ['ref'],
    ),
    toArgs: (args) => refCommand('clear', args),
  },
  {
    name: 'focus',
    description: 'Move accessibility focus to the element for ref.',
    inputSchema: schema(
      { ref: refProp, timeoutMs: timeoutProp, headed: headedProp },
      ['ref'],
    ),
    toArgs: (args) => refCommand('focus', args),
  },
  {
    name: 'press',
    description:
      'Press a key combo such as return, escape, or cmd+c. This is one shot, not a held key. force sends a combo the CLI would otherwise refuse as dangerous.',
    inputSchema: schema(
      {
        combo: { type: 'string', description: 'Key combo: return, escape, cmd+c, shift+tab, …' },
        app: appProp,
        windowId: windowIdProp,
        force: {
          type: 'boolean',
          description: 'Send the combo even if the CLI flags it as a dangerous shortcut.',
        },
        headed: headedProp,
      },
      ['combo'],
    ),
    toArgs: pressArgs,
  },
  {
    name: 'scroll',
    description: 'Scroll the element for ref. direction is up, down, left, or right.',
    inputSchema: schema(
      {
        ref: refProp,
        direction: {
          type: 'string',
          enum: [...SCROLL_DIRECTIONS],
          description: 'Scroll direction. The CLI default is down.',
        },
        amount: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Number of scroll units. The CLI default is 3.',
        },
        timeoutMs: timeoutProp,
        headed: headedProp,
      },
      ['ref'],
    ),
    toArgs: scrollArgs,
  },
  {
    name: 'list-apps',
    description: 'List running applications the CLI can target. Use an app name from this list as snapshot.app.',
    inputSchema: schema({ app: appProp, timeoutMs: timeoutProp }),
    toArgs: (args) => inventoryArgs('list-apps', args),
  },
  {
    name: 'list-windows',
    description: 'List windows. Pass windowId to snapshot when an app has more than one window.',
    inputSchema: schema({ app: appProp, timeoutMs: timeoutProp }),
    toArgs: (args) => inventoryArgs('list-windows', args),
  },
  {
    name: 'permissions',
    description:
      'Report OS permission state for accessibility-tree Computer Use. On macOS, guide opens the system Accessibility pane. request asks the bounded helper to prompt. Neither flag is set unless you pass it.',
    inputSchema: schema({
      request: {
        type: 'boolean',
        description: 'Ask the OS to prompt for missing permissions.',
      },
      guide: {
        type: 'boolean',
        description: 'Open the macOS Accessibility settings guide.',
      },
    }),
    toArgs: permissionsArgs,
  },
  {
    name: 'status',
    description:
      'Report platform, permission, and supported-surface status for the local agent-desktop CLI. Call this when a desktop tool fails with PERM_DENIED or CLI_NOT_FOUND.',
    inputSchema: schema({}),
    toArgs: statusArgs,
  },
];

const TOOLS_BY_NAME = new Map(DESKTOP_TOOLS.map((tool) => [tool.name, tool]));

export function buildCliArgs(name: string, raw: unknown): string[] {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new CliArgError(`Unknown tool "${name}"`);
  return tool.toArgs(readArgs(raw));
}
