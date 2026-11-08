/**
 * Workers draw the boxes. The rest never take a task: they stay in orbit
 * so the arrow cluster keeps circling whatever is being drawn.
 * Colors are the original swarm palette, in its original order.
 */
export const REVEAL_AGENTS: ReadonlyArray<{
  id: number;
  role: 'layout' | 'type' | 'color';
  color: string;
  ink: string;
  works: boolean;
}> = [
  { id: 0, role: 'layout', color: '#0D99FF', ink: '#ffffff', works: true },
  { id: 1, role: 'type', color: '#F24E1E', ink: '#ffffff', works: true },
  { id: 2, role: 'color', color: '#A259FF', ink: '#ffffff', works: true },
  { id: 3, role: 'layout', color: '#0ACF83', ink: '#ffffff', works: true },
  { id: 4, role: 'type', color: '#FFC700', ink: '#ffffff', works: true },
  { id: 5, role: 'color', color: '#1ABCFE', ink: '#ffffff', works: true },
  { id: 6, role: 'layout', color: '#0D99FF', ink: '#ffffff', works: false },
  { id: 7, role: 'type', color: '#F24E1E', ink: '#ffffff', works: false },
  { id: 8, role: 'color', color: '#A259FF', ink: '#ffffff', works: false },
  { id: 9, role: 'layout', color: '#0ACF83', ink: '#ffffff', works: false },
  { id: 10, role: 'type', color: '#FFC700', ink: '#ffffff', works: false },
];

/** The original arrow: tip upper-left, concave trailing edge. */
export const REVEAL_ARROW_PATH = 'M4.6 3.9 C4.2 3.1 4.9 2.4 5.7 2.8 L20.6 9.4 C21.5 9.8 21.4 11.1 20.4 11.3 L13.9 12.9 C13.4 13 13 13.4 12.9 13.9 L11.3 20.4 C11.1 21.4 9.8 21.5 9.4 20.6 Z';

/** Hot spot of the arrow, in the 28×28 cursor canvas. */
export const REVEAL_ARROW_HOTSPOT = { x: 5, y: 3.5 };

/** A pressed cursor shrinks a touch, the way the original does on click. */
export const REVEAL_PRESS_SCALE = 0.88;

export const REVEAL_INTRO_MS = 920;

export function formatRevealSize(width: number, height: number): string {
  return `${Math.max(0, Math.round(width))} × ${Math.max(0, Math.round(height))}`;
}

function easeOut(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}

export interface RevealLayerFrame {
  visible: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  sizeLabel: string;
  /** True only while the box is still being dragged out. The label leaves with the drag. */
  dragging: boolean;
  /** 0..1 typed progress for a text layer. */
  typed: number;
  /** Selection outline and handles. Gone the instant the content starts showing. */
  showChrome: boolean;
  fillOpacity: number;
  /** Corner the working cursor is dragging. */
  work: { x: number; y: number };
}

/** A box grows from its top-left. While it grows, the thing written on it is its live size. */
export function revealLayerFrame(input: {
  layer: { x: number; y: number; w: number; h: number };
  master: { x: number; y: number } | null;
  action: 'draw' | 'type' | 'sweep' | 'duplicate';
  startMs: number;
  durationMs: number;
  now: number;
}): RevealLayerFrame {
  const raw = input.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (input.now - input.startMs) / input.durationMs));
  const progress = easeOut(raw);
  const growing = input.action !== 'duplicate';
  // Content and chrome share one hand-off point: the instant the fill starts to
  // appear, the marquee and its size chip are gone. For a rect that is when the
  // box is essentially at full size; for type it is as soon as it starts typing.
  const contentFrom = input.action === 'type' ? 0.22 : 0.62;
  const chromeOff = raw >= contentFrom;
  // A text box is dragged to its full size BEFORE typing starts. Letting it grow
  // across the whole gesture would squeeze the clone into a half-width box.
  const boxProgress = input.action === 'type'
    ? Math.min(1, raw / contentFrom)
    : progress;
  const boxEase = input.action === 'type' ? boxProgress : progress;
  const w = growing ? Math.max(1, input.layer.w * boxEase) : input.layer.w;
  const h = growing ? Math.max(1, input.layer.h * boxEase) : input.layer.h;
  const x = input.master ? input.master.x + (input.layer.x - input.master.x) * progress : input.layer.x;
  const y = input.master ? input.master.y + (input.layer.y - input.master.y) * progress : input.layer.y;
  const fillOpacity = chromeOff ? Math.min(1, (raw - contentFrom) / 0.18) : 0;
  const typed = !chromeOff
    ? 0
    : input.action === 'type' ? (raw - contentFrom) / Math.max(0.001, 1 - contentFrom) : 1;
  return {
    visible: input.now >= input.startMs,
    x,
    y,
    w,
    h,
    sizeLabel: formatRevealSize(w, h),
    dragging: !chromeOff,
    typed,
    showChrome: !chromeOff,
    fillOpacity,
    work: { x: x + w, y: y + h },
  };
}

export interface CursorWork {
  x: number;
  y: number;
  /** 0 sits on the orbit, 1 sits on the corner being dragged. */
  blend: number;
}

const APPROACH_MS = 180;
const RELEASE_MS = 240;

/** The cursor flies onto a corner, rides it while the box grows, then peels back into the orbit. */
export function cursorWork(input: {
  agent: number;
  now: number;
  tasks: ReadonlyArray<{ agent: number; startMs: number; durationMs: number; work: { x: number; y: number } }>;
}): CursorWork | null {
  let chosen: CursorWork & { active: boolean } | null = null;
  for (const task of input.tasks) {
    if (task.agent !== input.agent) continue;
    const end = task.startMs + task.durationMs;
    if (input.now < task.startMs || input.now > end + RELEASE_MS) continue;
    const active = input.now <= end;
    if (chosen?.active && !active) continue;
    const blend = active
      ? Math.min(1, (input.now - task.startMs) / APPROACH_MS)
      : Math.max(0, 1 - (input.now - end) / RELEASE_MS);
    chosen = { x: task.work.x, y: task.work.y, blend, active };
  }
  if (!chosen || chosen.blend <= 0) return null;
  return { x: chosen.x, y: chosen.y, blend: chosen.blend };
}

