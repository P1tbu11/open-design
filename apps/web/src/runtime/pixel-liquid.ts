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
 *   · 矩阵按时间错一格(shimmer),中间调的颗粒在跳,窗体不跟着转。
 *   · 密度场是 mind 预览那块浏览器板:圆角轮廓挤成有厚度的 SDF,
 *     固定 yaw / pitch,透视光线行进,漫反射加边缘光得到连续亮度,
 *     再进 Bayer。边是颗粒褪出去的,不是硬切的线框。
 *     孔比预览略大,84px 上才打得穿。
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

/**
 * 相机。mind 预览 yaw ≈ 0.55、pitch ≈ 0.42、相机在 z=3.3。
 * 这里同一侧、略拉近,让 84px 的窗还占得住格子。角度不跟时间走。
 */
const YAW = 0.42;
const PITCH = 0.32;
const CAM_Y = 0.04;
const CAM_Z = 2.95;
const OBJ_SCALE = 1.12;
const HOLE_R = 0.1;
/** 和预览一样:一块抖动格 = 2 CSS 像素,再 pixelated 放大。 */
const DITHER_CELL = 2;

const COS_YAW = Math.cos(YAW);
const SIN_YAW = Math.sin(YAW);
const COS_PITCH = Math.cos(PITCH);
const SIN_PITCH = Math.sin(PITCH);
/** R = RY * RX,和预览着色器同一套。 */
const R00 = COS_YAW;
const R01 = SIN_YAW * SIN_PITCH;
const R02 = SIN_YAW * COS_PITCH;
const R10 = 0;
const R11 = COS_PITCH;
const R12 = -SIN_PITCH;
const R20 = -SIN_YAW;
const R21 = COS_YAW * SIN_PITCH;
const R22 = COS_YAW * COS_PITCH;

const LIGHT_X = -0.55;
const LIGHT_Y = 0.85;
const LIGHT_Z = 0.5;
const LIGHT_LEN = Math.hypot(LIGHT_X, LIGHT_Y, LIGHT_Z);
const LX = LIGHT_X / LIGHT_LEN;
const LY = LIGHT_Y / LIGHT_LEN;
const LZ = LIGHT_Z / LIGHT_LEN;

function sdBox(px: number, py: number, bx: number, by: number): number {
  const dx = Math.abs(px) - bx;
  const dy = Math.abs(py) - by;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

function sdRoundBox(px: number, py: number, bx: number, by: number, radius: number): number {
  return sdBox(px, py, bx - radius, by - radius) - radius;
}

/** 预览的浏览器轮廓。y 向上。孔比预览的 0.028 大,否则 84px 上打不穿。 */
function browserShape(px: number, py: number): number {
  let d = sdRoundBox(px, py - 0.02, 0.62, 0.48, 0.04);
  d = Math.max(d, -sdRoundBox(px, py + 0.02, 0.48, 0.3, 0.02));
  const chrome = sdRoundBox(px, py - 0.4, 0.62, 0.16, 0.04);
  d = Math.min(d, chrome);
  d = Math.max(d, -(Math.hypot(px + 0.38, py - 0.4) - HOLE_R));
  d = Math.max(d, -(Math.hypot(px + 0.14, py - 0.4) - HOLE_R));
  d = Math.max(d, -(Math.hypot(px - 0.1, py - 0.4) - HOLE_R));
  return d;
}

/** 圆角板,和预览 slab() 同一条。 */
function mapWorld(wx: number, wy: number, wz: number): number {
  const px = (R00 * wx + R01 * wy + R02 * wz) / OBJ_SCALE;
  const py = (R10 * wx + R11 * wy + R12 * wz) / OBJ_SCALE;
  const pz = (R20 * wx + R21 * wy + R22 * wz) / OBJ_SCALE;
  const qx = browserShape(px, py) + 0.03;
  const qy = Math.abs(pz) - 0.12;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return (Math.min(Math.max(qx, qy), 0) + outside - 0.03) * OBJ_SCALE;
}

/** 物体坐标投到画布像素,y 向下。给测试量孔和标题栏用,和射线是同一套相机。 */
function projectObject(px: number, py: number, pz: number, w: number, h: number): { x: number; y: number } {
  const ox = px * OBJ_SCALE;
  const oy = py * OBJ_SCALE;
  const oz = pz * OBJ_SCALE;
  const wx = R00 * ox + R10 * oy + R20 * oz;
  const wy = R01 * ox + R11 * oy + R21 * oz;
  const wz = R02 * ox + R12 * oy + R22 * oz;
  const denom = (wz - CAM_Z) / -2.6;
  if (denom <= 1e-4) return { x: -1, y: -1 };
  const uvx = (wx / denom) / 0.92;
  const uvy = ((wy - CAM_Y) / denom) / 0.92;
  return {
    x: uvx * (h * 0.5) + w * 0.5,
    y: h * 0.5 - uvy * (h * 0.5),
  };
}

/**
 * 透视之后的采样点。孔心在板的正面附近,标题栏取样躲开三颗孔,
 * 内页取样在挖空的那一块中间。
 */
export interface BrowserChromeLayout {
  holes: ReadonlyArray<{ x: number; y: number; r: number }>;
  /** 标题栏右侧,应该是实的框 */
  bar: { x: number; y: number };
  /** 内页开口的中间,应该比框疏 */
  page: { x: number; y: number };
}

export function browserChromeLayout(w: number, h: number): BrowserChromeLayout {
  const front = 0.02;
  const holes = [-0.38, -0.14, 0.1].map((hx) => {
    const center = projectObject(hx, 0.4, front, w, h);
    const edge = projectObject(hx + HOLE_R, 0.4, front, w, h);
    return {
      x: center.x,
      y: center.y,
      r: Math.max(1.5, Math.hypot(edge.x - center.x, edge.y - center.y)),
    };
  });
  return {
    holes,
    bar: projectObject(0.36, 0.4, front, w, h),
    page: projectObject(0.02, -0.08, 0, w, h),
  };
}

/**
 * 一个抖动格的连续亮度。射线打进圆角板,用漫反射 + 边缘光收成 0..1,
 * 和预览着色器同一条式子。打不中可以留下很淡的地面影子。
 * Bayer 在这之后才决定墨点,所以边是颗粒,不是硬边。
 */
function browserTone(x: number, y: number, w: number, h: number): number {
  const uvx = (x - w * 0.5) / (h * 0.5);
  const uvy = (h * 0.5 - y) / (h * 0.5);
  let rdx = uvx * 0.92;
  let rdy = uvy * 0.92;
  let rdz = -2.6;
  const inv = 1 / Math.hypot(rdx, rdy, rdz);
  rdx *= inv;
  rdy *= inv;
  rdz *= inv;

  const b = CAM_Y * rdy + CAM_Z * rdz;
  const c = CAM_Y * CAM_Y + CAM_Z * CAM_Z - 1.7 * 1.7;
  const disc = b * b - c;
  if (disc <= 0) return 0;
  const reach = Math.sqrt(disc);
  let dist = Math.max(-b - reach, 0);
  const tmax = -b + reach;

  let hit = false;
  for (let i = 0; i < 28; i++) {
    const d = mapWorld(rdx * dist, CAM_Y + rdy * dist, CAM_Z + rdz * dist);
    if (d < 0.004) {
      hit = true;
      break;
    }
    dist += d;
    if (dist > tmax) break;
  }

  if (!hit) {
    if (rdy >= 0) return 0;
    const tg = (-0.78 - CAM_Y) / rdy;
    if (tg <= 0) return 0;
    const gx = (rdx * tg) / OBJ_SCALE;
    const gz = (CAM_Z + rdz * tg) / OBJ_SCALE;
    const fall = Math.hypot(gx - 0.05, (gz - 0.15) * 1.35);
    if (fall > 0.95) return 0;
    const t = fall / 0.95;
    const sh = 1 - t * t * (3 - 2 * t);
    return sh * 0.16;
  }

  const wx = rdx * dist;
  const wy = CAM_Y + rdy * dist;
  const wz = CAM_Z + rdz * dist;
  const e = 0.01;
  const n1 = mapWorld(wx + e, wy - e, wz - e);
  const n2 = mapWorld(wx - e, wy - e, wz + e);
  const n3 = mapWorld(wx - e, wy + e, wz - e);
  const n4 = mapWorld(wx + e, wy + e, wz + e);
  let nx = n1 - n2 - n3 + n4;
  let ny = -n1 - n2 + n3 + n4;
  let nz = -n1 + n2 - n3 + n4;
  const nlen = Math.hypot(nx, ny, nz) || 1;
  nx /= nlen;
  ny /= nlen;
  nz /= nlen;

  const dif = Math.max(nx * LX + ny * LY + nz * LZ, 0);
  const ndv = Math.max(-(nx * rdx + ny * rdy + nz * rdz), 0);
  const shade = 1 - ndv;
  const rim = shade * shade * shade * 0.25;
  const lit = clamp01(0.18 + 0.82 * dif + rim);
  /* 预览的亮度在受光处会稀到几乎消失。小卡上把这段压进
     仍能认得出窗的颗粒带:受光面约一半墨点,背光面接近铺实。 */
  const raw = 0.12 + 0.82 * (1 - lit);
  return clamp01(0.34 + 0.58 * raw);
}

/** `shade()` 只需要拿到那条字节流 —— 传 `ImageData` 或测试里的替身都行。 */
export interface LiquidPixels {
  data: Uint8ClampedArray;
}

/**
 * 把一帧画进 ImageData。每个抖动格要么是近黑墨点,要么全透明。
 *
 * 一格 2 CSS 像素,和预览的 `CELL` 一样:亮度在格心采样一次,Bayer 也按格取。
 * `pixel` 仍是调用约定里的旧方格边长;非有限尺寸不画,有限值也不再把格放大。
 */
export function shade(img: LiquidPixels, w: number, h: number, t: number, pixel: number): void {
  if (!Number.isFinite(pixel) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
  const data = img.data;
  const cell = DITHER_CELL;
  /* 矩阵约每秒错 7 次。只有落在 1/17..16/17 的亮度会跟着跳。 */
  const shimmer = Math.floor(t * 7);
  const inv17 = 1 / 17;

  for (let y = 0; y < h; y += cell) {
    const qy = ((y / cell) + shimmer * 3) & 3;
    const cy = y + cell * 0.5;
    const y1 = Math.min(y + cell, h);
    for (let x = 0; x < w; x += cell) {
      const tone = browserTone(x + cell * 0.5, cy, w, h);
      let on = false;
      if (tone > 16 * inv17) on = true;
      else if (tone >= inv17) {
        const threshold = (BAYER4[qy * 4 + (((x / cell) + shimmer) & 3)]! + 1) * inv17;
        on = tone >= threshold;
      }
      const x1 = Math.min(x + cell, w);
      for (let yy = y; yy < y1; yy++) {
        let p = (yy * w + x) * 4;
        for (let xx = x; xx < x1; xx++, p += 4) {
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
