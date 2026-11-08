/**
 * One arrow cursor, drawn from the reference's own path.
 *
 * Every surface that shows the agent — the cursors mid-build, the companion
 * that stays behind, and the replay control in the viewer toolbar — draws this
 * same glyph, so "the thing that builds the page" is one recognizable object
 * rather than an icon that happens to sit next to it.
 *
 * Two anchoring modes, because the same sprite is used two ways:
 *
 * - `anchor="tip"` (default): the SVG is shifted by the arrow's hot spot so the
 *   element's own position IS the pointer position. That is what the overlay
 *   cursors need — they are placed at a coordinate and the arrow must point
 *   from exactly there.
 * - `anchor="center"`: the sprite is centred on its painted ink instead. A
 *   button wants the arrow to look centred, and neither the viewBox centre nor
 *   the hot spot is that point: the ink's bounding box is centred at
 *   (12.85, 11.95) in a 28×28 viewBox whose centre is (14, 14). Using the tip
 *   anchor there put the visible glyph 5.3px left and 3.5px above the button
 *   centre.
 */

import { REVEAL_ARROW_HOTSPOT, REVEAL_ARROW_PATH } from './swarm';

/** Size of the drawing canvas the path is authored in. */
const VIEWBOX = 28;
/** Centre of the arrow's painted ink, measured from the path's bounding box. */
const INK_CENTRE = { x: 12.85, y: 11.95 };

/**
 * A soft cast shadow under the arrow, so it reads as a physical object lying on
 * the page rather than a flat sticker pasted over it.
 *
 * Two layers instead of one: a tight one that gives the edge a little weight,
 * and a wide, very faint one that reads as ambient occlusion. A single blur
 * strong enough to be visible at this size also smears the arrow's own outline,
 * which is what makes small icons look muddy.
 *
 * `drop-shadow` rather than `box-shadow` because the sprite is a transparent SVG
 * path: a box shadow would draw shadow around a rectangle nobody can see.
 */
const GLYPH_SHADOW =
  'drop-shadow(0 1px 1.5px rgba(16, 24, 40, 0.20)) drop-shadow(0 3px 7px rgba(16, 24, 40, 0.08))';

export function CursorGlyph({
  color,
  ink = '#ffffff',
  angle = 0,
  scale = 1,
  anchor = 'tip',
  /** CSS pixel size of the rendered box, used to scale the centring correction. */
  renderedSize,
  shadow = true,
  className,
}: {
  color: string;
  ink?: string;
  /** Degrees. 0 points up-left, which is the path's own orientation. */
  angle?: number;
  scale?: number;
  /**
   * `tip` positions the sprite by its pointer hot spot (overlay cursors);
   * `center` centres its painted ink (toolbar icons).
   */
  anchor?: 'tip' | 'center';
  /** CSS pixel size of the rendered box, used to scale the centring correction. */
  renderedSize?: number;
  /** Set false where a shadow would only add noise (tiny, decorative use). */
  shadow?: boolean;
  className?: string;
}) {
  const centred = anchor === 'center';
  // A centred sprite keeps rotation around the ink too, so a rotated toolbar
  // glyph would still spin in place rather than sweep around an empty corner.
  const origin = centred ? INK_CENTRE : REVEAL_ARROW_HOTSPOT;
  // The shift is expressed in viewBox units, but it is applied as a CSS
  // translate on the rendered box — so a sprite drawn at 20px needs it scaled by
  // 20/28, or the correction lands short by exactly that ratio.
  const unit = centred && renderedSize ? renderedSize / VIEWBOX : 1;
  const shift = centred
    ? {
      x: (VIEWBOX / 2 - INK_CENTRE.x) * unit,
      y: (VIEWBOX / 2 - INK_CENTRE.y) * unit,
    }
    : { x: -REVEAL_ARROW_HOTSPOT.x, y: -REVEAL_ARROW_HOTSPOT.y };

  return (
    <svg
      className={className}
      width={VIEWBOX}
      height={VIEWBOX}
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      aria-hidden="true"
      focusable="false"
      style={{
        overflow: 'visible',
        // The shadow rides on the same transform as the sprite so it rotates and
        // scales with it rather than sitting in screen space.
        filter: shadow ? GLYPH_SHADOW : undefined,
        transformOrigin: `${origin.x}px ${origin.y}px`,
        transform: `translate(${shift.x}px, ${shift.y}px) rotate(${angle}deg) scale(${scale})`,
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
