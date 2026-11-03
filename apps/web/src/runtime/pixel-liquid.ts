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
 *   · 矩阵按时间错一格(shimmer),颗粒自己在跳。
 *   · 密度场是慢慢旋转的点云:几团漂移的核,加上稀疏的闪点。
 *     小卡里不画 3D SDF 形变 —— 格子只有几十像素,形读不出来,
 *     要的是抖动颗粒、闪烁和点的漂移。
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

/**
 * 闪点表。参考实现是每像素 `hash(cell + floor(time))`;这里烤成 64×64,
 * 每拍只挪读指针。白噪声挪过之后还是白噪声,但省掉逐像素的 sin。
 */
const SPECK_N = 64;
const SPECK = (() => {
  const g = new Float32Array(SPECK_N * SPECK_N);
  for (let i = 0; i < g.length; i++) g[i] = hash(i % SPECK_N, Math.floor(i / SPECK_N));
  return g;
})();

/**
 * 一块采样点上的密度。
 *
 * 坐标先收成以格子中心为原点、按高归一的平面,这样竖的生图格和横的产物卡
 * 看到的是同一团圆云,而不是被拉成一条。云本身慢慢转;几团核在里面公转,
 * 是点状漂移的来源。噪声取平方,把能量压成一团团,而不是铺一层均匀的雾。
 * `fall` 是软圆边,角上留空,抖动才不会顶着方框变成一块矩形。
 */
function sampleField(ux: number, uy: number, t: number, aspect: number): { lum: number; wide: number } {
  const nx = (ux - 0.5) * 2 * aspect;
  const ny = (uy - 0.5) * 2;
  const rad = Math.hypot(nx, ny);
  const ang = Math.atan2(ny, nx);
  const sedge = 0.92 + 0.1 * Math.sin(ang * 3 + t * 0.55) + 0.06 * Math.sin(ang * 5 - t * 0.8);
  /* 软圆边。中心留在抖动带里,不要顶满 1 —— 顶满会被 16/17 那条规则铺成实心黑。 */
  const fall = 1 - smoothstep(sedge - 0.55, sedge + 0.18, rad);
  const wide = 1 - smoothstep(1.05, 1.45, rad);

  const swirl = t * 0.22;
  const cs = Math.cos(swirl);
  const sn = Math.sin(swirl);
  const sx = nx * cs - ny * sn;
  const sy = nx * sn + ny * cs;
  const n1 = noise(sx * 1.6 + 1.3, sy * 1.6 - t * 0.05);
  const n2 = noise(sx * 3.2 + t * 0.08, sy * 3.2 + 0.7);
  /* 增益停在 16/17 以下。再高,核心会被那条「铺实」规则吃成一块实心黑,
     抖动颗粒就没了。两团核叠在一起也仍然落在抖动带里。 */
  let lum = fall * (0.015 + 0.16 * n1 * n1 + 0.08 * n2 * n2);

  for (let i = 0; i < 7; i++) {
    const a = t * (0.55 + i * 0.09) + i * 0.9;
    const orbit = 0.12 + 0.32 * (0.5 + 0.5 * Math.sin(t * 0.23 + i));
    const px = Math.cos(a) * orbit;
    const py = Math.sin(a * 0.77) * orbit * 0.85;
    const dx = nx - px;
    const dy = ny - py;
    lum += Math.exp(-(dx * dx + dy * dy) * 36) * 0.34 * fall;
  }

  /*
   * 叠加上限停在 0.58。4×4 矩阵里有几格阈值高于这数(10、12、14、15),
   * 所以最密的核心仍然是颗粒,不是一整行实心黑。再往上,某一整行 Bayer
   * 会同时通过,小卡里就糊成墨块。
   */
  return { lum: Math.min(lum, 0.58), wide };
}

/** `shade()` 只需要拿到那条字节流 —— 传 `ImageData` 或测试里的替身都行。 */
export interface LiquidPixels {
  data: Uint8ClampedArray;
}

/**
 * 把一帧画进 ImageData。每个抖动格要么是近黑墨点,要么全透明。
 *
 * 抖动格固定 2 CSS 像素(和参考预览的 `CELL` 一样),并且不超过调用方传入的
 * `pixel`。密度场如果仍按 `pixelSizeFor` 的步长取 —— 宽卡上会到 16px ——
 * 圆云会被切成实心十字。墨点大小不跟卡片变,变的是格子里能放下多少点。
 */
export function shade(img: LiquidPixels, w: number, h: number, t: number, pixel: number): void {
  const data = img.data;
  const cell = Math.max(1, Math.min(2, pixel > 0 ? pixel : 2));
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(h / cell));
  const aspect = w / Math.max(h, 1);
  /* 矩阵约每秒错 7 次;闪点表约每秒挪 5 次。两者都量化到整数拍,
     颗粒是「跳」,不是每一帧都重抽一张噪声。 */
  const shimmer = Math.floor(t * 7);
  const flick = Math.floor(t * 5);
  const inv17 = 1 / 17;

  for (let by = 0; by < rows; by++) {
    const uy = (by + 0.5) / rows;
    const qy = (by + shimmer * 3) & 3;
    for (let bx = 0; bx < cols; bx++) {
      const ux = (bx + 0.5) / cols;
      const field = sampleField(ux, uy, t, aspect);
      let tone = field.lum;
      const speck = SPECK[((by + flick * 3) & (SPECK_N - 1)) * SPECK_N + ((bx + flick) & (SPECK_N - 1))]!;
      /* 参考实现里空区的能量闪点。抬到抖动带上沿,矩阵一错位它们就闪。 */
      if (speck > 0.992) tone = Math.max(tone, 0.78 * field.wide);
      tone = clamp01(tone);

      let on = false;
      if (tone > 16 * inv17) on = true;
      else if (tone >= inv17) {
        const threshold = (BAYER4[qy * 4 + ((bx + shimmer) & 3)]! + 1) * inv17;
        on = tone >= threshold;
      }

      const x0 = bx * cell;
      const x1 = Math.min(x0 + cell, w);
      const y0 = by * cell;
      const y1 = Math.min(y0 + cell, h);
      for (let y = y0; y < y1; y++) {
        let p = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, p += 4) {
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
  }
}

/** 每格错开相位,一排格子不同步 —— 四格一模一样地脉动会很假。 */
export const PHASE_STEP = 7.3;
