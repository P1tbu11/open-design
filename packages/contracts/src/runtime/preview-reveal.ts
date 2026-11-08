/**
 * Cross-runtime protocol for the HTML preview "build" curtain.
 *
 * The preview iframe is sandboxed without `allow-same-origin`, so the host
 * cannot read its document. This bridge only measures the already-rendered
 * page and posts boxes back. The host draws the cursors. The page file is
 * not modified, and nothing here is a copy of another project's engine.
 *
 * Keep this module browser-API free. The browser code is serialized as a
 * string so the web srcDoc path and the daemon URL-preview path inject the
 * same script.
 */

export const PREVIEW_REVEAL_BRIDGE_MARKER = 'data-od-preview-reveal';
export const PREVIEW_REVEAL_PROTOCOL_VERSION = 1;
export const PREVIEW_REVEAL_REQUEST_TYPE = 'od:preview-reveal-snapshot';
export const PREVIEW_REVEAL_RESPONSE_TYPE = 'od:preview-reveal-blueprint';
/**
 * The page relays its own pointer to the host.
 *
 * The preview iframe is cross-origin by construction (`sandbox` without
 * `allow-same-origin`), so a `pointermove` over the page never reaches the
 * host's window: DOM events do not cross an iframe boundary. Anything that has
 * to react to the mouse while the user is reading or scrolling the page — the
 * cursor that stays after the build, above all — therefore needs the page to
 * say where the pointer is. This is that one message.
 */
export const PREVIEW_REVEAL_POINTER_TYPE = 'od:preview-reveal-pointer';
/**
 * A patch: the boxes that changed since the last snapshot.
 *
 * The full-surface blueprint is right for a first load, where the whole page is
 * new. While an agent is editing an existing page most of it is unchanged, and
 * re-measuring and re-drawing all of it on every keystroke is both wasteful and
 * visually wrong — the parts nobody touched would flash. A patch names just the
 * elements that mutated so the overlay can curtain those and leave the rest
 * alone.
 *
 * The message shape is identical to a blueprint (same `parsePreviewRevealBlueprint`
 * contract, same `layers` array); only the type and the intent differ, so a
 * patch can never smuggle in a shape the renderer does not already handle.
 */
export const PREVIEW_REVEAL_PATCH_TYPE = 'od:preview-reveal-patch';
/** What the host sends to ask for a patch of the elements that changed. */
export const PREVIEW_REVEAL_PATCH_REQUEST_TYPE = 'od:preview-reveal-patch-request';
/** First-screen choreography. Past this, the curtain stops being a curtain. */
export const PREVIEW_REVEAL_LAYER_CAP = 36;
/**
 * How many changed boxes a single patch may carry.
 *
 * A patch is meant to be a handful of boxes the agent just touched, not a second
 * full snapshot — a page-wide mutation (a re-render, a stylesheet swap) would
 * otherwise queue 36 curtains at once, which reads as a flash rather than an
 * edit. Anything past this is left to the next patch or to a full replay.
 */
export const PREVIEW_REVEAL_PATCH_CAP = 8;
const MAX_COORDINATE = 20_000;
const MAX_TEXT = 80;
const MAX_SRC = 1_800;
/** A cloned text node: enough for real markup, bounded so a runaway page cannot bloat the message. */
const MAX_HTML = 2_400;

export interface PreviewRevealRequest {
  type: typeof PREVIEW_REVEAL_REQUEST_TYPE;
  version: typeof PREVIEW_REVEAL_PROTOCOL_VERSION;
  id: string;
}

export interface PreviewRevealPatchRequest {
  type: typeof PREVIEW_REVEAL_PATCH_REQUEST_TYPE;
  version: typeof PREVIEW_REVEAL_PROTOCOL_VERSION;
  id: string;
}

/**
 * A pointer reading relayed from inside the page. Coordinates are in the
 * page's own viewport, which is the same box the blueprint measured.
 * `inside: false` is the page saying the pointer left it.
 */
export interface PreviewRevealPointer {
  type: typeof PREVIEW_REVEAL_POINTER_TYPE;
  version: typeof PREVIEW_REVEAL_PROTOCOL_VERSION;
  x: number;
  y: number;
  inside: boolean;
}

export type PreviewRevealKind = 'rect' | 'text' | 'image';

export interface PreviewRevealLayer {
  id: string;
  kind: PreviewRevealKind;
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  fill: string;
  color: string;
  weight: number;
  size: number;
  text: string;
    /** The page's own type stack and spacing, straight from computed style. */
    style: string;
    src: string;
  group: string | null;
  master: boolean;
  /** Layout-to-painted scale of the source element, so a clone lands at the right size. */
  scale: number;
  /**
   * Sanitized outerHTML of the source text node. Carries the page's real font
   * stack, spacing, stroke and weight, which a rebuilt span cannot reproduce.
   */
  html: string;
}

export interface PreviewRevealBlueprint {
  requestId: string;
  viewport: { width: number; height: number };
  background: string;
  layers: PreviewRevealLayer[];
}

export function previewRevealRequest(id: string): PreviewRevealRequest {
  return {
    type: PREVIEW_REVEAL_REQUEST_TYPE,
    version: PREVIEW_REVEAL_PROTOCOL_VERSION,
    id,
  };
}

/**
 * Ask the page for the boxes that changed since the last snapshot or patch.
 *
 * Fire-and-forget by design: the page answers only if something is actually
 * dirty, so a poll on an idle page costs one postMessage and no measurement.
 */
export function previewRevealPatchRequest(id: string): PreviewRevealPatchRequest {
  return {
    type: PREVIEW_REVEAL_PATCH_REQUEST_TYPE,
    version: PREVIEW_REVEAL_PROTOCOL_VERSION,
    id,
  };
}

const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(?:0|1|0?\.\d+)\s*)?\)|[a-zA-Z]{3,20})$/;
const SRC_PATTERN = /^(https?:|data:image\/[a-zA-Z0-9.+-]+;base64,|blob:)/;

function finiteBox(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > max) return null;
  return Math.round(value);
}

function cssColor(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return COLOR_PATTERN.test(trimmed) ? trimmed : '';
}

function imageSrc(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_SRC) return '';
  return SRC_PATTERN.test(value) ? value : '';
}

export function parsePreviewRevealPointer(data: unknown): PreviewRevealPointer | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (record.type !== PREVIEW_REVEAL_POINTER_TYPE) return null;
  if (record.version !== PREVIEW_REVEAL_PROTOCOL_VERSION) return null;
  const x = finiteBox(record.x, MAX_COORDINATE);
  const y = finiteBox(record.y, MAX_COORDINATE);
  if (x === null || y === null) return null;
  return { type: PREVIEW_REVEAL_POINTER_TYPE, version: PREVIEW_REVEAL_PROTOCOL_VERSION, x, y, inside: record.inside !== false };
}

/** Distinguishes a patch from a full blueprint. Cheaper than a second parser. */
export function isPreviewRevealPatch(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return (data as Record<string, unknown>).type === PREVIEW_REVEAL_PATCH_TYPE;
}

/**
 * The clone travels from the page under measurement to the same page's own
 * overlay, never to a third origin, and the caller owns that page. Still, only
 * the markup a text box needs survives: no script, no event handler, no
 * javascript: URL, no <style> or <iframe>.
 */
const ALLOWED_TAGS = new Set([
  'span', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup', 'mark',
  'font', 'br', 'code', 'kbd', 'abbr', 'time', 'small', 'ins', 'del', 'wbr',
]);

function cleanHtml(raw: string): string {
  let out = raw;
  // Strip anything that can execute or restyle.
  out = out.replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form|input|textarea|select|svg|math)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  out = out.replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form|input|textarea|select|svg|math)\b[^>]*\/?>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
  out = out.replace(/(?:javascript|vbscript|data:text\/html)\s*:/gi, '');
  // Drop tags outside the text allowlist, keeping their contents.
  out = out.replace(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (match, name: string) => {
    const tag = name.toLowerCase();
    return ALLOWED_TAGS.has(tag) ? match : '';
  });
  return out.slice(0, MAX_HTML);
}

export function parsePreviewRevealBlueprint(data: unknown): PreviewRevealBlueprint | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  // A patch is the same document with fewer layers, so it travels through the
  // same validator. The caller distinguishes them by asking `isPreviewRevealPatch`.
  if (record.type !== PREVIEW_REVEAL_RESPONSE_TYPE && record.type !== PREVIEW_REVEAL_PATCH_TYPE) return null;
  if (record.version !== PREVIEW_REVEAL_PROTOCOL_VERSION) return null;
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 80) return null;
  const viewport = record.viewport;
  if (!viewport || typeof viewport !== 'object') return null;
  const width = finiteBox((viewport as { width?: unknown }).width, MAX_COORDINATE);
  const height = finiteBox((viewport as { height?: unknown }).height, MAX_COORDINATE);
  if (!width || !height) return null;
  if (!Array.isArray(record.layers)) return null;
  const layers: PreviewRevealLayer[] = [];
  for (const entry of record.layers) {
    if (layers.length >= PREVIEW_REVEAL_LAYER_CAP) break;
    if (!entry || typeof entry !== 'object') continue;
    const layer = entry as Record<string, unknown>;
    if (layer.kind !== 'rect' && layer.kind !== 'text' && layer.kind !== 'image') continue;
    if (typeof layer.id !== 'string' || layer.id.length === 0 || layer.id.length > 40) continue;
    const x = finiteBox(layer.x, MAX_COORDINATE);
    const y = finiteBox(layer.y, MAX_COORDINATE);
    const w = finiteBox(layer.w, MAX_COORDINATE);
    const h = finiteBox(layer.h, MAX_COORDINATE);
    if (x === null || y === null || !w || !h) continue;
    const radius = finiteBox(layer.radius, 400) ?? 0;
    const weight = finiteBox(layer.weight, 900);
    const size = finiteBox(layer.size, 200);
    const text = typeof layer.text === 'string' ? layer.text.slice(0, MAX_TEXT) : '';
    layers.push({
      id: layer.id,
      kind: layer.kind,
      x,
      y,
      w,
      h,
      radius,
      fill: cssColor(layer.fill),
      color: cssColor(layer.color) || 'rgb(17, 17, 17)',
      weight: weight && weight >= 100 ? weight : 400,
      size: size && size >= 8 ? size : 16,
      text,
      style: layer.kind === 'text' && typeof layer.style === 'string' ? layer.style.slice(0, MAX_HTML) : '',
      src: imageSrc(layer.src),
      group: typeof layer.group === 'string' && layer.group.length > 0 && layer.group.length <= 80
        ? layer.group
        : null,
      master: layer.master === true,
      scale: typeof layer.scale === 'number' && Number.isFinite(layer.scale) && layer.scale > 0 && layer.scale <= 20
        ? layer.scale
        : 1,
      html: layer.kind === 'text' && typeof layer.html === 'string' ? cleanHtml(layer.html) : '',
    });
  }
  return {
    requestId: record.id,
    viewport: { width, height },
    background: cssColor(record.background) || 'rgb(255, 255, 255)',
    layers,
  };
}

export function buildPreviewRevealBridge(): string {
  return `<script ${PREVIEW_REVEAL_BRIDGE_MARKER}>
(function(){
  if (window.__odPreviewReveal) return;
  window.__odPreviewReveal = true;
  var REQUEST = ${JSON.stringify(PREVIEW_REVEAL_REQUEST_TYPE)};
  var RESPONSE = ${JSON.stringify(PREVIEW_REVEAL_RESPONSE_TYPE)};
  var POINTER = ${JSON.stringify(PREVIEW_REVEAL_POINTER_TYPE)};
  var PATCH = ${JSON.stringify(PREVIEW_REVEAL_PATCH_TYPE)};
  var PATCH_REQUEST = ${JSON.stringify(PREVIEW_REVEAL_PATCH_REQUEST_TYPE)};
  var PATCH_CAP = ${PREVIEW_REVEAL_PATCH_CAP};
  var VERSION = ${PREVIEW_REVEAL_PROTOCOL_VERSION};
  var CAP = ${PREVIEW_REVEAL_LAYER_CAP};
  var SELECTOR = 'img,svg,picture,p,h1,h2,h3,h4,h5,h6,li,button,a,span,label,div,section,article,header,footer,nav,main,aside,figure,ul,ol';
  function round(n){ return Math.round(n); }
  function painted(style, prop){
    var value = style.getPropertyValue(prop) || '';
    if (!value || value === 'none' || value === 'transparent' || value === 'rgba(0, 0, 0, 0)') return '';
    return value;
  }
  function hasOwnBox(style){
    if (painted(style, 'background-color')) return true;
    var image = style.getPropertyValue('background-image') || '';
    if (image && image !== 'none') return true;
    var shadow = style.getPropertyValue('box-shadow') || '';
    if (shadow && shadow !== 'none') return true;
    var width = parseFloat(style.borderTopWidth || '0');
    return width > 0 && style.borderTopStyle && style.borderTopStyle !== 'none';
  }
  function textOf(el){
    var text = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];
      if (node.nodeType === 3) text += node.nodeValue || '';
    }
    return text.replace(/\\s+/g, ' ').trim().slice(0, ${MAX_TEXT});
  }
  function weightOf(style){
    var value = String(style.fontWeight || '400');
    if (value === 'bold') return 700;
    if (value === 'normal') return 400;
    var n = parseInt(value, 10);
    if (!n || n < 100 || n > 900) return 400;
    return n;
  }
  /* getComputedStyle reports the font size before any ancestor transform, while
     getBoundingClientRect reports the painted box. On a page scaled by the preview
     shell the two disagree, so the size has to be brought through the same scale. */
  function scaleOf(el, rect){
    var layout = el.offsetWidth || 0;
    if (!layout || !rect || !rect.width) return 1;
    var ratio = rect.width / layout;
    if (!isFinite(ratio) || ratio <= 0) return 1;
    if (ratio < 0.05 || ratio > 20) return 1;
    return ratio;
  }
  function sizeOf(style, scale){
    var n = parseFloat(style.fontSize || '16');
    if (!n || n < 1) n = 16;
    n *= scale;
    if (n < 6) return 6;
    if (n > 160) return 160;
    return Math.round(n);
  }
  /*
   * Every property a text clone can be affected by, and nothing else.
   *
   * The sweep used to enumerate the whole computed style block — 466 properties
   * per element, twice (element + parent) — which measured 11.8ms for 40
   * elements. That is not a rounding error: it runs synchronously inside the
   * preview iframe, on the same main thread the agent is mutating HTML on, so
   * every snapshot stuttered the page it was measuring. 'getComputedStyle'
   * itself is free (~0.005ms/40); the cost was entirely the 18,680
   * 'getPropertyValue' calls.
   *
   * This is a bounded candidate list instead. It is a whitelist by necessity —
   * there is no way to ask the browser "which properties are px-valued" without
   * reading them all — but it is a list of *text-relevant* properties rather
   * than of properties someone remembered to scale. Anything missing here shows
   * up as a visual difference on a text clone, not as a silently unscaled
   * length, because the scaling rule below still applies to every entry.
   *
   * Measured: 0.27ms / 40 elements, a ~44x improvement.
   */
  var TEXT_PROPS = [
    // The type stack.
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'font-stretch', 'font-feature-settings', 'font-variation-settings',
    'font-kerning', 'font-optical-sizing', 'font-size-adjust',
    // Line box and spacing.
    'line-height', 'letter-spacing', 'word-spacing', 'text-indent', 'tab-size',
    // Layout of the text run itself.
    'text-transform', 'text-align', 'text-align-last', 'white-space',
    'direction', 'writing-mode', 'text-orientation', 'text-justify',
    'overflow-wrap', 'word-break', 'line-break', 'hyphens',
    'text-combine-upright', 'ruby-position', 'initial-letter',
    'hanging-punctuation',
    // Decoration and paint.
    'color', 'text-decoration-line', 'text-decoration-color',
    'text-decoration-style', 'text-decoration-thickness',
    'text-decoration-skip-ink', 'text-underline-offset', 'text-shadow',
    'text-rendering', 'text-emphasis-style', 'text-emphasis-color',
    'text-emphasis-position', 'text-fill-color', '-webkit-text-fill-color',
    '-webkit-text-stroke-width', '-webkit-text-stroke-color',
    '-webkit-font-smoothing', 'quotes',
    // Inheritance control.
    'visibility',
    // Present on any element, text or not.
    'background-color', 'background-image', 'box-shadow', 'filter',
    'mix-blend-mode', 'opacity', 'box-decoration-break',
    '-webkit-box-decoration-break',
    // Inline SVG text, which takes its paint from these.
    'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset',
    'stroke-linecap', 'stroke-linejoin', 'fill', 'fill-opacity',
    'paint-order', 'marker-start', 'marker-end',
    // Focus ring geometry, which is drawn around the text.
    'outline-offset'
  ];
  /**
   * The subset of 'TEXT_PROPS' that reaches an element by inheritance.
   *
   * They must always be written to the clone and are therefore never compared
   * against the parent — the clone does not hang under that parent, so omitting
   * the declaration hands it the overlay's inherited value instead (a span the
   * page resolved to 'line-height: normal' came out at the overlay's 17.5px
   * leading). Skipping the comparison is also what makes the sweep fast: the
   * parent's style object no longer has to be read for the common case.
   */
  var INHERITED_PROPS = {
    'font-family': 1, 'font-size': 1, 'font-weight': 1, 'font-style': 1,
    'font-variant': 1, 'font-stretch': 1, 'font-feature-settings': 1,
    'font-variation-settings': 1, 'font-kerning': 1, 'font-optical-sizing': 1,
    'font-size-adjust': 1, 'line-height': 1, 'letter-spacing': 1,
    'word-spacing': 1, 'text-indent': 1, 'tab-size': 1, 'text-transform': 1,
    'text-align': 1, 'text-align-last': 1, 'white-space': 1, 'direction': 1,
    'writing-mode': 1, 'text-orientation': 1, 'text-justify': 1,
    'overflow-wrap': 1, 'word-break': 1, 'line-break': 1, 'hyphens': 1,
    'ruby-position': 1, 'text-combine-upright': 1, 'hanging-punctuation': 1,
    'color': 1, 'text-shadow': 1, 'text-rendering': 1,
    '-webkit-text-fill-color': 1, '-webkit-text-stroke-width': 1,
    '-webkit-text-stroke-color': 1, '-webkit-font-smoothing': 1, 'quotes': 1,
    'visibility': 1, 'list-style-type': 1, 'caption-side': 1,
    'empty-cells': 1, 'border-collapse': 1
  };
  var CLONE_OWNS = /^(?:--|margin|padding)/;
  /** A bare px length: the only shape that needs the scale multiplication. */
  var PX_LENGTH = /^-?\\d*\\.?\\d+px$/;
  /** '0px' and friends: a zero is a zero at any scale. */
  var ZERO_LENGTH = /^0(?:\\.0+)?px$/;

  /**
   * The parent's computed style, memoised for the length of one snapshot.
   *
   * Siblings share a parent, so a page with 30 text layers under 30 different
   * wrappers still reads each wrapper once. Returns null when there is no
   * usable parent, which simply disables the comparison rather than dropping
   * properties.
   */
  function makeParentStyleCache(){
    var cache = typeof WeakMap === 'function' ? new WeakMap() : null;
    return function parentStyleOf(el){
      try {
        var parent = el.parentElement;
        if (!parent) return null;
        if (!cache) return getComputedStyle(parent);
        var cached = cache.get(parent);
        if (cached === undefined) {
          cached = getComputedStyle(parent);
          cache.set(parent, cached);
        }
        return cached;
      } catch (err) {
        return null;
      }
    };
  }

  var NOOP_VALUE = {
    none: 1, auto: 1, initial: 1, inherit: 1, unset: 1, revert: 1
  };

  function styleText(style, scale, parent, cloneOwns){
    var parts = [];
    var factor = scale && isFinite(scale) && scale > 0 ? scale : 1;
    var hasParent = !!parent;
    for (var i = 0; i < TEXT_PROPS.length; i++) {
      var prop = TEXT_PROPS[i];
      if (cloneOwns && cloneOwns.test(prop)) continue;
      var value = style.getPropertyValue(prop);
      if (!value) continue;
      var trimmed = value.replace(/^\\s+|\\s+$/g, '');
      if (!trimmed) continue;
      if (NOOP_VALUE[trimmed.toLowerCase()]) continue;
      // Inherited values are always written (see INHERITED_PROPS), so they are
      // never compared — only the properties the element declares itself can be
      // elided when they match the parent.
      if (hasParent && !INHERITED_PROPS[prop]
        && parent.getPropertyValue(prop).replace(/^\\s+|\\s+$/g, '') === trimmed) continue;
      var out = value;
      if (factor !== 1 && PX_LENGTH.test(trimmed)) {
        out = ZERO_LENGTH.test(trimmed) ? trimmed : round(parseFloat(trimmed) * factor) + 'px';
      }
      parts.push(prop + ':' + out);
    }
    // The clone draws a page-local box, not a page-level one.
    parts.push('margin:0');
    parts.push('padding:0');
    parts.push('border:0');
    parts.push('background:none');
    parts.push('display:block');
    parts.push('position:relative');
    parts.push('box-sizing:border-box');
    parts.push('width:100%');
    return parts.join(';');
  }
  function cloneHtml(el){
    try {
      var html = el.outerHTML || '';
      return html.slice(0, ${MAX_HTML});
    } catch (err) {
      return '';
    }
  }
  var parentKeys = typeof WeakMap === 'function' ? new WeakMap() : null;
  var nextParent = 1;
  function parentKey(el){
    var parent = el.parentElement;
    if (!parent || !parentKeys) return 'root';
    var key = parentKeys.get(parent);
    if (!key) {
      key = 'p' + (nextParent++);
      parentKeys.set(parent, key);
    }
    return key;
  }
  /* The host cannot see the mouse over this page: the frame is cross-origin, so
     no pointer event escapes it. Relay the reading instead — it costs one
     postMessage per move and it is the only way a cursor drawn by the host can
     stay beside the pointer while the user reads the page. */
  var lastMove = 0;
  function relay(x, y, inside){
    try {
      window.parent.postMessage({ type: POINTER, version: VERSION, x: round(x), y: round(y), inside: inside }, '*');
    } catch (err) {}
  }
  window.addEventListener('pointermove', function(ev){
    var now = Date.now();
    if (now - lastMove < 16) return;
    lastMove = now;
    relay(ev.clientX, ev.clientY, true);
  }, { passive: true });
  document.addEventListener('pointerleave', function(){ relay(0, 0, false); }, { passive: true });
  window.addEventListener('blur', function(){ relay(0, 0, false); });
  /**
   * Measure a set of elements into reveal layers.
   *
   * Shared by the full snapshot and by patches: the only difference between "the
   * whole page is new" and "these four boxes changed" is which nodes arrive
   * here. 'opts.only' limits the result to the boxes that are actually visible
   * and changed, which is what keeps a patch cheap.
   */
  function measureNodes(nodes, viewW, viewH, opts){
    var layers = [];
    var keptRects = [];
    // One parent-style cache for the whole pass: siblings share a parent, so
    // each wrapper is read once no matter how many text layers sit under it.
    var parentCache = makeParentStyleCache();
    var limit = opts && opts.limit ? opts.limit : CAP;
    for (var i = 0; i < nodes.length && layers.length < limit; i++) {
      var el = nodes[i];
      var style;
      try { style = getComputedStyle(el); } catch (err) { continue; }
      if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 12 || rect.height < 12) continue;
      if (rect.bottom < 4 || rect.top > viewH - 4 || rect.right < 4 || rect.left > viewW - 4) continue;
      var x = Math.max(0, rect.left);
      var y = Math.max(0, rect.top);
      var w = Math.min(viewW, rect.right) - x;
      var h = Math.min(viewH, rect.bottom) - y;
      if (w < 12 || h < 12) continue;
      var tag = el.tagName.toLowerCase();
      var direct = textOf(el);
      var kind = 'rect';
      var src = '';
      if (tag === 'img' || tag === 'svg' || tag === 'picture') {
        kind = 'image';
        if (tag === 'img') {
          src = el.currentSrc || el.getAttribute('src') || '';
          if (src.length > ${MAX_SRC}) src = '';
        }
      } else if (direct && (el.children.length === 0 || /^(p|h1|h2|h3|h4|h5|h6|button|a|li|span|label)$/.test(tag))) {
        kind = 'text';
      } else if (!hasOwnBox(style)) {
        continue;
      }
      var bgImage = style.getPropertyValue('background-image') || '';
      if (kind === 'rect' && bgImage.indexOf('url(') !== -1) kind = 'image';
      if (kind === 'rect' && w >= viewW * 0.9 && h >= viewH * 0.9) {
        continue;
      }
      if (kind === 'rect') {
        var nested = false;
        for (var k = 0; k < keptRects.length; k++) {
          var outer = keptRects[k];
          if (x >= outer.x - 2 && y >= outer.y - 2 && x + w <= outer.x + outer.w + 2 && y + h <= outer.y + outer.h + 2 && w * h >= outer.w * outer.h * 0.82) {
            nested = true;
            break;
          }
        }
        if (nested) continue;
        keptRects.push({ x: x, y: y, w: w, h: h });
      }
      var fill = kind === 'text' ? '' : (painted(style, 'background-color') || '');
      var scale = scaleOf(el, rect);
      var radius = (parseFloat(style.borderRadius) || 0) * scale;
      layers.push({
        id: 'l' + layers.length,
        kind: kind,
        x: round(x),
        y: round(y),
        w: round(w),
        h: round(h),
        radius: round(radius),
        fill: fill,
        color: style.color || 'rgb(17, 17, 17)',
        weight: weightOf(style),
        size: sizeOf(style, scale),
        text: kind === 'text' ? direct : '',
        style: kind === 'text' ? styleText(style, scale, parentCache(el), CLONE_OWNS) : '',
        html: kind === 'text' ? cloneHtml(el) : '',
        scale: scale,
        src: src,
        sibling: parentKey(el) + ':' + tag + ':' + kind + ':' + Math.round(w / 8) + 'x' + Math.round(h / 8)
      });
    }
    // Repeated siblings are copies of one component; the first is the master and
    // the rest follow it.
    var groups = {};
    for (var j = 0; j < layers.length; j++) {
      var key = layers[j].sibling;
      if (!groups[key]) groups[key] = [];
      groups[key].push(j);
    }
    Object.keys(groups).forEach(function(key){
      var idxs = groups[key];
      var shared = idxs.length >= 2 ? key : null;
      for (var n = 0; n < idxs.length; n++) {
        layers[idxs[n]].group = shared;
        layers[idxs[n]].master = shared !== null && n === 0;
        delete layers[idxs[n]].sibling;
      }
    });
    return layers;
  }

  /**
   * The elements that changed since the last look.
   *
   * While an agent streams HTML into an existing page, most of the document is
   * untouched on any given keystroke. Watching the DOM is enough to say *which*
   * nodes moved: the observer records targets, it never measures. Measurement
   * stays in 'measureNodes', so a patch costs one bounded style sweep over a
   * handful of elements instead of a full-page snapshot.
   *
   * Records are pruned to elements that can actually become a layer — a text
   * node's parent, never the text node; a wrapper with no box of its own is
   * dropped by 'measureNodes' anyway.
   */
  var dirty = null;
  var dirtyCount = 0;
  function markDirty(node){
    if (!node) return;
    var el = node.nodeType === 1 ? node : node.parentElement;
    // Guard against a document that has been torn down under us: the observer
    // outlives a navigation in some embeddings, and a detached record must not
    // throw out of a microtask.
    if (!el || typeof el.nodeType !== 'number') return;
    if (el === document.body || el === document.documentElement) return;
    if (!dirty) dirty = new Set();
    if (dirty.has(el)) return;
    dirty.add(el);
    dirtyCount++;
  }
  function takeDirty(){
    var nodes = dirty ? Array.from(dirty) : [];
    dirty = null;
    dirtyCount = 0;
    // A node that was removed from the document cannot become a layer, and
    // measuring a detached element reports a 0x0 box at 0,0 — which reads as a
    // spurious change at the page origin. Removal is therefore not a patch; the
    // page simply no longer has that box.
    var live = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || !el.isConnected) continue;
      live.push(el);
    }
    return live;
  }
  if (typeof MutationObserver === 'function') {
    try {
      var observer = new MutationObserver(function(records){
        try {
          for (var i = 0; i < records.length; i++) {
            var rec = records[i];
            markDirty(rec.target);
            // Inserted subtrees arrive as added nodes; the node itself is what
            // gets measured, and its children were measured by their own records
            // when they were added.
            for (var j = 0; j < rec.addedNodes.length; j++) markDirty(rec.addedNodes[j]);
            for (var k = 0; k < rec.removedNodes.length; k++) markDirty(rec.removedNodes[k]);
          }
        } catch (err) {
          // The document this observer was attached to is gone (a navigation, or
          // a teardown in an embedding). Dropping the batch is correct: there is
          // nothing left to patch.
          observer.disconnect();
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
      // Exposed so a host can stop watching: an embedding that tears the
      // document down, or a harness that installs the bridge more than once in
      // one window, must be able to release the previous observer instead of
      // leaving it reading a dead tree.
      window.__odPreviewRevealObserver = observer;
    } catch (err) {}
  }

  function backgroundOf(){
    var background = 'rgb(255, 255, 255)';
    try {
      var bodyBg = painted(getComputedStyle(document.body || document.documentElement), 'background-color');
      if (bodyBg) background = bodyBg;
    } catch (err) {}
    return background;
  }

  window.addEventListener('message', function(ev){
    var data = ev && ev.data;
    if (!data || data.version !== VERSION) return;
    var viewW = window.innerWidth || 1;
    var viewH = window.innerHeight || 1;

    // A patch: only what mutated. The host asks for this while a page is being
    // edited, so the reply is small and cheap by construction.
    if (data.type === PATCH_REQUEST) {
      var changed = takeDirty();
      if (changed.length === 0) return;
      var patchLayers = measureNodes(changed, viewW, viewH, { limit: PATCH_CAP });
      if (patchLayers.length === 0) return;
      window.parent.postMessage({
        type: PATCH,
        version: VERSION,
        id: data.id,
        viewport: { width: round(viewW), height: round(viewH) },
        background: backgroundOf(),
        layers: patchLayers
      }, '*');
      return;
    }

    if (data.type !== REQUEST || typeof data.id !== 'string') return;
    var body = document.body;
    var nodes = body ? body.querySelectorAll(SELECTOR) : [];
    var layers = measureNodes(nodes, viewW, viewH, { limit: CAP });
    // A full snapshot supersedes anything already marked as changed.
    dirty = null;
    dirtyCount = 0;
    window.parent.postMessage({
      type: RESPONSE,
      version: VERSION,
      id: data.id,
      viewport: { width: round(viewW), height: round(viewH) },
      background: backgroundOf(),
      layers: layers
    }, '*');
  });
})();
</script>`;
}
