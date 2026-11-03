/**
 * 待生成格子里的黑白 Bayer 抖动场。
 * ------------------------------------------------------------
 * 这一格从前是绿色像素液体:调色板 `#EAFFEB → #00FF04`,速度场用 curl noise
 * 顶替上游 Navier-Stokes,再按 color_frag 做软 alpha。观感是一整片霓虹绿。
 *
 * 现在改成 visual-agent-chat / Bayer mind 那套平面抖动,仍走 Canvas2D,
 * 不给每一格开 WebGL:
 *   · 墨色近黑、关掉的像素全透明(底下的 `--chat-bg-subtle` 透上来)。
 *   · 4×4 Bayer,17 级有序抖动(Paper Shaders / Codrops 那条矩阵)。
 *     低于 1/17 保持全空,高于 16/17 保持铺实,中间才进矩阵,平区不会发灰。
 *   · 矩阵按时间错一格(shimmer),边和内页的颗粒在跳,窗体本身不跟着漂。
 *   · 密度场是一扇浏览器窗:圆角外框、顶上的标题栏、标题栏里三颗打穿的
 *     交通灯孔。小卡(84×112)上也要认得出这是一扇窗,所以笔画按像素锁,
 *     不走 3D 形变。四角比窗框稀,孔比标题栏稀。
 *
 * 画布按【CSS 像素】开,不乘 dpr。Bayer 取的是画布坐标;乘了 dpr,2× 屏上
 * 一格抖动只有半个 CSS 像素,再被放大就糊成灰。按 CSS 像素画,
 * 配 `image-rendering: pixelated`,抖动的点是实的。
 */

/** 交付稿那一格的宽度。`DESIGN_PIXEL` 的标定就是在这个尺寸上量出来的。 */
export const DESIGN_CELL_PX = 84;

/**
 * 旧像素液体在 84px 上取 6,得到约 14 列方格。这个数仍然是 `pixelSizeFor`
 * 的标定:再小的采样格会把场切成噪点。Bayer 墨点本身不跟这个步长放大
 * (见 `shade`),否则宽产物卡的圆云会被切成十字色块。
 */
export const DESIGN_PIXEL = 6;

/**
 * 于是产品里的取法就从上面那句推出来:守住**列数**,让采样步长跟着宽度走。
 * 84 / 6 = 14 —— 稿子写死的 6 正是这条式子在 84px 上的解,所以生图格拿到的
 * 仍然是稿子那个数,而更宽的产物卡不会退化成一片细噪点。
 */
export const TARGET_COLS = Math.round(DESIGN_CELL_PX / DESIGN_PIXEL);

/** 再小的格子也不让采样步长塌到 1~3px:那时候场和抖动叠在一起,只剩噪点。 */
const MIN_PIXEL = 4;

/**
 * 按容器宽度重算旧液体方格的边长(见 `TARGET_COLS`)。
 * `shade` 把它当作抖动格的上限,实际墨点停在 2 CSS 像素。
 */
export function pixelSizeFor(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return MIN_PIXEL;
  return Math.max(MIN_PIXEL, Math.round(width / TARGET_COLS));
}

/**
 * 4×4 Bayer,顺序与 visual-agent-chat / Paper Shaders 一致。
 * 阈值是 `(value + 1) / 17`,17 级里两头留给纯空和纯实。
 */
const BAYER4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

/**
 * 预览着色器里的 `uFront`(0.05, 0.05, 0.05)。近黑,三个通道一样,
 * 这样格子里不会再冒出绿色。
 */
const INK_R = 13;
const INK_G = 13;
const INK_B = 13;

/** 30 帧够看:抖动本身就在跳,60 帧只是多烧一倍 CPU。 */
export const FPS = 30;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const fract = (v: number): number => v - Math.floor(v);

/** 与上游 hash 同一条式子。密度场和闪点表都用它,帧与帧之间才是确定的。 */
const hash = (x: number, y: number): number => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** 圆角矩形 SDF。`hx` / `hy` 是半宽半高,原点在矩形中心。 */
function sdRoundBox(px: number, py: number, hx: number, hy: number, radius: number): number {
  const r = Math.min(Math.max(radius, 0), hx, hy);
  const qx = Math.abs(px) - (hx - r);
  const qy = Math.abs(py) - (hy - r);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/**
 * 浏览器窗在这一格里的几何,单位是 CSS 像素,y 向下。
 * 跟 `shade()` 用的是同一套数,测试靠它量「框比角密、孔比标题栏疏」。
 * 位置不随时间变 —— 窗要站得住,动的只是抖动和内页里的扫光。
 */
export interface BrowserChromeLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 标题栏高度,从 `top` 往下 */
  barHeight: number;
  /** 左右和底边的框宽 */
  frame: number;
  /** 标题栏左侧三颗交通灯孔,圆心 + 半径 */
  holes: ReadonlyArray<{ x: number; y: number; r: number }>;
}

export function browserChromeLayout(w: number, h: number): BrowserChromeLayout {
  const winW = Math.min(w * 0.88, h * 0.78);
  const winH = Math.min(winW * 0.82, h * 0.86);
  const left = (w - winW) / 2;
  const top = (h - winH) / 2;
  const frame = Math.max(4, winW * 0.085);
  const barHeight = Math.max(frame * 2.15, winH * 0.26);
  const holeR = Math.max(2.6, barHeight * 0.2);
  const gap = holeR * 2.45;
  const holeX0 = left + frame + holeR * 0.35;
  const holeY = top + barHeight * 0.5;
  return {
    left,
    top,
    width: winW,
    height: winH,
    barHeight,
    frame,
    holes: [0, 1, 2].map((i) => ({ x: holeX0 + i * gap, y: holeY, r: holeR })),
  };
}

/**
 * 一个采样点的密度。窗框和标题栏靠近 1(Bayer 后接近铺实,轮廓才站得住),
 * 边缘退进抖动带,内页只有一层淡扫光,孔和四角是 0。
 */
function browserTone(x: number, y: number, w: number, h: number, t: number): number {
  const layout = browserChromeLayout(w, h);
  const cx = layout.left + layout.width / 2;
  const cy = layout.top + layout.height / 2;
  const radius = Math.max(5, layout.width * 0.1);
  const outer = sdRoundBox(x - cx, y - cy, layout.width / 2, layout.height / 2, radius);

  const pageTop = layout.top + layout.barHeight;
  const pageH = Math.max(2, layout.height - layout.barHeight - layout.frame);
  const pageCy = pageTop + pageH / 2;
  const page = sdRoundBox(
    x - cx,
    y - pageCy,
    Math.max(1, layout.width / 2 - layout.frame),
    pageH / 2,
    Math.max(2, radius - layout.frame),
  );

  let hole = 1e3;
  for (const dot of layout.holes) hole = Math.min(hole, Math.hypot(x - dot.x, y - dot.y) - dot.r);

  if (hole < 0) return 0;
  if (outer > 0) {
    /* 窗外只留一圈窄的抖动边,角上是空的。 */
    if (outer > 3) return 0;
    return (1 - smoothstep(0, 3, outer)) * 0.5;
  }
  if (page < 0) {
    const scan = (y - pageTop) / pageH;
    const sweep = fract(t * 0.22);
    const delta = (scan - sweep) * 5;
    const band = Math.exp(-(delta * delta)) * 0.4;
    const n = noise(x * 0.08 + t * 0.15, y * 0.08 - t * 0.05);
    return clamp01(0.04 + n * 0.08 + band);
  }

  /* 框和标题栏。离边 2.5px 以内进抖动带,再往里就超过 16/17,铺成近黑。 */
  const inset = Math.min(-outer, hole);
  const body = y < layout.top + layout.barHeight ? 0.99 : 0.96;
  return clamp01(body - (1 - smoothstep(0, 2.5, inset)) * 0.42);
}

/** `shade()` 只需要拿到那条字节流 —— 传 `ImageData` 或测试里的替身都行。 */
export interface LiquidPixels {
  data: Uint8ClampedArray;
}

/**
 * 把一帧画进 ImageData。每个 CSS 像素要么是近黑墨点,要么全透明。
 *
 * 抖动格锁在 1 CSS 像素。`pixel`(旧液体方格,84px 上是 6)如果拿来当墨点,
 * 标题栏上的交通灯孔在小卡里会被一格吃掉。非有限的尺寸直接不画;
 * 有限的 `pixel` 也不再把抖动格放大到那个边长。
 */
export function shade(img: LiquidPixels, w: number, h: number, t: number, pixel: number): void {
  if (!Number.isFinite(pixel) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
  const data = img.data;
  /* 1 CSS 像素。`pixel` 是旧液体方格(84px 上为 6);把它当成墨点,孔就没了。 */
  const cell = 1;
  /* 矩阵约每秒错 7 次。窗框中心超过 16/17,错位碰不到它;
     边和内页还在抖动带里,会跟着跳。 */
  const shimmer = Math.floor(t * 7);
  const inv17 = 1 / 17;

  for (let y = 0; y < h; y += cell) {
    const qy = (y + shimmer * 3) & 3;
    const cy = y + 0.5;
    for (let x = 0; x < w; x += cell) {
      const tone = browserTone(x + 0.5, cy, w, h, t);
      let on = false;
      if (tone > 16 * inv17) on = true;
      else if (tone >= inv17) {
        const threshold = (BAYER4[qy * 4 + ((x + shimmer) & 3)]! + 1) * inv17;
        on = tone >= threshold;
      }
      const p = (y * w + x) * 4;
      if (on) {
        data[p] = INK_R;
        data[p + 1] = INK_G;
        data[p + 2] = INK_B;
        data[p + 3] = 255;
      } else {
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = 0;
      }
    }
  }
}

/** 每格错开相位,一排格子不同步 —— 四格一模一样地脉动会很假。 */
export const PHASE_STEP = 7.3;
