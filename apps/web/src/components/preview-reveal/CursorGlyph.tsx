/**
 * One arrow cursor, drawn from the reference's own path.
 *
 * Every surface that shows the agent — the cursors mid-build, the companion
 * that stays behind, and the replay control in the viewer toolbar — draws this
 * same glyph, so "the thing that builds the page" is one recognizable object
 * rather than an icon that happens to sit next to it.
 */

import { REVEAL_ARROW_HOTSPOT, REVEAL_ARROW_PATH } from './swarm';

export function CursorGlyph({
  color,
  ink = '#ffffff',
  angle = 0,
  scale = 1,
  className,
}: {
  color: string;
  ink?: string;
  /** Degrees. 0 points up-left, which is the path's own orientation. */
  angle?: number;
  scale?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width="28"
      height="28"
      viewBox="0 0 28 28"
      aria-hidden="true"
      focusable="false"
      style={{
        overflow: 'visible',
        transformOrigin: `${REVEAL_ARROW_HOTSPOT.x}px ${REVEAL_ARROW_HOTSPOT.y}px`,
        transform: `translate(${-REVEAL_ARROW_HOTSPOT.x}px, ${-REVEAL_ARROW_HOTSPOT.y}px) rotate(${angle}deg) scale(${scale})`,
      }}
    >
      <path
        d={REVEAL_ARROW_PATH}
        fill={color}
        stroke={ink}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
