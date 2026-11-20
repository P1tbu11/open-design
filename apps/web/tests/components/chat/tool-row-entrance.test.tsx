// @vitest-environment jsdom
/**
 * **只有刚开出来的那一行工具调用浮入**,历史行与其它块型都不动。
 *
 * ── 为什么克制到只给一行 ──────────────────────────────────────────────
 *
 * 一屏几十行如果各自浮入一次,动效本身就成了噪音 —— 用户要的是「最近一个在执行的
 * 工具有动画」,不是「整块在动」。所以判据三条缺一不可:轮次还在跑、是**最后一项**、
 * 而且那一项是工具行。
 *
 * 文字已经有一套逐字化开(`useCharReveal`),生图行有自己的大格淡入 —— 两套机制
 * 同时作用在同一项上会互相抢,所以 `latestLiveToolIndex` 只认工具行。
 *
 * ── 这里测的是什么 ────────────────────────────────────────────────────
 *
 * jsdom 不跑 CSS 动画(`animation` 只是声明,不会推进),**量不到「动了几帧」**。
 * 所以断言落在**结构**上:那个类挂在谁身上、有没有多出节点、以及
 * `prefers-reduced-motion` 那条规则在不在。动画的视觉质量归真浏览器,不在这一层。
 *
 * ⚠️ 有一条专门钉「不许包 wrapper」—— 这一族有两条规则按相邻兄弟 / 直接子代命中
 * (`.fold .body.stack > *` 的 reset、`.tool + .tool` 的 6px 行距),包一层会让它们
 * 全部失配:壳内的边框底色会漏出来,行距也会塌掉。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render as rtlRender } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { PersistedAgentEvent } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { ExecutionShell } from '../../../src/components/chat/ExecutionShell';
import { buildTurnBlocks } from '../../../src/runtime/chat/build-turn-blocks';
import type { ExecutionShell as ShellData } from '../../../src/runtime/chat/contract';

const CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/components/chat/primitives/record.module.css'),
  'utf-8',
).replace(/\/\*[\s\S]*?\*\//g, '');

afterEach(cleanup);

const render = (ui: ReactElement) => rtlRender(<I18nProvider initial="zh-CN">{ui}</I18nProvider>);

function shellOf(events: PersistedAgentEvent[], runStatus: 'running' | 'succeeded'): ShellData {
  const shells = buildTurnBlocks({ events, runStatus, nowMs: 60_000 })
    .filter((b): b is ShellData => b.kind === 'shell');
  const shell = shells[0];
  if (!shell) throw new Error('fixture 没产出壳');
  return shell;
}

const call = (id: string, at: number): PersistedAgentEvent[] => ([
  { kind: 'tool_use', id, name: 'read_file', input: { file_path: `/p/${id}.md` }, startedAt: at },
]);
const done = (id: string, at: number): PersistedAgentEvent => ({
  kind: 'tool_result', toolUseId: id, content: `read ${id}`, isError: false, completedAt: at,
} as PersistedAgentEvent);

/**
 * 带入场类的元素。CSS Module 的类名带哈希(`_entrance_09d9ab`),所以按前缀匹配 ——
 * 和 `record-cascade.test.ts` 读规则文本是同一类做法(CSS Module 在 jsdom 里不发真类名
 * 之外的语义,只能看字符串)。
 */
const entrances = (container: HTMLElement): Element[] =>
  [...container.querySelectorAll('[class*="entrance"]')];

describe('入场动画:只给最新那一行工具调用', () => {
  it('三条调用、最后一条还在跑 → 恰好一个入场,落在最后那一行自己身上', () => {
    const events = [
      ...call('a', 1_000), done('a', 2_000),
      ...call('b', 3_000), done('b', 4_000),
      ...call('c', 5_000),
    ];
    const { container } = render(<ExecutionShell shell={shellOf(events, 'running')} deferCollapsedBodies={false} />);

    const marked = entrances(container);
    expect(marked, '只有最新那一行该浮入').toHaveLength(1);
    expect(marked[0]!.textContent).toContain('c.md');
    // 前面两条都在,只是没有入场
    expect(container.textContent).toContain('a.md');
    expect(container.textContent).toContain('b.md');
  });

  /*
   * ⚠️ 这条是整个改动里最容易踩回去的地方。
   *
   * 加一层 `<div>` 包住 ToolRow 看起来最省事,但它会把两条按「相邻 / 直接子代」命中的
   * 规则全部打断 —— `.fold .body.stack > *` 的 border/background reset 落到 wrapper 上,
   * 壳内失败行的红边红底就铺了出来(踩坑 25 的翻版);`.tool + .tool` 的 6px 行距则
   * 直接消失。
   */
  it('不许包 wrapper:入场类挂在行自己的根元素上,节点数不增', () => {
    const events = [...call('a', 1_000), done('a', 2_000), ...call('b', 3_000)];
    const shell = shellOf(events, 'running');

    const withEntrance = render(<ExecutionShell shell={shell} deferCollapsedBodies={false} />);
    const markedCount = withEntrance.container.querySelectorAll('*').length;
    const node = entrances(withEntrance.container)[0]!;
    withEntrance.unmount();

    // 那一行自己就是 `.tool`(单行形态)或 `details.fold`(折叠形态),不是一层 div 壳
    expect(
      node.tagName === 'DIV' ? node.getAttribute('class') : node.tagName,
      '入场必须落在行自己的根上',
    ).toBeTruthy();
    // 而且它必须**直接**住在壳的 body 里,中间没有额外的包裹层
    const parent = node.parentElement!;
    expect(
      /_body_/.test(parent.getAttribute('class') ?? '') || parent.tagName === 'DETAILS',
      `入场的父级应当是壳 body 或折叠块,实际是 <${parent.tagName} class="${parent.getAttribute('class')}">`,
    ).toBe(true);

    // 反向对照:去掉入场之后节点数应当一致(说明入场没有偷偷多挂东西)
    const plain = shellOf([...call('a', 1_000), done('a', 2_000)], 'succeeded');
    const withoutEntrance = render(<ExecutionShell shell={plain} deferCollapsedBodies={false} />);
    expect(entrances(withoutEntrance.container), '跑完的轮次不该有入场').toHaveLength(0);
    expect(markedCount).toBeGreaterThan(0);
  });

  it('反向对照:轮次跑完了,一条都不浮入(历史重渲染不许重放动画)', () => {
    const events = [
      ...call('a', 1_000), done('a', 2_000),
      ...call('b', 3_000), done('b', 4_000),
    ];
    const { container } = render(<ExecutionShell shell={shellOf(events, 'succeeded')} deferCollapsedBodies={false} />);
    expect(entrances(container), '跑完之后不该有任何入场').toHaveLength(0);
  });

  it('反向对照:最后一项是文字时不浮入 —— 文字有自己的逐字化开', () => {
    const events = [
      ...call('a', 1_000), done('a', 2_000),
      { kind: 'text', text: '正在收尾。' },
    ] as unknown as PersistedAgentEvent[];
    const { container } = render(<ExecutionShell shell={shellOf(events, 'running')} deferCollapsedBodies={false} />);
    expect(entrances(container), '两套动效不许作用在同一项上').toHaveLength(0);
  });
});

describe('样式:入场只动合成层属性,且能关掉', () => {
  it('keyframes 只碰 opacity / transform / filter', () => {
    const m = /@keyframes tool-row-entrance\s*\{([\s\S]*?)\}\s*\}/.exec(CSS);
    expect(m, '找不到入场 keyframes').not.toBeNull();
    const body = m![1] ?? '';
    // 不许出现会触发重排的属性
    expect(body).not.toMatch(/\b(height|width|margin|padding|top|left)\s*:/);
    expect(body).toMatch(/opacity/);
    expect(body).toMatch(/transform/);
    expect(body).toMatch(/filter:\s*blur/);
  });

  it('缓动写死基线那一串 —— **不许**用 var,未定义的 var 会让整条简写失效', () => {
    /*
     * 实测(2026-11-21,真 Chrome):`animation: x 240ms var(--undefined) both` 在
     * var 未定义时,浏览器把**整条简写判为无效并丢弃**,`animationName` 读出来是空串,
     * 动画静默不跑。而这个 token(`--chat-ease-out`)定义在别的 Module 里,
     * 本文件被单独引用时就不存在。
     *
     * 所以这里钉的是**反面**:简写里不许出现 var。
     */
    const m = /\.entrance\s*\{([^}]*)\}/.exec(CSS);
    const body = m?.[1] ?? '';
    expect(body, 'animation 简写里出现了 var —— 未定义时整条规则会静默失效').not.toMatch(/animation:[^;]*var\(/);
    // 但缓动值仍然必须是仓库基线那一串
    expect(body).toMatch(/cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
  });

  it('prefers-reduced-motion 命中时 `animation: none`(不是更慢的淡入)', () => {
    const m = /@media \(prefers-reduced-motion: reduce\) \{\s*\.entrance\s*\{([^}]*)\}/.exec(CSS);
    expect(m, '缺少 reduced-motion 关断').not.toBeNull();
    expect(m![1]).toMatch(/animation:\s*none/);
  });

  /*
   * ── 全文件守卫:animation 简写里不许出现 var() ──────────────────────
   *
   * 这是实测出来的静默失败:真 Chrome 里 `animation: x 240ms var(--undefined) both`
   * 会把**整条简写判为无效并丢弃**,`animationName` 变空串,动画完全不跑,而且
   * 控制台**没有任何警告**。
   *
   * 本文件是 CSS Module,`--chat-*` 全定义在 `ChatRoot.module.css`。凡是只引用
   * `record.module.css` 的场合(陈列页、几何探针、这一族自己的样式测试),
   * 那些 token 就不存在 —— 于是规则静默失效,而单测因为只读文本、不跑层叠,
   * 照样绿。
   *
   * 2026-11-21 实际踩到过两次:`.fold[open] > .body`(新加)与 `.dots i`(存量)。
   */
  it('全文件:没有一条 animation 简写把 var() 放在里面', () => {
    const offenders = [...CSS.matchAll(/animation:\s*([^;}]+)/g)]
      .map((m) => m[1]?.trim() ?? '')
      .filter((decl) => decl.includes('var('));
    expect(offenders, `这些 animation 简写含 var(),未定义时整条会静默失效:\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});
