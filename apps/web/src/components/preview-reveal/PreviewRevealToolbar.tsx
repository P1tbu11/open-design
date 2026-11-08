/**
 * The toolbar control that replays the build — drawn as the cursor itself.
 *
 * Replay and "the agent working on this page" are the same idea, so the button
 * is not a generic icon: it is the same arrow the curtain draws, in the same
 * palette, breathing the way the parked cursor does. Hovering or focusing it
 * pokes the cursor on the page (`summon`), which is what makes the toolbar and
 * the cursor read as one assistant rather than a button and a decoration.
 *
 * This is also the shape every future HTML-page action on this toolbar should
 * take: the cursor stands for "the agent will do something to this page".
 */

import { CursorGlyph } from './CursorGlyph';
import { REVEAL_LEAD_COLOR } from './swarm';
import styles from './PreviewRevealToolbar.module.css';

export function PreviewRevealReplayButton({
  label,
  disabled,
  onReplay,
  onSummon,
}: {
  label: string;
  disabled: boolean;
  onReplay: () => void;
  onSummon: () => void;
}) {
  return (
    <button
      type="button"
      className={`icon-only od-tooltip ${styles.trigger}`}
      data-testid="preview-reveal-replay"
      title={label}
      data-tooltip={label}
      data-tooltip-placement="bottom"
      aria-label={label}
      disabled={disabled}
      onClick={onReplay}
      onPointerEnter={onSummon}
      onFocus={onSummon}
    >
      <span className={styles.glyph} aria-hidden="true">
        <CursorGlyph color={REVEAL_LEAD_COLOR} anchor="center" renderedSize={20} />
      </span>
    </button>
  );
}
