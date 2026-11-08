/**
 * A small curtain that plays over boxes which just changed.
 *
 * The full build assembles a whole page once. This is the other case: an agent
 * is editing a page that is already on screen, and a handful of its boxes are
 * rewritten. Replaying the whole curtain for that would flash everything the
 * agent did *not* touch, so the patch draws only the changed boxes — the rest of
 * the page keeps being the page.
 *
 * Two things make a patch read as an edit rather than a second build:
 *
 * - It is short. A box is drawn in `PATCH_DRAW_MS`, not the full gesture; the
 *   user is watching an edit land, not watching a page be assembled.
 * - It uses a tiny crew. Two arrows are enough to say "this changed", and a full
 *   swarm over a single button would be absurd.
 *
 * The physics is the same flock as everywhere else, so the movement still
 * belongs to the same animal.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createFlockState, flockColorOf, stepFlock } from './flock';
import { REVEAL_AGENTS, REVEAL_PRESS_SCALE, revealLayerFrame } from './swarm';
import type { PreviewRevealBlueprint } from '@open-design/contracts/runtime/preview-reveal';
import { CursorGlyph } from './CursorGlyph';
import styles from './PreviewReveal.module.css';

/** How long a patched box takes to draw itself in. */
export const PATCH_DRAW_MS = 340;
/** How long it then holds before the patch is done and can be dropped. */
export const PATCH_HOLD_MS = 220;
/** Enough to read as "the crew did this", few enough to not be a light show. */
const PATCH_CREW = 2;

export function patchedFrames(blueprint: PreviewRevealBlueprint, elapsed: number) {
  return blueprint.layers.map((layer) => ({
    layer,
    frame: revealLayerFrame({
      layer,
      master: null,
      action: layer.kind === 'text' ? 'type' : 'draw',
      startMs: 0,
      durationMs: PATCH_DRAW_MS,
      now: elapsed,
    }),
  }));
}

export function PreviewRevealPatch({
  blueprint,
  onDone,
}: {
  blueprint: PreviewRevealBlueprint;
  onDone: () => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const flock = useMemo(
    () => createFlockState({ x: blueprint.viewport.width / 2, y: blueprint.viewport.height / 2 }, REVEAL_AGENTS.length),
    [blueprint.requestId],
  );
  const [now, setNow] = useState(0);

  useEffect(() => {
    let frame = 0;
    const started = performance.now();
    let last = 0;
    const tick = (time: number) => {
      const elapsed = time - started;
      const dt = last === 0 ? 1 / 60 : (time - last) / 1000;
      last = time;
      stepFlock({
        state: flock,
        dt,
        time: elapsed,
        pointer: null,
        track: { velocity: { x: 0, y: 0 }, previous: null },
        pointerSpeed: 0,
        pending: 0,
        anchor: { x: blueprint.viewport.width / 2, y: blueprint.viewport.height / 2 },
        work: () => null,
        phase: 'flock',
      });
      setNow(elapsed);
      if (elapsed >= PATCH_DRAW_MS + PATCH_HOLD_MS) {
        onDoneRef.current();
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [blueprint, flock]);

  const frames = patchedFrames(blueprint, now);
  // The patch surface is always drawn at the blueprint's own size and scaled
  // onto whatever box the stage has; one factor, never per-axis, so the changed
  // boxes keep the shape the page gave them.
  const stage = stageRef.current;
  const fit = Math.min(
    (stage?.clientWidth ?? blueprint.viewport.width) / blueprint.viewport.width,
    (stage?.clientHeight ?? blueprint.viewport.height) / blueprint.viewport.height,
  );

  return (
    <div ref={stageRef} className={styles.patchStage} data-testid="preview-reveal-patch" aria-hidden="true">
      <div
        className={styles.canvas}
        style={{
          width: blueprint.viewport.width,
          height: blueprint.viewport.height,
          transform: `translate(-50%, -50%) scale(${fit})`,
          left: '50%',
          top: '50%',
        }}
      >
        {frames.map(({ layer, frame }) => (
          <div
            key={layer.id}
            className={styles.layer}
            data-kind={layer.kind}
            style={{
              transform: `translate(${frame.x}px, ${frame.y}px)`,
              width: frame.w,
              height: frame.h,
              borderRadius: layer.radius,
            }}
          >
            {layer.kind === 'text' && frame.typed > 0 ? (
              <div
                className={styles.patchText}
                // The bridge already sized this in the overlay's coordinate
                // space; see the note in RevealText.
                dangerouslySetInnerHTML={layer.html ? { __html: layer.html } : undefined}
                style={layer.html ? undefined : { fontSize: layer.size }}
                ref={(node) => {
                  if (node && layer.style) node.setAttribute('style', layer.style);
                }}
              >
                {layer.html ? null : layer.text}
              </div>
            ) : null}
            {layer.kind === 'rect' && frame.fillOpacity > 0 ? (
              <span
                className={styles.fill}
                style={{ borderRadius: layer.radius, background: layer.fill || 'transparent', opacity: frame.fillOpacity }}
              />
            ) : null}
            {layer.kind === 'image' && frame.fillOpacity > 0 && layer.src ? (
              <img
                className={styles.media}
                alt=""
                src={layer.src}
                style={{ opacity: frame.fillOpacity }}
              />
            ) : null}
          </div>
        ))}
      </div>
      {flock.cursors.slice(0, PATCH_CREW).map((cursor) => (
        <div key={cursor.id} className={styles.cursor} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}>
          <CursorGlyph
            className={styles.pointer}
            color={flockColorOf(cursor, REVEAL_AGENTS.map((agent) => agent.color))}
            angle={cursor.angle}
            scale={REVEAL_PRESS_SCALE}
          />
        </div>
      ))}
    </div>
  );
}
