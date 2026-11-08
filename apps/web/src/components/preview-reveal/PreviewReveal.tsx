import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  isPreviewRevealPatch,
  parsePreviewRevealBlueprint,
  parsePreviewRevealPointer,
  previewRevealPatchRequest,
  previewRevealRequest,
  type PreviewRevealBlueprint,
  type PreviewRevealLayer,
} from '@open-design/contracts/runtime/preview-reveal';
import { useT } from '../../i18n';
import {
  claimPreviewRevealAutoplay,
  planPreviewReveal,
  previewRevealConvergeAt,
  previewRevealPhaseAt,
  shouldQueuePreviewRevealAutoplay,
} from './plan';
import { cursorWork, REVEAL_AGENTS, REVEAL_PRESS_SCALE, revealLayerFrame, type CursorWork } from './swarm';
import {
  createFlockState,
  flockColorOf,
  stepFlock,
  type FlockPoint,
} from './flock';
import { COMPANION_REST, createCompanion, nudgeCompanion, stepCompanion, type CompanionState } from './companion';
import { usePointerRuntime, type PointerRuntime } from './pointer';
import type { PressPoint } from './press';
import { PreviewRevealWorking } from './PreviewRevealWorking';
import { PreviewRevealPatch } from './PreviewRevealPatch';
import { CursorGlyph } from './CursorGlyph';
import { RevealSound } from './sound';
import styles from './PreviewReveal.module.css';

/** Where the crowd ends and the one remaining cursor takes over. */
export interface PreviewRevealHandoff {
  x: number;
  y: number;
  angle: number;
}

export interface PreviewRevealHandle {
  replay: () => void;
  /**
   * The toolbar gesture that says "I am about to operate on this page". The
   * cursor on the page answers it, which is what makes the toolbar control and
   * the cursor read as one assistant rather than a button and a decoration.
   */
  summon: () => void;
}

export interface PreviewRevealHostProps {
  active: boolean;
  blocked: boolean;
  streaming: boolean;
  previewReady: boolean;
  sessionKey: string;
  frameRef: RefObject<HTMLIFrameElement | null>;
}

export interface PreviewRevealLabels {
  skip: string;
  status: string;
}

/** The page reappears under the swarm: the curtain thins away, the arrows stay. */
const CURTAIN_FADE_MS = 520;

/** How long the "I was hit" glow outlives the collision frame. */
const KNOCK_HOLD_MS = 420;

/**
 * How often the host asks the page for changed boxes while a run streams.
 *
 * An agent writing HTML mutates the DOM far faster than a curtain is worth
 * drawing, so patches are coalesced to one per window. 260ms is roughly the
 * length of one patch animation — a new one therefore lands as the previous
 * finishes rather than stacking on top of it.
 */
const PATCH_POLL_MS = 260;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
  return reduced;
}

function placedFrames(
  blueprint: PreviewRevealBlueprint,
  plan: ReturnType<typeof planPreviewReveal>,
  now: number,
) {
  const masterOf = (layer: PreviewRevealLayer) => (
    layer.group ? blueprint.layers.find((item) => item.group === layer.group && item.master) ?? null : null
  );
  return blueprint.layers.flatMap((layer) => {
    const task = plan.tasks.find((item) => item.layerId === layer.id);
    if (!task) return [];
    const frame = revealLayerFrame({
      layer,
      master: task.action === 'duplicate' ? masterOf(layer) : null,
      action: task.action,
      startMs: task.startMs,
      durationMs: task.durationMs,
      now,
    });
    return frame.visible ? [{ layer, task, frame }] : [];
  });
}

function focusOf(
  frames: ReturnType<typeof placedFrames>,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const active = frames.filter((item) => item.frame.showChrome);
  const source = active.length > 0 ? active : frames;
  if (source.length === 0) return { x: viewport.width / 2, y: viewport.height / 2 };
  return {
    x: source.reduce((sum, item) => sum + item.frame.x + item.frame.w / 2, 0) / source.length,
    y: source.reduce((sum, item) => sum + item.frame.y + item.frame.h / 2, 0) / source.length,
  };
}

function agentWork(frames: ReturnType<typeof placedFrames>, agent: number, now: number): CursorWork | null {
  return cursorWork({
    agent,
    now,
    tasks: frames.map((item) => ({
      agent: item.task.agent,
      startMs: item.task.startMs,
      durationMs: item.task.durationMs,
      work: item.frame.work,
    })),
  });
}

/** The swarm gathers on the pointer, or on the box being drawn when it is away. */
function anchorOf(frames: ReturnType<typeof placedFrames>, viewport: { width: number; height: number }): FlockPoint {
  return focusOf(frames, viewport);
}

/**
 * Where the knot forms: the cursor's resting offset from the pointer, kept
 * inside the stage so a pointer near an edge does not push the merge offscreen.
 */
function knotOf(pointer: FlockPoint, viewport: { width: number; height: number }): FlockPoint {
  const margin = 24;
  return {
    x: Math.max(margin, Math.min(viewport.width - margin, pointer.x + COMPANION_REST.x)),
    y: Math.max(margin, Math.min(viewport.height - margin, pointer.y + COMPANION_REST.y)),
  };
}

/**
 * Pointer in stage pixels → the blueprint's own coordinate space.
 *
 * The surface is drawn at the blueprint's size and then uniformly scaled and
 * centred onto the stage, so everything on it — cursor orbits, the keep-out
 * ring, the knot — lives in blueprint units. Handing it raw stage pixels would
 * put the crew in the wrong place the moment those two sizes disagree, and the
 * letterboxing has to be subtracted before dividing.
 */
/**
 * Pointer in stage pixels → the blueprint's own coordinate space.
 *
 * The surface is drawn at the blueprint's size and then uniformly scaled and
 * centred onto the stage, so everything on it — cursor orbits, the keep-out
 * ring, the knot — lives in blueprint units. Handing it raw stage pixels would
 * put the crew in the wrong place the moment those two sizes disagree, and the
 * letterboxing has to be subtracted before dividing.
 *
 * `screen` is the live stage, `surface` is the blueprint-sized box drawn on it,
 * so the conversion divides by the surface→stage enlargement factor.
 */
export function toBlueprintSpace(
  point: PressPoint | null,
  screen: { width: number; height: number },
  surface: { width: number; height: number },
): PressPoint | null {
  if (!point) return null;
  const scale = uniformScale(surface, screen);
  if (scale <= 0) return null;
  return {
    x: (point.x - screen.width / 2) / scale + surface.width / 2,
    y: (point.y - screen.height / 2) / scale + surface.height / 2,
  };
}

/**
 * The one scale factor used to fit a blueprint-sized surface onto a stage: the
 * smaller of the two axis ratios, so the whole surface stays visible and the
 * remainder is letterboxed. Both axes get this same number — see the note on
 * the canvas in `PreviewRevealStage`.
 *
 * `from` is the content, `to` is the box it is drawn into, so a result above 1
 * means the surface is enlarged to fill the stage.
 */
export function uniformScale(from: { width: number; height: number }, to: { width: number; height: number }): number {
  return Math.min(
    to.width / Math.max(1, from.width),
    to.height / Math.max(1, from.height),
  );
}

/**
 * A text layer, revealed by wiping its cloned markup sideways. The page's own
 * computed type stack is applied through `styleText`, so font, spacing, weight
 * and stroke stay exactly as the page rendered them — nothing is re-guessed.
 */
export function RevealText({
  className,
  styleText,
  html,
  fallback,
  typed,
}: {
  className: string | undefined;
  styleText: string;
  html: string;
  fallback: string;
  typed: number;
}) {
  const cloneRef = useRef<HTMLDivElement | null>(null);
  // The page's computed typography arrives as a CSS text string. Writing it onto
  // the node verbatim keeps every property React's style object would normalise.
  // `white-space` comes along with it, so a wrapped heading stays wrapped instead
  // of being flattened to one clipped line by the overlay's own CSS.
  //
  // It arrives ALREADY expressed in the overlay's coordinate space: the bridge
  // measures boxes with `getBoundingClientRect()` (painted/stage pixels) and
  // multiplies font-size, letter-spacing and word-spacing by the same ratio, so
  // the type is sized for the box it is about to sit in. Adding a `transform`
  // here would apply that ratio a second time — on a page whose stage is scaled
  // to a third (4680px design on a 1400px viewport) that left 9px type painted
  // at 1.4px. The node must stay untransformed; only its own CSS sizes it.
  const applyStyle = useCallback((node: HTMLDivElement | null) => {
    cloneRef.current = node;
    if (!node) return;
    node.setAttribute('style', styleText);
  }, [styleText]);

  return (
    <div
      className={className}
      style={{
        clipPath: typed < 1 ? `inset(0 ${(1 - typed) * 100}% 0 0)` : undefined,
      }}
    >
      <div
        ref={applyStyle}
        // The markup comes from the page under measurement and was stripped of
        // scripts, event handlers and style attributes by `cleanHtml`.
        dangerouslySetInnerHTML={html ? { __html: html } : undefined}
      >
        {html ? null : fallback}
      </div>
      {typed < 1 ? <i className={styles.caret} /> : null}
    </div>
  );
}

export function PreviewRevealStage({
  blueprint,
  labels,
  pointer,
  onDone,
  onSkip,
}: {
  blueprint: PreviewRevealBlueprint;
  labels: PreviewRevealLabels;
  /** The host's single pointer reading, shared with the cursor that follows. */
  pointer: PointerRuntime;
  onDone: (handoff: PreviewRevealHandoff) => void;
  onSkip: () => void;
}) {
  const plan = useMemo(() => planPreviewReveal(blueprint), [blueprint]);
  const [now, setNow] = useState(0);
  // The live size of the stage. The blueprint is measured once, so the drawing
  // surface has to be mapped onto whatever box the preview has now.
  const [stageSize, setStageSize] = useState(() => ({
    width: blueprint.viewport.width,
    height: blueprint.viewport.height,
  }));
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Mirrors `stageSize` for the animation loop. The loop must not restart when
  // the preview is resized (that would reset the whole timeline), so it reads
  // the live box from here instead of taking it as a dependency.
  const stageSizeRef = useRef({ width: blueprint.viewport.width, height: blueprint.viewport.height });
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  // Where the finale collapses to, latched once so the surviving arrow is handed
  // over at exactly the point the crew gathered into.
  const knotRef = useRef<FlockPoint | null>(null);
  const flock = useMemo(
    () => createFlockState(
      { x: blueprint.viewport.width / 2, y: blueprint.viewport.height / 2 },
      REVEAL_AGENTS.length,
    ),
    [blueprint.requestId, blueprint.viewport.width, blueprint.viewport.height],
  );
  const pendingRef = useRef(0);
  const lastFrameRef = useRef(0);
  const soundRef = useRef<RevealSound | null>(null);
  const soundedRef = useRef<Set<string>>(new Set());
  const releasedRef = useRef(false);

  useEffect(() => {
    // The audio context has to be created inside a user gesture, so it is armed
    // on the first pointer/key event the stage sees, and on the replay click.
    const sound = new RevealSound();
    soundRef.current = sound;
    soundedRef.current = new Set();
    releasedRef.current = false;
    return () => {
      sound.dispose();
      soundRef.current = null;
    };
  }, [blueprint.requestId]);

  // Arm audio on the first gesture the stage sees; the graph itself stays put.
  useEffect(() => {
    const arm = () => soundRef.current?.arm();
    window.addEventListener('pointerdown', arm, { passive: true, capture: true });
    window.addEventListener('keydown', arm, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', arm, { capture: true });
      window.removeEventListener('keydown', arm, { capture: true });
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const started = performance.now();
    lastFrameRef.current = 0;
    const tick = (time: number) => {
      const elapsed = time - started;
      const dt = lastFrameRef.current === 0 ? 1 / 60 : (time - lastFrameRef.current) / 1000;
      lastFrameRef.current = time;
      pointer.sample(dt);
      const currentFrames = placedFrames(blueprint, plan, elapsed);
      const anchor = anchorOf(currentFrames, blueprint.viewport);
      const phase = previewRevealPhaseAt(plan, elapsed);
      const converge = previewRevealConvergeAt(plan, elapsed);
      // The whole curtain counts: a build fired from the toolbar leaves the
      // pointer up on the button, and the reading from before that click is
      // still the user's position on the page.
      const live = stageSizeRef.current;
      const gather = toBlueprintSpace(
        pointer.remembered(plan.durationMs + 500),
        live,
        blueprint.viewport,
      );
      const knot = gather
        ? knotOf(gather, blueprint.viewport)
        : { x: anchor.x + COMPANION_REST.x, y: anchor.y + COMPANION_REST.y };
      // Latched the moment the merge starts: after that the crew's own centroid
      // would drag it around and the handoff would drift.
      if (knotRef.current === null && converge > 0) knotRef.current = knot;
      pendingRef.current = plan.tasks.filter((task) => task.startMs + task.durationMs > elapsed).length;
      // One click when the cursor grabs a box, matching the original's `press()`.
      for (const item of currentFrames) {
        if (soundedRef.current.has(item.layer.id)) continue;
        soundedRef.current.add(item.layer.id);
        if (item.task.action === 'type') continue;
        soundRef.current?.click({
          x: item.frame.x + item.frame.w / 2,
          viewportWidth: blueprint.viewport.width,
        });
      }
      // The page comes back while the crew is still on screen, so the merge
      // happens over the real page rather than over a fading screenshot.
      if (!releasedRef.current && elapsed >= plan.buildMs) {
        releasedRef.current = true;
        soundRef.current?.release();
      }
      stepFlock({
        state: flock,
        dt,
        time: elapsed,
        // Everyone on the surface, including the pointer, works in blueprint
        // units — see `toBlueprintSpace`.
        pointer: toBlueprintSpace(pointer.point, live, blueprint.viewport),
        track: pointer.track,
        pointerSpeed: pointer.speed,
        pending: pendingRef.current,
        anchor,
        convergeAt: knot,
        phase,
        converge,
        work: (cursor) => {
          if (cursor.agent < 0) return null;
          const agent = REVEAL_AGENTS[cursor.agent];
          if (!agent || !agent.works) return null;
          const work = agentWork(currentFrames, agent.id, elapsed);
          return work ? { x: work.x, y: work.y, blend: work.blend } : null;
        },
      });
      setNow(elapsed);
      if (elapsed >= plan.durationMs) {
        // Hand over exactly at the knot: the knot was formed beside the pointer,
        // which is where the companion rests, so this is a settle, not a jump.
        // The knot is in blueprint units and the companion lives in stage
        // pixels, so it is mapped on the way out.
        const knot = knotRef.current ?? knotOf(anchor, blueprint.viewport);
        const scale = uniformScale(blueprint.viewport, live);
        onDoneRef.current({
          x: live.width / 2 + (knot.x - blueprint.viewport.width / 2) * scale,
          y: live.height / 2 + (knot.y - blueprint.viewport.height / 2) * scale,
          angle: 0,
        });
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [blueprint, plan, flock, pointer]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      stageSizeRef.current = { width: rect.width, height: rect.height };
      setStageSize((current) => (
        Math.abs(current.width - rect.width) < 0.5 && Math.abs(current.height - rect.height) < 0.5
          ? current
          : { width: rect.width, height: rect.height }
      ));
    };
    measure();
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [blueprint.requestId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      event.preventDefault();
      onSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSkip]);

  // The curtain covers the page while it is being built, then thins away so the
  // real page is what the swarm gathers over. The arrows do NOT fade with it:
  // the finale is the crew folding in over the revealed page, and hiding them
  // under the same opacity is what made the merge invisible.
  const curtain = now <= plan.buildMs
    ? 1
    : Math.max(0, 1 - (now - plan.buildMs) / CURTAIN_FADE_MS);
  const frames = placedFrames(blueprint, plan, now);
  const phase = previewRevealPhaseAt(plan, now);
  // One factor for both axes: see the note on the canvas below. `min` keeps the
  // whole surface visible; the rest of the stage is letterboxed.
  const fit = uniformScale(blueprint.viewport, stageSize);

  return (
    <div
      ref={stageRef}
      className={styles.stage}
      role="status"
      aria-label={labels.status}
      data-testid="preview-reveal"
      data-phase={phase}
    >
      <div className={styles.curtain} style={{ background: blueprint.background, opacity: curtain }} />
      {/*
        The crew and the boxes are measured in the viewport the blueprint was
        taken in, so they are drawn on a surface of exactly that size and the
        surface is scaled onto the live stage.

        The scale is UNIFORM. Resizing the preview does not reflow this surface
        the way it reflows the page — so a per-axis `scale(sx, sy)` would stretch
        type sideways whenever the two aspect ratios disagreed, and the same
        headline the page renders cleanly would come out condensed and tall. One
        factor (`min` of the two, so nothing is cropped) keeps every glyph the
        shape the page gave it; the leftover space is letterboxed.
      */}
      <div
        className={styles.canvas}
        style={{
          opacity: curtain,
          width: blueprint.viewport.width,
          height: blueprint.viewport.height,
          transform: `translate(-50%, -50%) scale(${fit})`,
          left: '50%',
          top: '50%',
        }}
      >
        {frames.map(({ layer, task, frame }) => {
        const agent = REVEAL_AGENTS.find((item) => item.id === task.agent);
        if (!agent) return null;
        return (
          <div
            key={layer.id}
            className={styles.layer}
            data-kind={layer.kind}
            style={{
              transform: `translate(${frame.x}px, ${frame.y}px)`,
              width: frame.w,
              height: frame.h,
              borderRadius: layer.radius,
              opacity: task.action === 'duplicate' ? 0.55 + frame.fillOpacity * 0.45 : 1,
            }}
          >
            {layer.kind === 'rect' && frame.fillOpacity > 0 ? (
              <span
                className={styles.fill}
                style={{
                  borderRadius: layer.radius,
                  background: layer.fill || 'transparent',
                  opacity: frame.fillOpacity,
                }}
              />
            ) : null}
            {/* Type is revealed by wiping its own clone sideways, the way the
                original does. Nothing is retyped, so the page's font, spacing
                and stroke survive untouched. */}
            {layer.kind === 'text' && frame.typed > 0 ? (
              <RevealText
                className={styles.text}
                styleText={layer.style ?? ''}
                html={layer.html ?? ''}
                fallback={layer.text}
                typed={frame.typed}
              />
            ) : null}
            {layer.kind === 'image' && frame.fillOpacity > 0 ? (
              layer.src ? (
                <img
                  className={styles.media}
                  alt=""
                  src={layer.src}
                  style={{ opacity: frame.fillOpacity, clipPath: `inset(0 0 ${(1 - frame.fillOpacity) * 100}% 0)` }}
                />
              ) : (
                <span className={styles.media} style={{ opacity: frame.fillOpacity }} />
              )
            ) : null}
            {frame.showChrome ? (
              <>
                <span className={styles.marquee} style={{ borderRadius: layer.radius }} />
                {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                  <i key={corner} className={styles.handle} data-corner={corner} />
                ))}
              </>
            ) : null}
            {frame.dragging && task.action !== 'duplicate' ? (
              <span
                className={styles.sizeTag}
                style={{ background: agent.color }}
              >
                {frame.sizeLabel}
              </span>
            ) : null}
          </div>
        );
      })}
      </div>
      {flock.cursors.map((cursor) => {
        const agent = cursor.agent >= 0 ? REVEAL_AGENTS[cursor.agent] : undefined;
        const role = agent?.role ?? 'layout';
        return (
          <div
            key={cursor.id}
            className={styles.cursor}
            data-cursor={role}
            data-testid={agent && agent.id < 3 ? `preview-reveal-cursor-${role}` : undefined}
            style={{
              transform: `translate(${cursor.x}px, ${cursor.y}px)`,
              opacity: cursor.leaving > 0 ? 1 - cursor.leaving : 1,
            }}
          >
            <CursorGlyph
              className={styles.pointer}
              color={flockColorOf(cursor, REVEAL_AGENTS.map((item) => item.color))}
              angle={cursor.angle}
              scale={(1 - cursor.press * (1 - REVEAL_PRESS_SCALE)) * (1 - cursor.leaving * 0.55)}
            />
          </div>
        );
      })}
      <button
        type="button"
        className={styles.skip}
        data-testid="preview-reveal-skip"
        onClick={onSkip}
        tabIndex={curtain > 0 ? 0 : -1}
        style={{ opacity: curtain }}
      >
        {labels.skip}
      </button>
    </div>
  );
}

/**
 * The cursor that stays behind when the build ends.
 *
 * It is the same arrow, the same palette entry and the same collision as the
 * swarm, so it reads as one member of the crew that stayed rather than a new
 * widget appearing after the show. It rests just outside the pointer's ring, so
 * brushing past it really does knock it, and its spring really does bring it
 * back — that loop is the entire "it is alive" impression.
 *
 * Positions are written straight to the node: this thing runs for as long as
 * the page is open, and a 60fps React re-render for one arrow is waste.
 */
export function PreviewCompanion({
  seed,
  surfaceRef,
  pointer,
  reducedMotion,
  summonKey,
  onReveal,
}: {
  seed: PreviewRevealHandoff;
  surfaceRef: RefObject<HTMLElement | null>;
  /** The host's single pointer reading, shared with the curtain. */
  pointer: PointerRuntime;
  reducedMotion: boolean;
  /** Bumped by the toolbar control; the cursor perks up when it changes. */
  summonKey: number;
  /** Double-clicking the cursor replays the build it came from. */
  onReveal: () => void;
}) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const glyphRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<CompanionState | null>(null);
  const soundRef = useRef<RevealSound | null>(null);
  const knockedUntilRef = useRef(0);

  useEffect(() => {
    const sound = new RevealSound();
    soundRef.current = sound;
    return () => {
      sound.dispose();
      soundRef.current = null;
    };
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    const bounds = {
      width: surface?.clientWidth ?? 0,
      height: surface?.clientHeight ?? 0,
    };
    const state = createCompanion(pointer.point, bounds);
    // It arrives exactly where the merge left it, then springs to its resting
    // offset — the knot was deliberately formed at that offset, so the handoff
    // is a settle rather than a jump.
    state.x = seed.x;
    state.y = seed.y;
    state.angle = seed.angle;
    stateRef.current = state;
  }, [seed, surfaceRef, pointer]);

  useEffect(() => {
    let frame = 0;
    let last = 0;
    const started = performance.now();
    const tick = (time: number) => {
      const dt = last === 0 ? 1 / 60 : (time - last) / 1000;
      last = time;
      pointer.sample(dt);
      const surface = surfaceRef.current;
      const state = stateRef.current;
      if (state && surface) {
        const visual = stepCompanion({
          state,
          track: pointer.track,
          dt: reducedMotion ? 0 : dt,
          time: time - started,
          pointer: pointer.point,
          bounds: { width: surface.clientWidth, height: surface.clientHeight },
        });
        if (visual.knocked) {
          soundRef.current?.click({ x: visual.x, viewportWidth: surface.clientWidth || 1 });
        }
        if (visual.knocked) knockedUntilRef.current = time + KNOCK_HOLD_MS;
        const node = nodeRef.current;
        if (node) {
          node.style.transform = `translate3d(${visual.x.toFixed(2)}px, ${visual.y.toFixed(2)}px, 0)`;
          // The flag holds for a beat so the glow can answer it; a one-frame
          // attribute is invisible to CSS and to anything watching.
          node.dataset.knocked = time < knockedUntilRef.current ? 'true' : 'false';
        }
        const glyph = glyphRef.current;
        if (glyph) glyph.style.transform = `rotate(${visual.angle.toFixed(2)}deg) scale(${visual.scale.toFixed(3)})`;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [pointer, reducedMotion, surfaceRef]);

  // The toolbar asked for attention: lean away from the pointer so the answer
  // is visible wherever the mouse happens to be.
  useEffect(() => {
    if (summonKey === 0) return;
    const state = stateRef.current;
    if (!state) return;
    nudgeCompanion(state, pointer.point);
  }, [summonKey, pointer]);

  return (
    <div
      ref={nodeRef}
      className={styles.companion}
      data-testid="preview-reveal-companion"
      aria-hidden="true"
      onDoubleClick={onReveal}
    >
      <span className={styles.companionGlow} />
      {/*
        The arrow turns to face the direction it is travelling, so anything
        inside this wrapper is rotated with it. That is right for the arrow and
        wrong for a label: text that leans with the cursor is unreadable at angle
        and looks like a glitch at 180°.
      */}
      <div ref={glyphRef} className={styles.companionGlyph}>
        <CursorGlyph
          className={styles.pointer}
          color={REVEAL_AGENTS[0]!.color}
          angle={0}
        />
      </div>
      {/*
        The name tag, hung off the arrow's shoulder the way a multiplayer cursor
        carries its owner's name. It is a sibling of the rotating glyph rather
        than a child of it, so it shares the cursor's POSITION (the parent's
        per-frame translate) but not its rotation: the tag stays level while the
        arrow banks.

        Untranslated on purpose: this is a brand mark, not a sentence, so it must
        read identically in every locale.
      */}
      <span className={styles.companionTag} data-testid="preview-reveal-companion-tag">
        BANG
      </span>
    </div>
  );
}

function frameCanAnswer(frame: HTMLIFrameElement | null): frame is HTMLIFrameElement {
  if (!frame?.contentWindow) return false;
  const src = frame.getAttribute('src') ?? '';
  const srcDoc = frame.getAttribute('srcdoc');
  if (srcDoc && srcDoc.length > 0) return true;
  return src !== '' && src !== 'about:blank';
}

export const PreviewRevealHost = forwardRef<PreviewRevealHandle, PreviewRevealHostProps>(
  function PreviewRevealHost(props, ref) {
    const { active, blocked, streaming, previewReady, sessionKey, frameRef } = props;
    const t = useT();
    const reducedMotion = useReducedMotion();
    const pendingId = useRef<string | null>(null);
    const patchId = useRef<string | null>(null);
    const requestSeq = useRef(0);
    const wasStreaming = useRef(streaming);
    const identity = useRef(sessionKey);
    // A ref for the effect's own reads (it must not re-run on every arm), and a
    // state mirror so the render can keep the crew on screen through the
    // handover gap — a ref alone would never re-render the surface.
    const pendingAutoplay = useRef(false);
    const [autoplayArmed, setAutoplayArmed] = useState(false);
    const armAutoplay = useCallback((armed: boolean) => {
      pendingAutoplay.current = armed;
      setAutoplayArmed(armed);
    }, []);
    const [loadTick, setLoadTick] = useState(0);
    const [playback, setPlayback] = useState<PreviewRevealBlueprint | null>(null);
    const [patch, setPatch] = useState<PreviewRevealBlueprint | null>(null);
    const [companion, setCompanion] = useState<PreviewRevealHandoff | null>(null);
    const [summonKey, setSummonKey] = useState(0);
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    // One reading, mounted for the whole life of the overlay: the curtain and the
    // cursor that follows it must never disagree about where the pointer is.
    const pointer = usePointerRuntime(surfaceRef);

    const labels = useMemo<PreviewRevealLabels>(() => ({
      skip: t('fileViewer.previewReveal.skip'),
      status: t('fileViewer.previewReveal.status'),
    }), [t]);

    const postRequest = useCallback(() => {
      const frame = frameRef.current;
      const target = frameCanAnswer(frame) ? frame.contentWindow : null;
      if (!target) return false;
      const id = `reveal-${requestSeq.current += 1}`;
      pendingId.current = id;
      target.postMessage(previewRevealRequest(id), '*');
      return true;
    }, [frameRef]);

    /**
     * Ask for whatever changed since the last look.
     *
     * Fire-and-forget: the page answers only when something is dirty, so an idle
     * poll costs one postMessage and nothing else. It is deliberately a poll
     * rather than a push — the page cannot call into the host on its own, and a
     * poll keeps the coalescing window under the host's control (one patch per
     * interval, not one per mutation).
     */
    const postPatchRequest = useCallback(() => {
      const frame = frameRef.current;
      const target = frameCanAnswer(frame) ? frame.contentWindow : null;
      if (!target) return;
      const id = `patch-${requestSeq.current += 1}`;
      patchId.current = id;
      target.postMessage(previewRevealPatchRequest(id), '*');
    }, [frameRef]);

    useImperativeHandle(ref, () => ({
      replay: () => {
        if (!active || blocked || !previewReady) return;
        setCompanion(null);
        setPlayback(null);
        postRequest();
      },
      summon: () => {
        if (!companion) return;
        setSummonKey((key) => key + 1);
      },
    }), [active, blocked, previewReady, postRequest, companion]);

    useEffect(() => {
      const frame = frameRef.current;
      if (!frame) return undefined;
      const onLoad = () => setLoadTick((tick) => tick + 1);
      frame.addEventListener('load', onLoad);
      return () => frame.removeEventListener('load', onLoad);
    }, [frameRef, previewReady, active, sessionKey]);

    useEffect(() => {
      const onMessage = (event: MessageEvent) => {
        const frame = frameRef.current;
        if (!frame || event.source !== frame.contentWindow) return;
        // The page relays its own pointer, because DOM events never cross the
        // cross-origin frame boundary. Without it the host is blind to the mouse
        // whenever it is over the page, which is most of the time.
        const relayed = parsePreviewRevealPointer(event.data);
        if (relayed) {
          pointer.receive(relayed.inside ? { x: relayed.x, y: relayed.y } : null);
          return;
        }
        const blueprint = parsePreviewRevealBlueprint(event.data);
        if (!blueprint) return;
        // A patch answers a different request than a full snapshot: it names the
        // boxes that just changed, and it plays as a small curtain rather than a
        // page build.
        if (isPreviewRevealPatch(event.data)) {
          if (blueprint.requestId !== patchId.current) return;
          patchId.current = null;
          if (blueprint.layers.length === 0) return;
          setPatch(blueprint);
          return;
        }
        if (blueprint.requestId !== pendingId.current) return;
        pendingId.current = null;
        if (blueprint.layers.length === 0) return;
        // A new build always starts from the swarm, never from a leftover cursor.
        setCompanion(null);
        setPatch(null);
        setPlayback(blueprint);
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, [frameRef, pointer]);

    useEffect(() => {
      if (identity.current !== sessionKey) {
        identity.current = sessionKey;
        armAutoplay(false);
        wasStreaming.current = streaming;
        setPlayback(null);
        setCompanion(null);
        return;
      }
      if (wasStreaming.current && !streaming) armAutoplay(true);
      wasStreaming.current = streaming;
      if (reducedMotion) armAutoplay(false);
      if (!pendingAutoplay.current) return;
      // The gate is re-evaluated on every dependency change, and `previewReady`
      // lands a tick or two after the stream ends (the iframe still has to
      // navigate and paint). Keeping `pendingAutoplay` armed until it succeeds
      // is what stops the handoff from being dropped on the floor: the crew
      // would disappear with nothing left on screen to replace it.
      if (!shouldQueuePreviewRevealAutoplay({
        streamingEnded: true,
        active,
        blocked,
        previewReady,
        reducedMotion,
      })) return;
      if (!postRequest()) return;
      armAutoplay(false);
      claimPreviewRevealAutoplay(sessionKey);
    }, [active, blocked, streaming, previewReady, reducedMotion, sessionKey, loadTick, postRequest, armAutoplay]);

    // While a run is streaming into a page that is already on screen, poll for
    // the boxes that changed so each edit gets its own small curtain. Coalesced
    // on a timer: an agent writing HTML mutates the DOM far faster than a patch
    // is worth drawing, and one patch per burst reads as an edit where one patch
    // per mutation reads as noise.
    useEffect(() => {
      if (!streaming || !active || blocked || !previewReady || reducedMotion) return undefined;
      const timer = window.setInterval(() => {
        // A patch is a second curtain, not a replacement for a running build:
        // skip while the full stage is on screen or another patch is playing.
        if (playback || patch) return;
        postPatchRequest();
      }, PATCH_POLL_MS);
      return () => window.clearInterval(timer);
    }, [streaming, active, blocked, previewReady, reducedMotion, playback, patch, postPatchRequest]);

    // Leaving the preview (source tab, manual edit, board) puts the cursor away;
    // it belongs to the page it was watching.
    useEffect(() => {
      if (active && !blocked) return;
      setCompanion(null);
      setPlayback(null);
    }, [active, blocked]);

    const replay = useCallback(() => {
      if (!active || blocked || !previewReady) return;
      setCompanion(null);
      setPlayback(null);
      postRequest();
    }, [active, blocked, previewReady, postRequest]);

    const finish = useCallback((handoff: PreviewRevealHandoff) => {
      setPlayback(null);
      setCompanion(handoff);
    }, []);

    const dismiss = useCallback(() => {
      setPlayback(null);
      setCompanion(null);
    }, []);

    // Generation owns the surface from its first frame to its last. While the
    // run is streaming the crew circles; the moment the page lands the build
    // stage takes over with the same crew. This replaces the skeleton screen
    // outright: there is no state in which the viewer shows a wireframe card
    // instead of the thing that is actually happening.
    //
    // The handover has a gap: the stream can end before the iframe has navigated
    // and painted (`previewReady` trails it by a tick), and during that gap the
    // build stage cannot start yet. Keeping the crew on screen until the
    // playback actually exists is what makes the two acts continuous instead of
    // flashing an empty pane between them.
    const working = active
      && !blocked
      && !playback
      && (streaming || (autoplayArmed && previewReady === false));
    if (!playback && !companion && !working && !patch) return null;

    // One overlay owns both acts: the curtain, and the cursor it leaves behind.
    // Keeping them in one container means the handoff point is the same
    // coordinate space on both sides, so the merge lands exactly where the
    // survivor then rests.
    return (
      <div ref={surfaceRef} className={styles.host} data-testid="preview-reveal-host">
        {working && !playback ? (
          <PreviewRevealWorking
            sessionKey={sessionKey}
            pointer={pointer}
            reducedMotion={reducedMotion}
          />
        ) : null}
        {patch ? (
          <PreviewRevealPatch
            key={patch.requestId}
            blueprint={patch}
            onDone={() => setPatch(null)}
          />
        ) : null}
        {playback ? (
          <PreviewRevealStage
            key={playback.requestId}
            blueprint={playback}
            labels={labels}
            pointer={pointer}
            onDone={finish}
            onSkip={dismiss}
          />
        ) : null}
        {companion ? (
          <PreviewCompanion
            seed={companion}
            surfaceRef={surfaceRef}
            pointer={pointer}
            reducedMotion={reducedMotion}
            summonKey={summonKey}
            onReveal={replay}
          />
        ) : null}
      </div>
    );
  },
);

export type { PointerRuntime };
