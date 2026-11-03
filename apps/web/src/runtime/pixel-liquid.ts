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
 *   · 密度场是一扇浏览器窗,而且是斜着看的:和 mind 预览同一套
 *     圆角板 SDF,绕 yaw / pitch 转过再透视投影。看得到顶面和侧面的厚度,
 *     标题栏上三颗孔是打穿的,内页是透的。小卡上孔仍要认得出来,
 *     所以孔比预览里略大,相机角度固定,不跟着时间转。
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
 * 相机。mind 预览里 yaw ≈ 0.55、pitch ≈ 0.42,物体在 z=0、相机在 z=3.3。
 * 这里角度取同一侧(右侧和顶面露出厚度),物体略放大,好让 84px 的孔还在。
 * 角度不跟时间走:小卡里窗要站得住。
 */
const YAW = 0.46;
const PITCH = 0.34;
const CAM_Y = 0.02;
const CAM_Z = 2.85;
const OBJ_SCALE = 1.28;
const HOLE_R = 0.064;
/** 板的半厚。太大时近侧面会盖住内页。 */
const SLAB_Z = 0.08;

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

function sdBox(px: number, py: number, bx: number, by: number): number {
  const dx = Math.abs(px) - bx;
  const dy = Math.abs(py) - by;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

function sdRoundBox(px: number, py: number, bx: number, by: number, radius: number): number {
  return sdBox(px, py, bx - radius, by - radius) - radius;
}

/** 预览里的浏览器轮廓。y 向上。孔比预览的 0.028 大,否则 84px 上只剩一个点。 */
function browserShape(px: number, py: number): number {
  let d = sdRoundBox(px, py - 0.02, 0.64, 0.48, 0.05);
  d = Math.max(d, -sdRoundBox(px, py + 0.04, 0.5, 0.3, 0.03));
  const chrome = sdRoundBox(px, py - 0.38, 0.64, 0.15, 0.05);
  d = Math.min(d, chrome);
  d = Math.max(d, -(Math.hypot(px + 0.42, py - 0.38) - HOLE_R));
  d = Math.max(d, -(Math.hypot(px + 0.27, py - 0.38) - HOLE_R));
  d = Math.max(d, -(Math.hypot(px + 0.12, py - 0.38) - HOLE_R));
  return d;
}

function objectAt(rdx: number, rdy: number, rdz: number, dist: number): { x: number; y: number; z: number } {
  const wx = rdx * dist;
  const wy = CAM_Y + rdy * dist;
  const wz = CAM_Z + rdz * dist;
  return {
    x: (R00 * wx + R01 * wy + R02 * wz) / OBJ_SCALE,
    y: (R10 * wx + R11 * wy + R12 * wz) / OBJ_SCALE,
    z: (R20 * wx + R21 * wy + R22 * wz) / OBJ_SCALE,
  };
}

/** 物体坐标轴 = 常数 的平面,返回射线参数。分母太小就是擦着走,丢掉。 */
function axisPlaneT(axis: 'x' | 'y' | 'z', value: number, rdx: number, rdy: number, rdz: number): number {
  let denom = 0;
  let shift = 0;
  if (axis === 'x') {
    denom = R00 * rdx + R01 * rdy + R02 * rdz;
    shift = R01 * CAM_Y + R02 * CAM_Z;
  } else if (axis === 'y') {
    denom = R11 * rdy + R12 * rdz;
    shift = R11 * CAM_Y + R12 * CAM_Z;
  } else {
    denom = R20 * rdx + R21 * rdy + R22 * rdz;
    shift = R21 * CAM_Y + R22 * CAM_Z;
  }
  if (Math.abs(denom) < 1e-4) return Infinity;
  const dist = (value * OBJ_SCALE - shift) / denom;
  return dist > 0.02 ? dist : Infinity;
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
  const front = SLAB_Z;
  const holes = [-0.42, -0.27, -0.12].map((hx) => {
    const center = projectObject(hx, 0.38, front, w, h);
    const edge = projectObject(hx + HOLE_R, 0.38, front, w, h);
    return {
      x: center.x,
      y: center.y,
      r: Math.max(1.5, Math.hypot(edge.x - center.x, edge.y - center.y)),
    };
  });
  return {
    holes,
    bar: projectObject(0.28, 0.38, front, w, h),
    page: projectObject(0.02, -0.08, 0, w, h),
  };
}

/**
 * 一个像素的密度。不做逐步光线行进(小卡上太贵),改成打三块朝向相机的面:
 * 正面、顶面、近侧面。正面用轮廓 SDF,孔和内页是空的;顶面和侧面是板的厚度,
 * 亮度比正面稀一档,Bayer 之后能看出是另一块平面。最近的一块赢。
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

  let best = Infinity;
  let tone = 0;

  const frontT = axisPlaneT('z', SLAB_Z, rdx, rdy, rdz);
  if (frontT < best) {
    const p = objectAt(rdx, rdy, rdz, frontT);
    const d = browserShape(p.x, p.y);
    if (d < 0) {
      best = frontT;
      /* 框心铺实,贴边退进抖动带。d>0 是孔和内页,这里不画。 */
      const edge = clamp01(-d / 0.05);
      tone = 0.5 + 0.48 * edge;
    }
  }

  const topT = axisPlaneT('y', 0.5, rdx, rdy, rdz);
  if (topT < best) {
    const p = objectAt(rdx, rdy, rdz, topT);
    if (Math.abs(p.x) < 0.66 && p.z > -SLAB_Z - 0.02 && p.z < SLAB_Z + 0.04 && browserShape(p.x, 0.47) < 0.02) {
      best = topT;
      tone = 0.5;
    }
  }

  /* 近侧是 -x:正 yaw 把 -x 转向相机。 */
  const sideT = axisPlaneT('x', -0.64, rdx, rdy, rdz);
  if (sideT < best) {
    const p = objectAt(rdx, rdy, rdz, sideT);
    if (p.y > -0.46 && p.y < 0.5 && p.z > -SLAB_Z && p.z < SLAB_Z + 0.02 && browserShape(-0.55, p.y) < 0.04) {
      best = sideT;
      tone = 0.72;
    }
  }

  return tone;
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
      const tone = browserTone(x + 0.5, cy, w, h);
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
