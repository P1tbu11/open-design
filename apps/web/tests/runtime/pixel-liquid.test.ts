/**
 * 待生成占位的 Bayer 抖动 + 共享调度器。
 *
 * 这一层跑在 node 里,**不碰 canvas**:jsdom 既没有 2D 上下文也没有布局,
 * 「画得漂不漂亮」在这里量不到。所以这个文件只钉两件事:
 *   ① `shade()` 是确定性的黑白有序抖动 —— 同一个 t 出同一帧、不同 t 出不同帧,
 *      像素只有「近黑墨点」和「全透明」两态,而且两种都有(不是铺一块实心,
 *      也不是绿色液体)。84×112 上标题栏比四角密、内页是空的,
 *      右侧上沿比左侧更高 —— 软颗粒里的斜窗,不是正对的矩形。
 *   ② 调度器:一条共享 rAF、看不见就停、同时跑的实例有上限、释放后不空转。
 * 颗粒好不好看只能靠真浏览器。起本地 web 后,触发生图未完成的 ImageRow,
 * 或产物卡还在写的 FileOpsSummary,看格子里是不是黑白抖动而不是霓虹绿。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DESIGN_CELL_PX,
  DESIGN_PIXEL,
  TARGET_COLS,
  browserChromeLayout,
  pixelSizeFor,
  shade,
} from '../../src/runtime/pixel-liquid';
import { createLiquidScheduler, type LiquidFrameHost } from '../../src/runtime/pixel-liquid-scheduler';

function surface(w: number, h: number) {
  return { data: new Uint8ClampedArray(w * h * 4) };
}

/** 手动推进的 rAF 替身 —— 调度器的时间必须由测试说了算 */
function fakeHost() {
  let next = 1;
  const queued = new Map<number, (ms: number) => void>();
  const host: LiquidFrameHost = {
    requestFrame(cb) {
      const handle = next++;
      queued.set(handle, cb);
      return handle;
    },
    cancelFrame(handle) {
      queued.delete(handle);
    },
  };
  return {
    host,
    pending: () => queued.size,
    /** 把当前排队的那一帧跑掉(回调里再排的下一帧留到下次 tick) */
    tick(ms: number) {
      const now = [...queued.entries()];
      queued.clear();
      for (const [, cb] of now) cb(ms);
    },
  };
}

describe('shade() —— 黑白 4×4 Bayer 抖动', () => {
  it('同一个 t 出同一帧,不同 t 出不同帧', () => {
    const a = surface(24, 32);
    const b = surface(24, 32);
    const c = surface(24, 32);
    shade(a, 24, 32, 1.5, 6);
    shade(b, 24, 32, 1.5, 6);
    shade(c, 24, 32, 2.5, 6);

    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(Array.from(a.data)).not.toEqual(Array.from(c.data));
  });

  it('只有近黑墨点和全透明两态,两种都有,而且不是绿色', () => {
    const img = surface(84, 112);
    shade(img, 84, 112, 3.2, 6);

    let on = 0;
    for (let p = 0; p < img.data.length; p += 4) {
      const r = img.data[p] as number;
      const g = img.data[p + 1] as number;
      const b = img.data[p + 2] as number;
      const a = img.data[p + 3] as number;
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(a === 0 || a === 255).toBe(true);
      if (a === 255) {
        on += 1;
        expect(r).toBeLessThan(40);
        expect(g).toBeLessThan(40);
      } else {
        expect(r).toBe(0);
        expect(g).toBe(0);
        expect(b).toBe(0);
      }
    }

    const coverage = on / (84 * 112);
    expect(coverage).toBeGreaterThan(0.02);
    expect(coverage).toBeLessThan(0.45);
  });

  it('一行里有亮有灭 —— 抖动颗粒,不是一条实心', () => {
    const img = surface(84, 112);
    shade(img, 84, 112, 3.2, 6);
    let varied = 0;
    for (let x = 0; x + 1 < 84; x++) {
      const p = (56 * 84 + x) * 4 + 3;
      if (img.data[p] !== img.data[p + 4]) varied += 1;
    }
    expect(varied).toBeGreaterThan(4);
  });

  it('84×112 上是软颗粒的斜窗:框比角密,内页更空,上沿是斜的', () => {
    const w = 84;
    const h = 112;
    const img = surface(w, h);
    shade(img, w, h, 1.2, 6);
    const layout = browserChromeLayout(w, h);

    const disk = (cx: number, cy: number, r: number): number => {
      let n = 0;
      let on = 0;
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          if (dx * dx + dy * dy > r * r) continue;
          n += 1;
          if (img.data[(y * w + x) * 4 + 3]) on += 1;
        }
      }
      return n === 0 ? 0 : on / n;
    };

    const corner = disk(4, 4, 3);
    const bar = disk(layout.bar.x, layout.bar.y, 2.4);
    const page = disk(layout.page.x, layout.page.y, 4);
    expect(corner).toBeLessThan(0.2);
    expect(bar).toBeGreaterThan(0.35);
    expect(bar).toBeGreaterThan(corner + 0.25);
    expect(page).toBeLessThan(bar - 0.25);

    const holes = layout.holes.map((hole) => disk(hole.x, hole.y, 2));
    expect(Math.min(...holes)).toBeLessThan(bar - 0.1);

    /* 透视:窗的右侧上沿比左侧更高。正对的矩形做不到这个差。 */
    const ink = (x: number, y: number) => img.data[(y * w + x) * 4 + 3] > 0;
    const firstSolid = (x0: number, x1: number): number => {
      for (let y = 0; y < h - 1; y++) {
        for (let x = x0; x < x1; x++) {
          if (ink(x, y) && ink(x, y + 1)) return y;
        }
      }
      return h;
    };
    expect(firstSolid(8, 26) - firstSolid(58, 78)).toBeGreaterThan(6);
  });
});

describe('pixelSizeFor() —— 按尺寸重算方格边长', () => {
  it('设计稿那一格(84px)算回稿子写死的 6', () => {
    expect(pixelSizeFor(DESIGN_CELL_PX)).toBe(DESIGN_PIXEL);
  });

  it('格子变大时保住列数,而不是保住方格边长', () => {
    for (const width of [84, 160, 240, 320]) {
      const px = pixelSizeFor(width);
      const cols = Math.ceil(width / px);
      expect(Math.abs(cols - TARGET_COLS)).toBeLessThanOrEqual(2);
    }
  });

  it('再小的格子也不会退化成 1px 噪点', () => {
    expect(pixelSizeFor(8)).toBeGreaterThanOrEqual(4);
    expect(pixelSizeFor(0)).toBeGreaterThanOrEqual(4);
  });
});

describe('共享调度器', () => {
  it('刚加入还没露面时不开循环 —— 一个实例一条 rAF 是明令禁止的', () => {
    const { host, pending } = fakeHost();
    const scheduler = createLiquidScheduler(host);
    const draw = vi.fn();

    scheduler.join(draw);
    expect(pending()).toBe(0);
    expect(scheduler.stats().ticking).toBe(false);
    expect(draw).not.toHaveBeenCalled();
  });

  it('多个实例共用一条 rAF', () => {
    const { host, pending, tick } = fakeHost();
    const scheduler = createLiquidScheduler(host);
    const a = vi.fn();
    const b = vi.fn();
    scheduler.join(a).setVisible(true);
    scheduler.join(b).setVisible(true);

    expect(pending()).toBe(1);
    tick(0);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(pending()).toBe(1);
  });

  it('滚出屏幕就停,回来再接着跑', () => {
    const { host, pending, tick } = fakeHost();
    const scheduler = createLiquidScheduler(host);
    const draw = vi.fn();
    const ticket = scheduler.join(draw);

    ticket.setVisible(true);
    tick(0);
    expect(draw).toHaveBeenCalledTimes(1);

    ticket.setVisible(false);
    expect(pending()).toBe(0);
    expect(scheduler.stats().ticking).toBe(false);
    tick(1_000);
    expect(draw).toHaveBeenCalledTimes(1);

    ticket.setVisible(true);
    tick(2_000);
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('同时跑的实例有上限:超出的那些不进循环', () => {
    const { host, tick } = fakeHost();
    const scheduler = createLiquidScheduler(host, { maxAnimating: 2 });
    const draws = [vi.fn(), vi.fn(), vi.fn()];
    for (const draw of draws) scheduler.join(draw).setVisible(true);

    tick(0);
    expect(scheduler.stats().animating).toBe(2);
    expect(draws[0]).toHaveBeenCalledTimes(1);
    expect(draws[1]).toHaveBeenCalledTimes(1);
    expect(draws[2]).not.toHaveBeenCalled();
  });

  it('上限之内的实例走掉后,排在后面的顶上来', () => {
    const { host, tick } = fakeHost();
    const scheduler = createLiquidScheduler(host, { maxAnimating: 1 });
    const first = vi.fn();
    const second = vi.fn();
    const ticket = scheduler.join(first);
    ticket.setVisible(true);
    scheduler.join(second).setVisible(true);

    tick(0);
    expect(second).not.toHaveBeenCalled();

    ticket.release();
    tick(1_000);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('按帧率节流:两次 rAF 挨太近只画一次', () => {
    const { host, tick } = fakeHost();
    const scheduler = createLiquidScheduler(host, { fps: 30 });
    const draw = vi.fn();
    scheduler.join(draw).setVisible(true);

    tick(0);
    expect(draw).toHaveBeenCalledTimes(1);
    tick(8);              // 8ms < 1/30s
    expect(draw).toHaveBeenCalledTimes(1);
    tick(40);             // 40ms > 1/30s
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('最后一个实例释放后循环收干净,不留一条空转的 rAF', () => {
    const { host, pending, tick } = fakeHost();
    const scheduler = createLiquidScheduler(host);
    const draw = vi.fn();
    const ticket = scheduler.join(draw);
    ticket.setVisible(true);
    tick(0);

    ticket.release();
    expect(pending()).toBe(0);
    expect(scheduler.stats()).toMatchObject({ registered: 0, animating: 0, ticking: false });
    tick(1_000);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('页面藏起来时全停', () => {
    const { host, pending, tick } = fakeHost();
    const scheduler = createLiquidScheduler(host);
    const draw = vi.fn();
    scheduler.join(draw).setVisible(true);
    tick(0);

    scheduler.setPaused(true);
    expect(pending()).toBe(0);
    tick(1_000);
    expect(draw).toHaveBeenCalledTimes(1);

    scheduler.setPaused(false);
    tick(2_000);
    expect(draw).toHaveBeenCalledTimes(2);
  });
});
