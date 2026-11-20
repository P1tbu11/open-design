// @vitest-environment jsdom
/**
 * 工具调用是**一等公民**:折叠态一行摘要,展开是参数与输出。
 *
 * ── 修之前是什么样 ────────────────────────────────────────────────────
 *
 * 一个 antigravity(`agy`)的调用在界面上只剩 `run_command` 这一行字加一个耗时。
 * 根因两层,缺一条都修不好:
 *  · daemon:`tool_info.parameters` 是 PascalCase(`CommandLine` / `Path`),整条前端
 *    管线读小写规范键 —— 于是 `toolKind` 落到 `other`,标题退回工具名;
 *  · 前端:`buildToolRow` 的 `terminal` 写死成 `command ? … : null`,非命令类调用的
 *    返回值**从来没上过屏**;而 `other` 那一档根本不折叠,连一块放参数的地方都没有。
 *
 * 这组用例从**帧形状**开始(和 daemon 收到的逐字一致),一路验到 DOM 里的字 ——
 * 不手搓 `row.terminal`,那样只能证明「我摆好的数据能画出来」。
 *
 * ── 防假绿 ───────────────────────────────────────────────────────────
 *
 * · 断言的是**文字在不在 DOM 里**、`<details>` 的 `open`、以及两段 `data-testid`,
 *   不断言 CSS 类名(vitest 的 CSS Module 代理对任何 key 都返回类名)。
 * · 每条「有内容」都配一条反向对照(`没有内容 → 不是折叠块`),否则「一律折叠」也能
 *   让正例全绿,而一枚展不开的箭头比单行更糟。
 * · 写 / 改那一档**故意**不展开参数:那是另一条裁决(`write-live-preview.test.tsx`),
 *   这里钉住它没被顺手带开。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { PersistedAgentEvent } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { ToolRow } from '../../../src/components/chat/primitives/ToolRow';
import { buildTurnBlocks } from '../../../src/runtime/chat/build-turn-blocks';
import { TOOL_DETAIL_MAX_CHARS } from '../../../src/runtime/chat/tool-detail';
import type { ToolRow as ToolRowData, TurnBlock } from '../../../src/runtime/chat/contract';

afterEach(cleanup);

function render(ui: ReactElement) {
  const wrap = (node: ReactElement) => <I18nProvider initial="zh-CN">{node}</I18nProvider>;
  const result = rtlRender(wrap(ui));
  return { ...result, rerender: (next: ReactElement) => result.rerender(wrap(next)) };
}

function row(over: Partial<ToolRowData> = {}): ToolRowData {
  return {
    kind: 'tool',
    id: 't1',
    tool: 'other',
    name: 'manage_task',
    title: 'manage_task',
    rawTitle: false,
    file: null,
    pattern: null,
    hits: null,
    delta: null,
    elapsedMs: 1200,
    pending: false,
    failed: false,
    failReason: null,
    command: null,
    terminal: null,
    ...over,
  };
}

const fold = (): HTMLDetailsElement | null => document.querySelector<HTMLDetailsElement>('details');
const detail = (): HTMLElement | null => screen.queryByTestId('chat-tool-detail');

/** 浏览器在 `open` 属性被写回时派发的那一次 —— 不是用户点的(OPEND-2557) */
const echoToggle = (el: HTMLDetailsElement): void => {
  fireEvent(el, new Event('toggle', { bubbles: false }));
};

function clickSummary(el: HTMLDetailsElement): void {
  const s = el.querySelector<HTMLElement>('summary');
  if (!s) throw new Error('summary 没渲染出来');
  fireEvent.click(s);
  echoToggle(el);
}

/* ── 折叠态:一行摘要,说得出这次调用在干什么 ───────────────────────────── */

describe('折叠态 —— 裸工具名那一档现在带一句参数摘要', () => {
  it('认不出语义的工具:名字原样 + 参数摘要一行', () => {
    render(<ToolRow row={row({ input: { Query: 'useThinkingFollow', SearchPath: '/p/src' } })} />);

    expect(screen.getByText(/manage_task/)).toBeTruthy();
    // 摘要是「参数里最能说明在干什么」的那个标量
    expect(screen.getByTestId('chat-tool-preview').textContent).toBe('useThinkingFollow');
    // 收起时不该有详情面板
    expect(detail()).toBeNull();
  });

  it('摘要和标题逐字相同时不重复画一遍', () => {
    // `title` 已经等于命令原文时(命令类),摘要只会是它的截断版
    render(<ToolRow row={row({ input: { CommandLine: 'ls -la' }, title: 'ls -la' })} />);
    expect(screen.queryByTestId('chat-tool-preview')).toBeNull();
  });

  it('没有可摘的参数时退回稿子那一行,不画一句假的', () => {
    render(<ToolRow row={row({ input: { WaitMsBeforeAsync: 5000 } })} />);
    expect(screen.queryByTestId('chat-tool-preview')).toBeNull();
    expect(screen.getByText(/manage_task/)).toBeTruthy();
  });

  it('命令类不出摘要 —— 命令原文就在 `.name` 里', () => {
    render(<ToolRow row={row({ tool: 'exec', name: 'run_command', title: 'ls -la', rawTitle: true, command: 'ls -la', input: { command: 'ls -la' } })} />);
    expect(screen.queryByTestId('chat-tool-preview')).toBeNull();
  });
});

/* ── 展开态:参数与输出两段 ───────────────────────────────────────────── */

describe('展开态 —— 参数(Input)与输出(Output)', () => {
  const inspectable = (over: Partial<ToolRowData> = {}) => row({
    tool: 'read',
    name: 'read_file',
    title: 'brand.md',
    file: { path: '/p/brand.md', label: 'brand.md' },
    input: { Path: '/p/brand.md', StartLine: 1, EndLine: 40 },
    terminal: 'Showing lines 1-40 of 40',
    ...over,
  });

  it('可读的行是折叠块,展开后两段都在 DOM 里', () => {
    const { container } = render(<ToolRow row={inspectable()} deferBody />);
    const el = fold();
    expect(el, '读取行该是折叠块').not.toBeNull();
    expect(el!.open).toBe(false);
    expect(detail()).toBeNull();

    clickSummary(el!);
    expect(el!.open).toBe(true);
    expect(container.textContent).toContain('参数');
    expect(container.textContent).toContain('/p/brand.md');
    expect(container.textContent).toContain('输出');
    expect(container.textContent).toContain('Showing lines 1-40 of 40');
  });

  it('两段各带自己的 data-testid,便于定位与断言', () => {
    render(<ToolRow row={inspectable()} />);
    clickSummary(fold()!);
    expect(screen.getByTestId('chat-tool-detail-input').textContent).toContain('/p/brand.md');
    expect(screen.getByTestId('chat-tool-detail-output').textContent).toContain('Showing lines 1-40');
  });

  it('只有输出、没有参数时:输出那一段照画,参数那一段不出现', () => {
    render(<ToolRow row={inspectable({ input: undefined })} />);
    clickSummary(fold()!);
    expect(screen.queryByTestId('chat-tool-detail-input')).toBeNull();
    expect(screen.getByTestId('chat-tool-detail-output').textContent).toContain('Showing lines 1-40');
  });

  it('只有参数、没有输出时:参数照画,输出那一段不出现', () => {
    render(<ToolRow row={inspectable({ terminal: null })} />);
    clickSummary(fold()!);
    expect(screen.getByTestId('chat-tool-detail-input')).toBeTruthy();
    expect(screen.queryByTestId('chat-tool-detail-output')).toBeNull();
  });

  it('失败行仍然是单行(走它自己那支),不被顺手改成折叠块', () => {
    render(<ToolRow row={inspectable({ failed: true, failReason: null })} />);
    expect(fold(), '没原文可给的失败行不该长出箭头').toBeNull();
    expect(screen.getByText('失败')).toBeTruthy();
  });

  /*
   * ── 执行中也给箭头与面板,只是**默认不自动摊开**(T61)──────────────────
   *
   * 上一版执行中退回单行,理由是「参数和返回值在跑完之前一个字都不会变,提前摊开
   * 没有新信息可看」。那段推理只对了一半:**摊开**确实没新信息,但**能摊开**本身
   * 是那一行的可观测性 —— 用户看到的是球在转、秒表在走,却点不开任何东西,
   * 而这一行跑完之后才突然长出箭头。中间那几十秒里「它在干什么」完全问不到答案。
   *
   * 「看得见在跑」的信号改由那层流光(`.live`)承担,不再靠「什么都不给你看」。
   */
  it('执行中就有箭头、点开能读参数 —— 但不自动摊开', () => {
    const { container } = render(<ToolRow running row={inspectable({ pending: true, elapsedMs: 4_100 })} />);
    const el = fold();
    expect(el, '执行中也该是可展开的卡片').not.toBeNull();
    expect(el!.open, '但不自动摊开(摊开没有新信息)').toBe(false);

    // 行本身仍然一发出就上屏(OPEND-2419 的红线)
    expect(container.textContent).toContain('brand.md');
    expect(container.textContent).toContain('4.1s');

    clickSummary(el!);
    expect(screen.getByTestId('chat-tool-detail-input'), '执行中点开也要读得到参数').toBeTruthy();
  });

  it('执行中的行带流光类;跑完之后流光撤掉', () => {
    const { container, rerender } = render(<ToolRow running row={inspectable({ pending: true })} />);
    expect(
      [...container.querySelectorAll('[class*="live"]')].length,
      '执行中该有流光',
    ).toBeGreaterThan(0);

    rerender(<ToolRow row={inspectable({ pending: false, elapsedMs: 400 })} />);
    expect(
      [...container.querySelectorAll('[class*="live"]')].length,
      '跑完流光要撤掉',
    ).toBe(0);
  });

  /*
   * ⚠️ 判据是 `pending && running`,**两个都要**。只看 `pending` 的话,用户按停止
   * 之后它永远为真 —— 那些行会一直流光,读成「还在跑」,而它其实早就不会动了。
   */
  it('轮次停了但调用没回来:流光必须撤掉(否则读成还在跑)', () => {
    const { container } = render(<ToolRow row={inspectable({ pending: true })} />);
    expect([...container.querySelectorAll('[class*="live"]')].length).toBe(0);
    expect(fold(), '但仍然可展开,参数读得到').not.toBeNull();
  });

  it('反向对照:认不出语义的行同样遵守这条', () => {
    const other = (over: Partial<ToolRowData> = {}) =>
      row({ tool: 'other', name: 'manage_task', title: 'manage_task', input: { Query: 'x' }, ...over });
    const { rerender } = render(<ToolRow running row={other({ pending: true })} />);
    expect(fold(), '执行中的元工具也可展开').not.toBeNull();
    expect(fold()!.open, '但默认收起').toBe(false);

    rerender(<ToolRow row={other({ pending: false })} />);
    expect(fold(), '跑完照旧可展开').not.toBeNull();
  });

  /*
   * ⚠️ 判据不能只看 `row.pending`:它的定义是「结果从来没回来过」,用户按停止之后
   * 它永远为真。只看它,这些行会**永远**停在「紧凑单行」—— 参数也就永远读不到。
   *
   * 正确形态:轮次停了 → 不再是「此刻在跑」→ 变回折叠块,但**默认收起**
   * (`lifecycleOpen` 仍然为假,因为它要求 `running`)。用户想看参数能点开,
   * 不想看就只是一行。
   */
  it('轮次停了但调用没回来:变回折叠块,但默认收起 —— 参数仍然读得到', () => {
    // 轮次已停(不传 running),result 永远等不到
    const { container } = render(<ToolRow row={inspectable({ pending: true })} />);
    const el = fold();
    expect(el, '轮次停了就该是可展开的卡片(否则参数永远读不到)').not.toBeNull();
    expect(el!.open, '但不再自动摊着').toBe(false);
    expect(container.textContent).toContain('brand.md');

    clickSummary(el!);
    expect(screen.getByTestId('chat-tool-detail-input'), '点开就能读参数').toBeTruthy();
  });

  it('命令类不受这条影响 —— 它执行中仍然自动摊开(既有裁决)', () => {
    const { container } = render(<ToolRow running row={row({
      tool: 'exec',
      name: 'Bash',
      title: '构建',
      rawTitle: false,
      command: 'npm run build',
      terminal: 'vite building…',
      pending: true,
      elapsedMs: 4_100,
    })} />);
    const el = fold();
    expect(el, '命令行该是折叠块').not.toBeNull();
    expect(el!.open, '执行中的命令自动摊开:在途输出要看得见').toBe(true);
    expect(container.textContent).toContain('vite building…');
  });

  it('每一行只出现**一个**耗时 —— `Foldable` 那一格和摘要里的 `metaSlot` 不许同时给', () => {
    /*
     * 这条是实际渲染出来才发现的:文件行那一支的 `summary` 里本来就有 `metaSlot`
     * (稿子的 `.ms` 槽),而 `Foldable` 的 `elapsed` 是它**自己**那一格。两处都传,
     * 行尾就是 `0.4s0.4s` —— 一个假数字并排出现两次。
     */
    const { container } = render(<ToolRow row={inspectable()} />);
    const summary = container.querySelector('summary')!;
    // 夹具给的是 1.2s(见 `row()` 的默认值)
    const occurrences = (summary.textContent ?? '').match(/\d+\.\d+s/g) ?? [];
    expect(occurrences, `summary 里的耗时格数量:${JSON.stringify(occurrences)}`).toHaveLength(1);
  });

  it('认不出语义的行也一样只给一个耗时', () => {
    const { container } = render(<ToolRow row={row({ input: { Query: 'x' }, elapsedMs: 1200 })} />);
    const summary = container.querySelector('summary')!;
    expect((summary.textContent ?? '').match(/1\.2s/g) ?? []).toHaveLength(1);
  });

  it('摘要里仍然有文件名与动词(折叠块只多了一枚箭头)', () => {
    const { container } = render(<ToolRow row={inspectable()} />);
    const summary = container.querySelector('summary')!;
    expect(summary.textContent).toContain('读取');
    expect(summary.textContent).toContain('brand.md');
  });
});

/* ── 防卡死:超长输出截断 ─────────────────────────────────────────────── */

describe('超长输出截断', () => {
  it('超过上限:只铺上限那么多字,并明确告诉用户被截断了', () => {
    const huge = Array.from({ length: 5_000 }, (_, i) => `line-${i}`).join('\n');
    const { container } = render(<ToolRow row={row({
      tool: 'read',
      name: 'read_file',
      title: 'huge.log',
      file: { path: '/p/huge.log', label: 'huge.log' },
      terminal: huge,
    })} />);
    clickSummary(fold()!);

    const section = screen.getByTestId('chat-tool-detail-output');
    // 只铺封顶那一截 —— 整份 5000 行一个节点都不多挂
    expect(section.textContent!.length).toBeLessThan(huge.length);
    expect(section.textContent).toContain('line-0');
    expect(section.textContent).not.toContain('line-4999');
    // 提示是用户唯一知道「还有下文」的地方
    expect(container.textContent).toContain('输出过长已截断');
  });

  it('没超过上限就不出现截断提示(反向对照,否则「一律提示」也能绿)', () => {
    const { container } = render(<ToolRow row={row({
      tool: 'read',
      name: 'read_file',
      title: 'small.html',
      file: { path: '/p/small.html', label: 'small.html' },
      terminal: 'ok',
    })} />);
    clickSummary(fold()!);
    expect(container.textContent).not.toContain('输出过长已截断');
  });

  it('上限就是那个数(2 000),不多不少', () => {
    expect(TOOL_DETAIL_MAX_CHARS).toBe(2_000);
  });
});

/* ── 写 / 改:内容不许上屏(另一条裁决,这里守住它)────────────────────── */

describe('写 / 改的行不把文件内容铺到页面上', () => {
  const SOURCE = '<h1>PARCHMENT_SOURCE_LEAKED</h1>';
  it('Write 仍然是单行 + 改动量,不是折叠块', () => {
    const { container } = render(<ToolRow row={row({
      tool: 'write',
      name: 'Write',
      title: 'design.html',
      file: { path: 'design.html', label: 'design.html' },
      delta: { added: 5, removed: 0 },
      input: { file_path: 'design.html', content: SOURCE },
      terminal: 'created',
    })} />);
    expect(fold(), '写文件那一支不该被顺手改成折叠块').toBeNull();
    expect(container.textContent).toContain('+5');
    expect(container.textContent).not.toContain('PARCHMENT_SOURCE_LEAKED');
  });

  it('Edit 也一样', () => {
    const { container } = render(<ToolRow row={row({
      tool: 'edit',
      name: 'Edit',
      title: 'design.html',
      file: { path: 'design.html', label: 'design.html' },
      input: { file_path: 'design.html', old_string: 'a', new_string: SOURCE },
    })} />);
    expect(fold()).toBeNull();
    expect(container.textContent).not.toContain('PARCHMENT_SOURCE_LEAKED');
  });
});

/* ── 整条链:agy 的帧形状 → 事件流 → row → DOM ─────────────────────────── */

describe('从真事件流验起(不手搓 row)', () => {
  /** `agy` 真机帧:`tool_info.parameters` 是 PascalCase,`output` 带退出码信封 */
  const agyToolEvents = (): PersistedAgentEvent[] => ([
    {
      kind: 'tool_use',
      id: 'c-1:4',
      name: 'run_command',
      // daemon 归一之后的样子(`normalizeAntigravityToolParameters`)
      input: {
        command: 'npm run build',
        od_tool_args: { CommandLine: 'npm run build', toolSummary: 'Package build' },
      },
      startedAt: 1_000,
    },
    {
      kind: 'tool_result',
      toolUseId: 'c-1:4',
      content: 'Command exited with code 0.\n\nCommand output:\n✓ built in 8.42s',
      isError: false,
      completedAt: 28_000,
    },
  ] as unknown as PersistedAgentEvent[]);

  const firstToolRow = (): ToolRowData => {
    const blocks = buildTurnBlocks({ events: agyToolEvents(), runStatus: 'succeeded' });
    const items = blocks.flatMap((b: TurnBlock) =>
      b.kind === 'shell' ? [...b.items, ...b.segments.flatMap((s) => s.items)] : [],
    );
    const found = items.find((i): i is ToolRowData => i.kind === 'tool');
    if (!found) throw new Error('事件流没产出一行');
    return found;
  };

  it('命令落成「执行 <命令>」,不再是裸 run_command', () => {
    const r = firstToolRow();
    expect(r.tool).toBe('exec');
    expect(r.command).toBe('npm run build');
    expect(r.rawTitle).toBe(true);
    // 27 秒的调用如实报 27 秒
    expect(r.elapsedMs).toBe(27_000);
  });

  it('这一行渲染出来:命令在摘要里,输出在展开的终端块里(已有的那条通道没坏)', () => {
    const { container } = render(<ToolRow row={firstToolRow()} />);
    expect(container.textContent).toContain('执行');
    expect(container.textContent).toContain('npm run build');
    clickSummary(fold()!);
    expect(container.textContent).toContain('built in 8.42s');
  });

  it('读文件那一行:文件名在,展开是路径参数与返回正文', () => {
    const blocks = buildTurnBlocks({
      events: [
        {
          kind: 'tool_use',
          id: 'c-1:2',
          name: 'read_file',
          input: { file_path: '/p/brand.md', od_tool_args: { Path: '/p/brand.md' } },
          startedAt: 1_000,
        },
        {
          kind: 'tool_result', toolUseId: 'c-1:2',
          content: '# Brand\n\n羊皮纸与 Charter 字体栈',
          isError: false, completedAt: 2_000,
        },
      ] as unknown as PersistedAgentEvent[],
      runStatus: 'succeeded',
    });
    const items = blocks.flatMap((b: TurnBlock) =>
      b.kind === 'shell' ? [...b.items, ...b.segments.flatMap((s) => s.items)] : [],
    );
    const r = items.find((i): i is ToolRowData => i.kind === 'tool' && i.name === 'read_file');
    if (!r) throw new Error('读取行没产出');

    expect(r.tool).toBe('read');
    const { container } = render(<ToolRow row={r} />);
    expect(container.textContent).toContain('读取');
    clickSummary(fold()!);
    expect(container.textContent).toContain('羊皮纸与 Charter 字体栈');
  });
});
