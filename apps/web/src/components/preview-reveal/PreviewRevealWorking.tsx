/**
 * The surface shown while a page is still being generated.
 *
 * Generation used to be two unrelated things: a skeleton screen until the file
 * landed, then a reveal animation once it had. They are one event — a page is
 * being built — so the reveal's own crew is what the user sees for the whole of
 * it. This is the first act: the swarm circling with nothing to draw yet, for as
 * long as generation runs.
 *
 * It is deliberately the same physics as the build stage rather than a spinner:
 * same arrow, same palette, same orbit constants, same collision. The crew
 * circling here hands over to the crew that assembles the page a moment later,
 * and any difference in feel would read as a cut between two features instead of
 * one continuous build.
 */

import { useEffect, useRef, type RefObject } from 'react';
import { useT } from '../../i18n';
import { createFlockState, FLOCK_AGENTS, stepFlock } from './flock';
import { REVEAL_AGENTS } from './swarm';
import type { PointerRuntime } from './pointer';
import { CursorGlyph } from './CursorGlyph';
import styles from './PreviewReveal.module.css';

const ROLE_COLORS = REVEAL_AGENTS.map((agent) => agent.color);
/** One node per cursor the flock can hold at its working size. */
const POOL = FLOCK_AGENTS;

export function PreviewRevealWorking({
  /** Changes when the file or run changes, so the crew restarts per build. */
  sessionKey,
  pointer,
  reducedMotion,
}: {
  sessionKey: string;
  pointer: PointerRuntime;
  reducedMotion: boolean;
}) {
  const t = useT();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef<Array<HTMLDivElement | null>>([]);
  const flockRef = useRef(createFlockState({ x: 0, y: 0 }, REVEAL_AGENTS.length));
  const seededRef = useRef(false);

  useEffect(() => {
    seededRef.current = false;
    flockRef.current = createFlockState({ x: 0, y: 0 }, REVEAL_AGENTS.length);
  }, [sessionKey]);

  useEffect(() => {
    let frame = 0;
    let last = 0;
    const started = performance.now();
    const tick = (time: number) => {
      const dt = last === 0 ? 1 / 60 : (time - last) / 1000;
      last = time;
      const stage = stageRef.current;
      if (stage) {
        const rect = stage.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Gather on the pointer when it is over the preview, and on the middle
          // of the surface otherwise — the same rule the build stage uses. A
          // crew that only ever circles the centre of the pane reads as a
          // decoration; one that gathers where the user is looking reads as
          // working for them.
          const anchor = pointer.point
            ? { x: pointer.point.x, y: pointer.point.y }
            : { x: rect.width / 2, y: rect.height / 2 };
          // The crew walks in from wherever it is gathering the first time there
          // is a real box to walk into.
          if (!seededRef.current) {
            seededRef.current = true;
            flockRef.current = createFlockState(anchor, REVEAL_AGENTS.length);
          }
          const flock = flockRef.current;
          // `build` rather than `flock`: the build phase is the one that holds a
          // small working crew near its anchor, which is what this is. The
          // `flock` phase exists for the finale — it inflates the crew to
          // FLOCK_AGENTS and lets the orbit ring swing to 1.18x, which on a
          // waiting surface reads as twelve arrows milling in a wide circle
          // instead of a crew hovering over the work.
          stepFlock({
            state: flock,
            dt: reducedMotion ? 0 : dt,
            time: time - started,
            pointer: pointer.point,
            track: pointer.track,
            // Travel does not grow this crew: nothing is being measured, and a
            // waiting surface whose population changes every time the mouse
            // moves looks unstable rather than busy.
            pointerSpeed: 0,
            pending: 0,
            anchor,
            work: () => null,
            phase: 'build',
          });
          // Position whoever is alive; park the rest. Writing transforms here
          // rather than through React keeps this off the render path.
          flock.cursors.forEach((cursor, index) => {
            const node = nodesRef.current[index];
            if (!node) return;
            node.style.transform = `translate(${cursor.x.toFixed(2)}px, ${cursor.y.toFixed(2)}px)`;
            node.style.opacity = cursor.leaving > 0 ? String(1 - cursor.leaving) : '1';
          });
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [pointer, reducedMotion]);

  return (
    <div
      ref={stageRef}
      className={styles.working}
      role="status"
      aria-busy="true"
      aria-label={t('fileViewer.previewReveal.status')}
      data-testid="preview-reveal-working"
    >
      {Array.from({ length: POOL }, (_, index) => (
        <div
          key={index}
          ref={(node) => {
            nodesRef.current[index] = node;
          }}
          className={styles.workingCursor}
          data-working-cursor={index}
          aria-hidden="true"
        >
          <CursorGlyph
            className={styles.pointer}
            // A colour per node, stable across frames: the pooled nodes are
            // fixed, so each keeps the palette slot of the cursor that will
            // occupy it.
            color={ROLE_COLORS[index % ROLE_COLORS.length]!}
          />
        </div>
      ))}
    </div>
  );
}
