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
  parsePreviewRevealBlueprint,
  previewRevealRequest,
  type PreviewRevealBlueprint,
  type PreviewRevealLayer,
} from '@open-design/contracts/runtime/preview-reveal';
import { useT } from '../../i18n';
import {
  claimPreviewRevealAutoplay,
  planPreviewReveal,
  shouldQueuePreviewRevealAutoplay,
} from './plan';
import { cursorWork, REVEAL_AGENTS, REVEAL_ARROW_HOTSPOT, REVEAL_ARROW_PATH, revealLayerFrame, type CursorWork } from './swarm';
import { createFlockState, flockColorOf, stepFlock, type FlockPoint } from './flock';
import { RevealSound } from './sound';
import styles from './PreviewReveal.module.css';

export interface PreviewRevealHandle {
  replay: () => void;
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

const FADE_MS = 180;

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
 * A text layer, revealed by wiping its cloned markup sideways. The page's own
 * computed type stack is applied through `styleText`, so font, spacing, weight
 * and stroke stay exactly as the page rendered them — nothing is re-guessed.
 */
function RevealText({
  className,
  styleText,
  html,
  fallback,
  scale,
  typed,
}: {
  className: string | undefined;
  styleText: string;
  html: string;
  fallback: string;
  scale: number;
  typed: number;
}) {
  const cloneRef = useRef<HTMLDivElement | null>(null);
  // The page's computed typography arrives as a CSS text string. Writing it onto
  // the node verbatim keeps every property React's style object would normalise.
  // `white-space` comes along with it, so a wrapped heading stays wrapped instead
  // of being flattened to one clipped line by the overlay's own CSS.
  const applyStyle = useCallback((node: HTMLDivElement | null) => {
    cloneRef.current = node;
    if (!node) return;
    node.setAttribute('style', styleText);
    if (scale && scale !== 1) {
      node.style.transform = `scale(${scale})`;
      node.style.transformOrigin = 'top left';
    }
  }, [styleText, scale]);

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
  onDone,
  onSkip,
}: {
  blueprint: PreviewRevealBlueprint;
  labels: PreviewRevealLabels;
  onDone: () => void;
  onSkip: () => void;
}) {
  const plan = useMemo(() => planPreviewReveal(blueprint), [blueprint]);
  const [now, setNow] = useState(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const flock = useMemo(
    () => createFlockState(
      { x: blueprint.viewport.width / 2, y: blueprint.viewport.height / 2 },
      REVEAL_AGENTS.length,
    ),
    [blueprint.requestId, blueprint.viewport.width, blueprint.viewport.height],
  );
  const pointerRef = useRef<FlockPoint | null>(null);
  const pointerSpeedRef = useRef(0);
  const lastPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const pendingRef = useRef(0);
  const lastFrameRef = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const soundRef = useRef<RevealSound | null>(null);
  const soundedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // The audio context has to be created inside a user gesture, so it is armed
    // on the first pointer/key event the stage sees, and on the replay click.
    const sound = new RevealSound();
    soundRef.current = sound;
    soundedRef.current = new Set();
    return () => {
      sound.dispose();
      soundRef.current = null;
    };
  }, [blueprint.requestId]);

  // The pointer is tracked on window, like the original, so the swarm keeps its
  // bearing even while the cursor crosses the chrome around the preview.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      soundRef.current?.arm();
      const rect = stage.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const inside = x >= -40 && y >= -40 && x <= rect.width + 40 && y <= rect.height + 40;
      const now = performance.now();
      const last = lastPointerRef.current;
      if (inside && last && now > last.at) {
        const travelled = Math.hypot(x - last.x, y - last.y);
        const speed = (travelled / ((now - last.at) / 1000));
        // Smooth the reading so one jittery sample cannot inflate the crew.
        pointerSpeedRef.current = pointerSpeedRef.current * 0.72 + Math.min(4000, speed) * 0.28;
      }
      if (!inside) pointerSpeedRef.current *= 0.8;
      lastPointerRef.current = inside ? { x, y, at: now } : null;
      pointerRef.current = inside ? { x, y } : null;
    };
    const onLeave = () => {
      pointerRef.current = null;
      pointerSpeedRef.current = 0;
      lastPointerRef.current = null;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
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
      const currentFrames = placedFrames(blueprint, plan, elapsed);
      const anchor = anchorOf(currentFrames, blueprint.viewport);
      pendingRef.current = plan.tasks.filter((task) => task.startMs + task.durationMs > elapsed).length;
      pointerSpeedRef.current *= 0.94;
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
      stepFlock({
        state: flock,
        dt,
        time: elapsed,
        pointer: pointerRef.current,
        pointerSpeed: pointerSpeedRef.current,
        pending: pendingRef.current,
        anchor,
        phase: elapsed >= plan.buildMs ? 'flock' : 'build',
        work: (cursor) => {
          if (cursor.agent < 0) return null;
          const agent = REVEAL_AGENTS[cursor.agent];
          if (!agent || !agent.works) return null;
          const work = agentWork(currentFrames, agent.id, elapsed);
          return work ? { x: work.x, y: work.y, blend: work.blend } : null;
        },
      });
      setNow(elapsed);
      if (elapsed >= plan.durationMs + FADE_MS) {
        onDoneRef.current();
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [blueprint, plan, flock]);

  const trackPointer = useCallback((event: { currentTarget: EventTarget | null; clientX: number; clientY: number }) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const rect = target.getBoundingClientRect();
    pointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

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

  const fade = now > plan.durationMs ? Math.min(1, (now - plan.durationMs) / FADE_MS) : 0;
  const frames = placedFrames(blueprint, plan, now);

  return (
    <div
      ref={stageRef}
      className={styles.stage}
      style={{ background: blueprint.background, opacity: 1 - fade }}
      role="status"
      aria-label={labels.status}
      data-testid="preview-reveal"
      onPointerMove={trackPointer}
      onPointerDown={trackPointer}
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
                scale={layer.scale ?? 1}
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
            {frame.dragging ? (
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
      {flock.cursors.map((cursor) => {
        const agent = cursor.agent >= 0 ? REVEAL_AGENTS[cursor.agent] : undefined;
        const role = agent?.role ?? 'layout';
        const leavingFade = cursor.leaving > 0 ? 1 - cursor.leaving : 1;
        return (
          <div
            key={cursor.id}
            className={styles.cursor}
            data-cursor={role}
            data-testid={agent && agent.id < 3 ? `preview-reveal-cursor-${role}` : undefined}
            style={{
              transform: `translate(${cursor.x}px, ${cursor.y}px)`,
              opacity: leavingFade,
            }}
          >
            <svg
              className={styles.pointer}
              width="28"
              height="28"
              viewBox="0 0 28 28"
              aria-hidden="true"
              style={{
                transformOrigin: `${REVEAL_ARROW_HOTSPOT.x}px ${REVEAL_ARROW_HOTSPOT.y}px`,
                transform: `translate(${-REVEAL_ARROW_HOTSPOT.x}px, ${-REVEAL_ARROW_HOTSPOT.y}px) rotate(${cursor.angle}deg) scale(${(1 - cursor.press * 0.12) * (1 - cursor.leaving * 0.35)})`,
              }}
            >
              <path
                d={REVEAL_ARROW_PATH}
                fill={flockColorOf(cursor, REVEAL_AGENTS.map((item) => item.color))}
                stroke="#fff"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        );
      })}
      <button type="button" className={styles.skip} data-testid="preview-reveal-skip" onClick={onSkip}>
        {labels.skip}
      </button>
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
    const requestSeq = useRef(0);
    const wasStreaming = useRef(streaming);
    const identity = useRef(sessionKey);
    const pendingAutoplay = useRef(false);
    const [loadTick, setLoadTick] = useState(0);
    const [playback, setPlayback] = useState<PreviewRevealBlueprint | null>(null);

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

    useImperativeHandle(ref, () => ({
      replay: () => {
        if (!active || blocked || !previewReady) return;
        setPlayback(null);
        postRequest();
      },
    }), [active, blocked, previewReady, postRequest]);

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
        const blueprint = parsePreviewRevealBlueprint(event.data);
        if (!blueprint || blueprint.requestId !== pendingId.current) return;
        pendingId.current = null;
        if (blueprint.layers.length === 0) return;
        setPlayback(blueprint);
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, [frameRef]);

    useEffect(() => {
      if (identity.current !== sessionKey) {
        identity.current = sessionKey;
        pendingAutoplay.current = false;
        wasStreaming.current = streaming;
        setPlayback(null);
        return;
      }
      if (wasStreaming.current && !streaming) pendingAutoplay.current = true;
      wasStreaming.current = streaming;
      if (reducedMotion) pendingAutoplay.current = false;
      if (!pendingAutoplay.current) return;
      if (!shouldQueuePreviewRevealAutoplay({
        streamingEnded: true,
        active,
        blocked,
        previewReady,
        reducedMotion,
      })) return;
      if (!postRequest()) return;
      pendingAutoplay.current = false;
      claimPreviewRevealAutoplay(sessionKey);
    }, [active, blocked, streaming, previewReady, reducedMotion, sessionKey, loadTick, postRequest]);

    const dismiss = useCallback(() => setPlayback(null), []);
    if (!playback) return null;
    return (
      <PreviewRevealStage
        key={playback.requestId}
        blueprint={playback}
        labels={labels}
        onDone={dismiss}
        onSkip={dismiss}
      />
    );
  },
);
