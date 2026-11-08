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
/** First-screen choreography. Past this, the curtain stops being a curtain. */
export const PREVIEW_REVEAL_LAYER_CAP = 36;
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
  if (record.type !== PREVIEW_REVEAL_RESPONSE_TYPE) return null;
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
  /* The properties a rebuilt span cannot invent: the page's own type stack,
     spacing, stroke and weight. The clone carries them so nothing is guessed. */
  var TEXT_PROPS = [
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'font-stretch', 'font-feature-settings', 'font-variation-settings', 'font-kerning',
    'font-optical-sizing', 'line-height', 'letter-spacing', 'word-spacing',
    'text-transform', 'text-align', 'text-indent', 'text-decoration-line',
    'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness',
    'text-underline-offset', 'text-shadow', 'white-space', 'direction',
    'overflow-wrap', 'word-break', 'hyphens', 'tab-size',
    '-webkit-text-fill-color', '-webkit-text-stroke-width', '-webkit-text-stroke-color',
    'text-rendering', '-webkit-font-smoothing', 'writing-mode', 'color'
  ];
  function styleText(style, scale){
    var parts = [];
    for (var i = 0; i < TEXT_PROPS.length; i++) {
      var prop = TEXT_PROPS[i];
      var value = style.getPropertyValue(prop);
      if (!value) continue;
      if (prop === 'font-size' || prop === 'letter-spacing' || prop === 'word-spacing') {
        var n = parseFloat(value);
        if (isFinite(n) && scale && scale !== 1) {
          value = round(n * scale) + 'px';
        }
      }
      parts.push(prop + ':' + value);
    }
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
  window.addEventListener('message', function(ev){
    var data = ev && ev.data;
    if (!data || data.type !== REQUEST || data.version !== VERSION || typeof data.id !== 'string') return;
    var viewW = window.innerWidth || 1;
    var viewH = window.innerHeight || 1;
    var body = document.body;
    var background = 'rgb(255, 255, 255)';
    try {
      var bodyBg = painted(getComputedStyle(body || document.documentElement), 'background-color');
      if (bodyBg) background = bodyBg;
    } catch (err) {}
    var layers = [];
    var keptRects = [];
    var nodes = body ? body.querySelectorAll(SELECTOR) : [];
    for (var i = 0; i < nodes.length && layers.length < CAP; i++) {
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
        var cover = painted(style, 'background-color');
        if (cover) background = cover;
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
        style: kind === 'text' ? styleText(style, scale) : '',
        html: kind === 'text' ? cloneHtml(el) : '',
        scale: scale,
        src: src,
        sibling: parentKey(el) + ':' + tag + ':' + kind + ':' + Math.round(w / 8) + 'x' + Math.round(h / 8)
      });
    }
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
    window.parent.postMessage({
      type: RESPONSE,
      version: VERSION,
      id: data.id,
      viewport: { width: round(viewW), height: round(viewH) },
      background: background,
      layers: layers
    }, '*');
  });
})();
</script>`;
}
