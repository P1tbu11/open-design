/**
 * One pointer reading, shared by every surface that reacts to the mouse.
 *
 * The curtain and the cursor it leaves behind have to agree about where the
 * pointer is and how fast it is travelling: the reference's knock-out bounce is
 * relative to the pointer's own velocity, and a second, slightly different
 * reading would make the two feel like different animals. So the host owns
 * exactly one of these and both acts read it.
 *
 * The listener is on `window`, like the reference: the swarm keeps its bearing
 * while the mouse crosses the viewer chrome around the preview, and only lets
 * go when it leaves the document entirely.
 */

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { createPressTrack, trackPointer, type PressPoint, type PressTrack } from './press';

/** How far outside the preview still counts as "over it". */
const MARGIN = 40;
/** One jittery sample must not inflate the crew, so travel is smoothed. */
const SPEED_SMOOTHING = 0.72;
const SPEED_DECAY = 0.94;
const SPEED_CAP = 4000;

export interface PointerRuntime {
  /** Latest position in surface space, or null when the pointer is away. */
  point: PressPoint | null;
  /** Smoothed pointer velocity, for the reference's bounce. */
  track: PressTrack;
  /** Smoothed pointer travel in px/s, which is what grows the crew. */
  speed: number;
  /** Fold the samples since the last call into `speed` and `track`. */
  sample: (dt: number) => void;
  /** Record a reading from a surface the host cannot listen on (the iframe). */
  receive: (point: PressPoint | null) => void;
  /**
   * The live pointer, or where it was a moment ago.
   *
   * A build started from the toolbar has the pointer up on the button, not over
   * the page, so "gather beside the mouse" would have nothing to aim at. The
   * remembered reading covers that without pretending the mouse is somewhere it
   * is not: it is only used for a second or so, and the caller clamps it into
   * the surface it is about to draw in.
   */
  remembered: (maxAgeMs?: number) => PressPoint | null;
  /** Forget the pointer, e.g. when it leaves the document. */
  reset: () => void;
}

/** Travel below this is jitter, not motion: a resting hand must not inflate the crew. */
const DEAD_ZONE_PX = 0.5;
/** How long a pointer reading stays usable for "gather beside the mouse". */
const REMEMBER_MS = 1600;

export function usePointerRuntime(surfaceRef: RefObject<HTMLElement | null>): PointerRuntime {
  const rawRef = useRef(0);
  const lastRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const keptRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const runtime = useMemo<PointerRuntime>(() => {
    const apply = (x: number, y: number, at: number, inside: boolean) => {
      const previous = lastRef.current;
      if (inside && previous && at > previous.at) {
        const travelled = Math.hypot(x - previous.x, y - previous.y);
        // A relayed reading arrives on its own clock; a sub-pixel step is the
        // pointer resting, not a sample worth turning into speed.
        if (travelled >= DEAD_ZONE_PX) rawRef.current = travelled / ((at - previous.at) / 1000);
      }
      lastRef.current = inside ? { x, y, at } : null;
      if (inside) keptRef.current = { x, y, at };
      state.point = inside ? { x, y } : null;
    };
    const state: PointerRuntime = {
      point: null,
      track: createPressTrack(),
      speed: 0,
      sample(dt: number) {
        trackPointer(state.track, state.point, dt);
        state.speed = state.point
          ? state.speed * SPEED_SMOOTHING + Math.min(SPEED_CAP, rawRef.current) * (1 - SPEED_SMOOTHING)
          : state.speed * SPEED_DECAY;
        rawRef.current = 0;
      },
      receive(point: PressPoint | null) {
        apply(point?.x ?? 0, point?.y ?? 0, performance.now(), point !== null);
      },
      remembered(maxAgeMs = REMEMBER_MS) {
        if (state.point) return state.point;
        const kept = keptRef.current;
        if (!kept || performance.now() - kept.at > maxAgeMs) return null;
        return { x: kept.x, y: kept.y };
      },
      reset() {
        state.point = null;
        state.speed = 0;
        state.track.previous = null;
        state.track.velocity.x = 0;
        state.track.velocity.y = 0;
      },
    };
    return state;
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const inside = x >= -MARGIN && y >= -MARGIN && x <= rect.width + MARGIN && y <= rect.height + MARGIN;
      runtime.receive(inside ? { x, y } : null);
    };
    const onLeave = () => runtime.reset();
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
    };
  }, [runtime, surfaceRef]);

  return runtime;
}
