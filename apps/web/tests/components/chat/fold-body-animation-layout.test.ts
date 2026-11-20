// @vitest-environment node
/**
 * 展开动画**不许**弄坏那个限高滚动盒 —— 真浏览器里量。
 *
 * ── 为什么必须真浏览器 ────────────────────────────────────────────────
 *
 * jsdom 不做布局:`scrollHeight` / `clientHeight` 恒为 0,滚动到底这件事在单测里
 * **根本量不出来**。`shell-collapse-on-done.test.tsx` 那条守卫也只在**规则文本**上挡
 * `.fold.flat::details-content`(那是有过真机事故的那一条);它挡不住「用别的写法
 * 在限高盒外面又建了一层格式化上下文」。
 *
 * 这次加的是 `.fold[open] > .body { animation: opacity + translateY }`。它按设计
 * 不建立格式化上下文(`opacity` / `transform` 都不参与布局),但**设计意图不是证据** ——
 * 这个文件在 Chrome 里实测三件事:
 *
 *   ① 限高盒仍被 96px 卡住(`clientHeight` 落在 96 附近,而不是撑成内容高度);
 *   ② 内容确实溢出(`scrollHeight > clientHeight`)—— 否则①是空过的;
 *   ③ 滚到底之后,最后一行**真的在可视区内**(`scrollTop + clientHeight` 够到
 *      `scrollHeight`),而且最后一行元素的底边不超过盒子的底边。
 *
 * ③ 是当年那次事故的直接判据:用户报的是「最后一行被裁在下沿」。
 *
 * ── 怎么跑 ────────────────────────────────────────────────────────────
 *
 * 需要本机 Chrome。找不到就**跳过并说明**,不假装绿:
 *   OD_CHROME_PATH 可覆盖;默认走 macOS 的 `/Applications/Google Chrome.app`。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  process.env.OD_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((p): p is string => Boolean(p));

const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));

/** 在无头 Chrome 里打开 `file` 并跑 `expression`,把返回值带回来 */
const MEASURE = `
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = spawn(process.env.GAP_CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  /*
   * ⚠️ 这里**不要**加 --force-prefers-reduced-motion。
   *
   * 实测它不生效(2026-11-21,本机 Chrome + headless=new):加了之后
   * matchMedia('(prefers-reduced-motion: reduce)').matches 仍为 true。
   * 真正的开关是 CDP 的 Emulation.setEmulatedMedia,见下面 MEASURE 里那一段。
   */
  '--user-data-dir=' + process.env.GAP_PROFILE,
  '--remote-debugging-port=' + process.env.GAP_PORT,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(250);
  try {
    const res = await fetch('http://127.0.0.1:' + process.env.GAP_PORT + '/json/list');
    const list = await res.json();
    const page = list.find((t) => t.type === 'page');
    if (page) { targets = page; break; }
  } catch {}
}
if (!targets) { console.error('no cdp'); process.exit(4); }

const ws = new WebSocket(targets.webSocketDebuggerUrl);
const send = (() => {
  let id = 0;
  const pending = new Map();
  const ready = new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg.result); }
  };
  return async (method, params) => {
    await ready;
    const myId = (id += 1);
    return new Promise((res) => {
      pending.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  };
})();

await send('Page.enable', {});
/*
 * **必须显式把 reduced-motion 模拟成 no-preference。**
 *
 * 无头 Chrome 在 macOS 上默认报告 prefers-reduced-motion: reduce(继承宿主的辅助
 * 功能设置),而 --force-prefers-reduced-motion 这个 flag 实测**不起作用**
 * (量出来仍是 reduce: true)。于是展开动画被本文件那条 reduced-motion 关断吃掉,
 * animationName 永远是 none —— 这条守卫就成了**空跑**:它看起来在验「动画生效时的
 * 布局」,实际量的是「动画没生效时」,而后者恰恰是最安全的那一态。
 *
 * CDP 的 Emulation.setEmulatedMedia 才是有效路径。
 */
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
});
await send('Page.navigate', { url: 'file://' + process.env.GAP_FILE });
await sleep(1200);
const out = await send('Runtime.evaluate', { expression: process.env.GAP_EXPR, returnByValue: true });
ws.close();
chrome.kill('SIGKILL');
if (out.exceptionDetails) { console.error(JSON.stringify(out.exceptionDetails)); process.exit(3); }
process.stdout.write('GAP_JSON:' + JSON.stringify(out.result.value));
`;

function measure(file: string, expression: string): unknown {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', MEASURE], {
    encoding: 'utf-8',
    timeout: 120_000,
    env: {
      ...process.env,
      GAP_CHROME: CHROME!,
      GAP_FILE: file,
      GAP_EXPR: expression,
      GAP_PORT: String(9700 + (process.pid % 90)),
      GAP_PROFILE: mkdtempSync(join(tmpdir(), 'fold-anim-chrome-')),
    },
  });
  const marker = (run.stdout ?? '').indexOf('GAP_JSON:');
  if (marker === -1) {
    throw new Error(`Chrome 量不到布局:\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  }
  return JSON.parse(run.stdout.slice(marker + 'GAP_JSON:'.length));
}

const CSS = readFileSync(resolve(HERE, '../../../src/components/chat/primitives/record.module.css'), 'utf-8');

/**
 * 一页最小 DOM:**壳 → 一摞 → 一个限高滚动盒 + 足够多的行**。
 *
 * 结构照真产品的层级写(`.fold.flat > .body.stack > .fold.thoughts > .body.scroll`),
 * 只保留与「限高盒会不会被外层新格式化上下文影响」相关的那几层。
 *
 * 关键:那个 `.body` 必须**开着**(`<details open>`)—— 动画只在 `[open]` 命中,
 * 而我们要验的是动画生效之后限高盒还好不好使。
 */
function probeHtml(): string {
  const rows = Array.from({ length: 40 }, (_, i) => `<div>第 ${i + 1} 行推理内容</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
body { margin: 0; padding: 16px; font: 13px/1.7 -apple-system, sans-serif; width: 420px; }
</style></head><body>
<details class="fold flat" open>
  <summary>已完成</summary>
  <div class="body stack">
    <details class="fold thoughts" open>
      <summary>思考过程</summary>
      <div class="body stack scroll">${rows}</div>
    </details>
  </div>
</details>
</body></html>`;
}

/**
 * 量那个限高盒。
 *
 * `lastRowBottom` 用**最后一个子元素的底边**减去盒子的底边 —— 负数说明它还完整地
 * 在可视区里(这才是「滚得到底」)。只看 `scrollTop + clientHeight >= scrollHeight`
 * 不够:内容被裁在 padding 里时那条件也可能成立。
 */
const PROBE = `(() => {
  const box = document.querySelector('.fold.thoughts > .body.scroll');
  if (!box) return { error: 'limit-height box not found' };
  const cs = getComputedStyle(box);
  const last = box.lastElementChild;
  const boxRect = box.getBoundingClientRect();
  // 滚到底
  box.scrollTop = box.scrollHeight;
  const lastRect = last.getBoundingClientRect();
  const boxAfter = box.getBoundingClientRect();
  return {
    maxHeight: cs.maxHeight,
    overflowY: cs.overflowY,
    clientHeight: box.clientHeight,
    scrollHeight: box.scrollHeight,
    scrollTop: Math.round(box.scrollTop),
    // >0 表示内容确实溢出了(否则「滚得到底」这条是空过的)
    overflowBy: box.scrollHeight - box.clientHeight,
    // <=0 表示最后一行完整落在盒子底边之上
    lastRowBottomOverflow: Math.round(lastRect.bottom - boxAfter.bottom),
    bodyHeightBeforeScroll: Math.round(boxRect.height),
    // 动画有没有真的挂上(确认这次量的是「动画生效后」的那一态)。
    // 选择器 .fold[open] 的直接子代 .body 正好命中这个限高盒本身。
    bodyHasAnimation: cs.animationName,
  };
})()`;

describe.skipIf(!CHROME)('展开动画生效时,限高滚动盒仍然滚得到底(真 Chrome)', () => {
  it('限高仍 96px、内容确实溢出、滚到底后最后一行完整可见', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fold-anim-'));
    const file = join(dir, 'probe.html');
    writeFileSync(file, probeHtml(), 'utf-8');

    const m = measure(file, PROBE) as Record<string, number | string>;

    expect(m.error, `探针没找到限高盒:${JSON.stringify(m)}`).toBeUndefined();

    // ① 限高盒还是限高盒
    expect(m.maxHeight).toBe('96px');
    expect(m.overflowY).toBe('auto');

    // ② 内容确实溢出 —— 否则下面那条是空过的
    expect(Number(m.overflowBy), '内容没溢出,这条守卫就是空跑').toBeGreaterThan(0);

    // ③ 滚到底之后最后一行完整在可视区内(当年的事故就是这一条不成立)
    expect(
      Number(m.lastRowBottomOverflow),
      `滚到底之后最后一行仍被裁掉了 ${m.lastRowBottomOverflow}px`,
    ).toBeLessThanOrEqual(1);

    // ④ 反向确认:这次量的确实是「展开动画生效」的那一态
    expect(String(m.bodyHasAnimation)).toBe('fold-body-in');
  });
});

describe('找不到 Chrome 时', () => {
  it('明确跳过,而不是假装通过', () => {
    if (CHROME) return;
    // eslint-disable-next-line no-console -- 跳过的原因要落在跑测输出里
    console.log('[跳过] 本机没有 Chrome,布局守卫未执行(设 OD_CHROME_PATH 可指定)');
    expect(true).toBe(true);
  });
});
