// @vitest-environment jsdom
/**
 * `@beui/agent-activity` 风格前端动效回归测试:
 *  1. Foldable / ToolRow 双向折叠动效:140ms WAAPI 收起、中途重开取消、prefers-reduced-motion 瞬时直通、aria-busy
 *  2. ToolDetail 搜索来源链接芯片(纯文本 + 域名徽标,零第三方 favicon 请求)
 *  3. SayText 壳内流式逐字化开 vs 非流式静态落定
 *  4. 单包直播 SSE(`agy` 类)首次挂载 ProseBlock 触发 planReveal vs 历史加载 / 设置页返回 0 `.rv`
 *  5. useThinkingFollow 140ms WAAPI 阻尼滑移跟随 + 176px liveViewport 三态半透遮罩视窗 + 用户上滚 / 触碰即时取消
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { useRef, type ReactElement } from 'react';
import { I18nProvider } from '../../../src/i18n';
import { AssistantMessage } from '../../../src/components/AssistantMessage';
import { createBufferedTextUpdates } from '../../../src/components/ProjectView';
import { ExecutionShell } from '../../../src/components/chat/ExecutionShell';
import { Foldable, FOLD_CLOSE_MS, FOLD_EASE_OUT } from '../../../src/components/chat/primitives/Foldable';
import { SayText } from '../../../src/components/chat/primitives/SayText';
import { ToolRow } from '../../../src/components/chat/primitives/ToolRow';
import { useThinkingFollow } from '../../../src/components/chat/primitives/useThinkingFollow';
import { CHAR_MS, REVEAL_BUDGET_MS } from '../../../src/components/chat/useCharReveal';
import type { ExecutionShell as ShellData, ToolRow as ToolRowData } from '../../../src/runtime/chat/contract';
import type { ChatMessage } from '../../../src/types';

interface RecordedAnimation {
  target: Element;
  keyframes: Keyframe[] | PropertyIndexedKeyframes | null;
  options: number | KeyframeAnimationOptions | undefined;
  canceled: boolean;
  onfinish: ((this: Animation, ev: AnimationPlaybackEvent) => unknown) | null;
  finishNow: () => void;
}

function installMockWaapi() {
  const animations: RecordedAnimation[] = [];
  const original = HTMLElement.prototype.animate;

  HTMLElement.prototype.animate = vi.fn(function mockAnimate(
    this: HTMLElement,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ): Animation {
    const duration = typeof options === 'number'
      ? options
      : typeof options?.duration === 'number'
        ? options.duration
        : 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const rec: RecordedAnimation = {
      target: this,
      keyframes,
      options,
      canceled: false,
      onfinish: null,
      finishNow: () => {
        if (rec.canceled) return;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        rec.onfinish?.call(anim, new Event('finish') as AnimationPlaybackEvent);
      },
    };
    const anim = {
      get onfinish() {
        return rec.onfinish;
      },
      set onfinish(cb: ((this: Animation, ev: AnimationPlaybackEvent) => unknown) | null) {
        rec.onfinish = cb;
      },
      cancel: vi.fn(() => {
        rec.canceled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }),
    } as unknown as Animation;
    if (duration > 0) {
      timer = setTimeout(() => {
        timer = null;
        if (!rec.canceled) {
          rec.onfinish?.call(anim, new Event('finish') as AnimationPlaybackEvent);
        }
      }, duration);
    }
    animations.push(rec);
    return anim;
  });

  return {
    animations,
    restore: () => {
      if (original) {
        HTMLElement.prototype.animate = original;
      } else {
        // @ts-expect-error jsdom default has no Element.prototype.animate
        delete HTMLElement.prototype.animate;
      }
    },
  };
}

function renderI18n(ui: ReactElement) {
  const wrap = (node: ReactElement) => <I18nProvider initial="zh-CN">{node}</I18nProvider>;
  const view = rtlRender(wrap(ui));
  return { ...view, rerender: (next: ReactElement) => view.rerender(wrap(next)) };
}

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ── 1. Foldable / ToolRow 140ms WAAPI 收起动效 + 中途重开取消 + reduced-motion ── */

describe('Foldable & ToolRow 140ms WAAPI close animation', () => {
  it('holds [open] with data-closing during 140ms WAAPI exit on manual summary toggle, then closes', () => {
    vi.useFakeTimers();
    const waapi = installMockWaapi();
    try {
      const { container } = renderI18n(
        <Foldable summary={<span>推理步骤</span>} defaultOpen busy>
          <div>步骤详情内容</div>
        </Foldable>,
      );
      const details = container.querySelector('details')!;
      const summary = details.querySelector('summary')!;
      expect(details.open).toBe(true);
      expect(details.getAttribute('aria-busy')).toBe('true');

      fireEvent.click(summary);

      // 收起动画进行中:[open] 暂留,挂上 data-closing,WAAPI 跑 140ms ease-out
      expect(details.open).toBe(true);
      expect(details.getAttribute('data-closing')).toBe('true');
      expect(waapi.animations).toHaveLength(1);
      expect(waapi.animations[0]?.keyframes).toEqual([
        { opacity: 1, transform: 'translateY(0px)' },
        { opacity: 0, transform: 'translateY(-4px)' },
      ]);
      expect(waapi.animations[0]?.options).toMatchObject({
        duration: FOLD_CLOSE_MS,
        easing: FOLD_EASE_OUT,
        fill: 'forwards',
      });

      act(() => {
        vi.advanceTimersByTime(FOLD_CLOSE_MS);
      });
      expect(details.open).toBe(false);
      expect(details.getAttribute('data-closing')).toBeNull();
    } finally {
      waapi.restore();
    }
  });

  it('cancels an in-flight 140ms close animation cleanly when reopened mid-flight', () => {
    vi.useFakeTimers();
    const waapi = installMockWaapi();
    try {
      const { container } = renderI18n(
        <Foldable summary={<span>命令输出</span>} defaultOpen>
          <div>build output</div>
        </Foldable>,
      );
      const details = container.querySelector('details')!;
      const summary = details.querySelector('summary')!;

      // 开始收起
      fireEvent.click(summary);
      expect(details.getAttribute('data-closing')).toBe('true');
      expect(waapi.animations).toHaveLength(1);

      // 60ms 时用户重新点开:立即取消收起动画并恢复打开态
      act(() => {
        vi.advanceTimersByTime(60);
      });
      fireEvent.click(summary);
      expect(waapi.animations[0]?.canceled).toBe(true);
      expect(details.open).toBe(true);
      expect(details.getAttribute('data-closing')).toBeNull();

      // 原 140ms 到期后不会把已经重开的抽屉误关掉
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(details.open).toBe(true);
    } finally {
      waapi.restore();
    }
  });

  it('animates programmatic ToolRow collapse and ExecutionShell <od-done> auto-collapse, bypassing under prefers-reduced-motion', () => {
    vi.useFakeTimers();
    const waapi = installMockWaapi();
    try {
      const baseRow: ToolRowData = {
        kind: 'tool',
        id: 'cmd-1',
        tool: 'exec',
        name: 'Bash',
        title: '构建前端产物',
        rawTitle: false,
        file: null,
        pattern: null,
        hits: null,
        delta: null,
        elapsedMs: 1_200,
        pending: true,
        failed: false,
        failReason: null,
        command: 'pnpm build',
        terminal: 'building...',
      };
      const { container, rerender } = renderI18n(<ToolRow running row={baseRow} />);
      const details = container.querySelector('details')!;
      expect(details.open).toBe(true);
      expect(details.getAttribute('aria-busy')).toBe('true');

      // 命令跑完自动折叠:先走 140ms WAAPI 退场,再移除 [open]
      rerender(<ToolRow running row={{ ...baseRow, pending: false, elapsedMs: 2_400 }} />);
      expect(details.open).toBe(true);
      expect(details.getAttribute('data-closing')).toBe('true');
      expect(details.getAttribute('aria-busy')).toBeNull();
      expect(waapi.animations).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(FOLD_CLOSE_MS);
      });
      expect(details.open).toBe(false);

      // prefers-reduced-motion: reduce 下不跑 WAAPI,直接同步收起
      stubReducedMotion(true);
      cleanup();
      const shell: ShellData = {
        kind: 'shell',
        id: 'shell-0',
        status: 'running',
        items: [{ ...baseRow, pending: false }],
        segments: [],
        thinking: false,
        stopped: false,
        elapsedMs: 3_000,
        quietMs: null,
      };
      const view = renderI18n(<ExecutionShell shell={shell} concluded={false} />);
      const shellDetails = view.container.querySelector('details')!;
      expect(shellDetails.open).toBe(true);

      const beforeCount = waapi.animations.length;
      view.rerender(<ExecutionShell shell={shell} concluded />);
      expect(waapi.animations).toHaveLength(beforeCount);
      expect(shellDetails.open).toBe(false);
    } finally {
      waapi.restore();
    }
  });

  it('renders clean domain link rows inside expandable WebSearch ToolRow with zero external favicon images', () => {
    const searchRow: ToolRowData = {
      kind: 'tool',
      id: 'ws-1',
      tool: 'search',
      name: 'WebSearch',
      title: 'WebSearch',
      rawTitle: false,
      file: null,
      pattern: 'web animations api',
      hits: 2,
      delta: null,
      elapsedMs: 620,
      pending: false,
      failed: false,
      failReason: null,
      command: null,
      input: { query: 'web animations api' },
      terminal: [
        '- [Using the Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API/Using_the_Web_Animations_API)',
        '- [W3C Web Animations Spec](https://www.w3.org/TR/web-animations-1/)',
      ].join('\n'),
    };
    const { container } = renderI18n(<ToolRow row={searchRow} deferBody={false} />);
    const details = container.querySelector('details');
    expect(details, '带来源链接的 WebSearch 行可展开').not.toBeNull();
    fireEvent.click(details!.querySelector('summary')!);

    const linksBox = screen.getByTestId('chat-tool-detail-links');
    const anchors = [...linksBox.querySelectorAll('a')];
    expect(anchors).toHaveLength(2);
    expect(anchors[0]?.textContent).toContain('Using the Web Animations API');
    expect(anchors[0]?.textContent).toContain('developer.mozilla.org');
    expect(anchors[1]?.textContent).toContain('w3.org');
    // 绝不拉取第三方 favicon 图片,且保留原始输出
    expect(linksBox.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByTestId('chat-tool-detail-output').textContent).toContain('W3C Web Animations Spec');
  });
});

/* ── 2. SayText 壳内流式逐字化开 vs 静态落定 ─────────────────────────────── */

describe('SayText live streaming reveal vs settled render', () => {
  it('streams segments via useCharReveal when live is active and settles cleanly when false', () => {
    const { container, rerender } = rtlRender(<SayText text="正在检查" live />);
    expect(container.querySelectorAll('.rv')).toHaveLength(0);

    rerender(<SayText text="正在检查布局与配色令牌。" live />);
    expect(container.textContent).toBe('正在检查布局与配色令牌。');
    expect(container.querySelectorAll('.rv').length).toBeGreaterThan(0);

    // 切回非流式落定态:立即收回 `.rv` span
    rerender(<SayText text="正在检查布局与配色令牌。" live={false} />);
    expect(container.querySelectorAll('.rv')).toHaveLength(0);
    expect(container.textContent).toBe('正在检查布局与配色令牌。');
  });

  it('renders non-streaming SayText with zero .rv spans', () => {
    const { container } = rtlRender(<SayText text="已读取现有组件结构。" />);
    expect(container.textContent).toBe('已读取现有组件结构。');
    expect(container.querySelectorAll('.rv')).toHaveLength(0);
  });
});

/* ── 3. 单包直播 SSE ProseBlock 首次挂载化开 vs 历史重挂 0 `.rv` ────────────── */

describe('Single-chunk live SSE ProseBlock mount reveal vs historical instant settle', () => {
  function assistantMsg(content: string, runStatus: ChatMessage['runStatus'] = 'succeeded'): ChatMessage {
    return {
      id: 'm-agy-1',
      role: 'assistant',
      content,
      runStatus,
      events: content ? [{ kind: 'text', text: content }] : [],
    } as ChatMessage;
  }

  it('triggers planReveal when a single-chunk live SSE flush mounts ProseBlock in the same onDone batch', () => {
    vi.useFakeTimers();
    let msg = assistantMsg('', 'running');
    const view = renderI18n(
      <AssistantMessage message={msg} streaming isLast />,
    );
    expect(view.container.querySelector('.prose-block')).toBeNull();

    const buffer = createBufferedTextUpdates({
      updateMessage: (updater) => {
        msg = updater(msg);
      },
      persistSoon: () => {},
    });

    // 模拟 agy 单包输出 + onDone 同一批 flush 且 streaming 立即翻为 false
    const reply = '已完成三处前端动效升级,推理折叠、工具行与流式文本均已对齐参考体验。';
    buffer.appendContent(reply);
    buffer.flush();
    buffer.cancel();
    view.rerender(
      <AssistantMessage
        message={{ ...msg, runStatus: 'succeeded' }}
        streaming={false}
        isLast
      />,
    );

    const prose = view.container.querySelector('.prose-block');
    expect(prose).not.toBeNull();
    expect(prose?.textContent).toBe(reply);
    expect(prose!.querySelectorAll('.rv').length).toBeGreaterThan(0);

    // 后续无关重渲染(如文件列表刷新)不会提前掐断正在播放的单包波次
    view.rerender(
      <AssistantMessage
        message={{ ...msg, runStatus: 'succeeded' }}
        streaming={false}
        isLast
      />,
    );
    expect(prose!.querySelectorAll('.rv').length).toBeGreaterThan(0);

    // 波次预算走完后自动拆除全部 `.rv` span,留下干净文本节点
    act(() => {
      vi.advanceTimersByTime(REVEAL_BUDGET_MS + CHAR_MS + 50);
    });
    expect(prose!.querySelectorAll('.rv')).toHaveLength(0);
    expect(prose?.textContent).toBe(reply);
  });

  it('keeps historical load, page reload, and Settings remount settled with 0 .rv spans', () => {
    const historyReply = '这是一段早已落盘的历史结论,刷新或切页重挂时绝不重播逐字化开。';
    const firstMount = renderI18n(
      <AssistantMessage
        key="view-a"
        message={assistantMsg(historyReply, 'succeeded')}
        streaming={false}
        isLast
      />,
    );
    expect(firstMount.container.querySelector('.prose-block')?.textContent).toBe(historyReply);
    expect(firstMount.container.querySelectorAll('.rv')).toHaveLength(0);

    // 模拟从设置页返回:换 key 强制重挂
    firstMount.rerender(
      <AssistantMessage
        key="view-b"
        message={assistantMsg(historyReply, 'succeeded')}
        streaming={false}
        isLast
      />,
    );
    expect(firstMount.container.querySelector('.prose-block')?.textContent).toBe(historyReply);
    expect(firstMount.container.querySelectorAll('.rv')).toHaveLength(0);

    // 模拟刷新仍在运行中的会话(已过 <od-done>、streaming=true,但非本拍直播 flush)
    cleanup();
    const doneKey = 'a7f3c91ed2b40561';
    const reloadRunning = renderI18n(
      <AssistantMessage
        message={{
          id: 'm-reload-running',
          role: 'assistant',
          content: `<od-done key="${doneKey}"/>${historyReply}`,
          runStatus: 'running',
          events: [
            { kind: 'done_key', key: doneKey },
            { kind: 'text', text: `<od-done key="${doneKey}"/>${historyReply}` },
          ],
        } as ChatMessage}
        streaming
        isLast
      />,
    );
    expect(reloadRunning.container.querySelector('.prose-block')?.textContent).toBe(historyReply);
    expect(reloadRunning.container.querySelectorAll('.rv')).toHaveLength(0);
  });
});

/* ── 4. useThinkingFollow ~140ms 阻尼滑移跟随 + ExecutionShell 活动视口遮罩 ──── */

describe('useThinkingFollow smooth WAAPI glide and live ExecutionShell masked viewport', () => {
  it('glides smoothly via ~140ms WAAPI translateY on content growth and cancels immediately on upward escape', () => {
    const waapi = installMockWaapi();
    const roCallbacks: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { roCallbacks.push(cb); }
      observe(): void {}
      disconnect(): void {}
    });

    try {
      const geom = { scrollHeight: 160, clientHeight: 96 };
      function StreamBox(): ReactElement {
        const ref = useRef<HTMLDivElement>(null);
        useThinkingFollow(ref, true);
        return (
          <details open>
            <summary>思考中</summary>
            <div ref={ref} data-testid="think-box">
              <div data-testid="think-inner">推理内容</div>
            </div>
          </details>
        );
      }

      renderI18n(<StreamBox />);
      const box = screen.getByTestId('think-box');
      Object.defineProperty(box, 'scrollHeight', { get: () => geom.scrollHeight, configurable: true });
      Object.defineProperty(box, 'clientHeight', { get: () => geom.clientHeight, configurable: true });

      // 初次对齐到底部
      box.scrollTop = 64;
      for (const cb of roCallbacks) cb();
      waapi.animations.length = 0;

      // 新一段 thinking_delta 让内容长高 28px:scrollTop 同步到底,内容层启动 ~140ms 阻尼滑移
      geom.scrollHeight = 188;
      for (const cb of roCallbacks) cb();
      expect(box.scrollTop).toBe(92);
      expect(waapi.animations).toHaveLength(1);
      expect(waapi.animations[0]?.target).toBe(screen.getByTestId('think-inner'));
      expect(waapi.animations[0]?.keyframes).toEqual([
        { transform: 'translateY(28px)' },
        { transform: 'translateY(0px)' },
      ]);
      expect(waapi.animations[0]?.options).toMatchObject({
        duration: 140,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      });

      // 用户向上滚动翻阅:在途滑移动画立即取消,且后续内容增长不再抢滚动条
      box.scrollTop = 30;
      fireEvent.scroll(box);
      expect(waapi.animations[0]?.canceled).toBe(true);

      geom.scrollHeight = 240;
      for (const cb of roCallbacks) cb();
      expect(box.scrollTop).toBe(30);
      expect(waapi.animations).toHaveLength(1);
    } finally {
      waapi.restore();
    }
  });

  it('caps live ExecutionShell viewport with overflow fade attribute, glides prior rows, settled vs live contrast, and removes cap on completion', () => {
    const waapi = installMockWaapi();
    const roCallbacks: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { roCallbacks.push(cb); }
      observe(): void {}
      disconnect(): void {}
    });

    try {
      const makeRow = (i: number, pending: boolean): ToolRowData => ({
        kind: 'tool',
        id: `py-${i}`,
        tool: 'exec',
        name: 'Bash',
        title: `python3 -c "import step_${i}"`,
        rawTitle: true,
        file: null,
        pattern: null,
        hits: null,
        delta: null,
        elapsedMs: pending ? 300 : 120,
        pending,
        failed: false,
        failReason: null,
        command: `python3 -c "\nimport step_${i}\n"`,
        terminal: null,
      });

      const liveItems = Array.from({ length: 9 }, (_, i) => makeRow(i, i === 8));
      const runningShell: ShellData = {
        kind: 'shell',
        id: 'shell-live',
        status: 'running',
        items: liveItems,
        segments: [],
        thinking: false,
        stopped: false,
        elapsedMs: 80_000,
        quietMs: null,
      };

      const view = renderI18n(<ExecutionShell shell={runningShell} concluded={false} />);
      const outerDetails = view.container.querySelector('details')!;
      const outerBody = outerDetails.querySelector(':scope > div') as HTMLDivElement;
      expect(outerBody.className).toMatch(/liveViewport/);

      // 前 8 行已完成挂 settled,第 9 行在途挂 live + entrance
      const rowDetails = [...outerBody.querySelectorAll(':scope > details')];
      expect(rowDetails).toHaveLength(9);
      expect(rowDetails[0]?.className).toMatch(/settled/);
      expect(rowDetails[0]?.className).not.toMatch(/live/);
      expect(rowDetails[8]?.className).toMatch(/live/);
      expect(rowDetails[8]?.className).toMatch(/entrance/);

      const geom = { scrollHeight: 112, clientHeight: 176 };
      Object.defineProperty(outerBody, 'scrollHeight', { get: () => geom.scrollHeight, configurable: true });
      Object.defineProperty(outerBody, 'clientHeight', { get: () => geom.clientHeight, configurable: true });
      outerBody.scrollTop = 0;
      for (const cb of roCallbacks) cb();
      // 短列表(未超出 176px 视口):不挂任何遮罩属性,首尾行 100% 清晰直出
      expect(outerBody.getAttribute('data-mask-top')).toBeNull();
      expect(outerBody.getAttribute('data-mask-bottom')).toBeNull();

      // 溢出且自动贴底跟随:挂 data-mask-top="true",不挂 data-mask-bottom
      geom.scrollHeight = 280;
      for (const cb of roCallbacks) cb();
      expect(outerBody.scrollTop).toBe(104);
      expect(outerBody.getAttribute('data-mask-top')).toBe('true');
      expect(outerBody.getAttribute('data-mask-bottom')).toBeNull();
      waapi.animations.length = 0;

      // 第 10 行进入:自动贴底 + 对前序可见行做 ~140ms 向上滑移(不碰新行的 entrance)
      const nextItems = [
        ...Array.from({ length: 9 }, (_, i) => makeRow(i, false)),
        makeRow(9, true),
      ];
      geom.scrollHeight = 312;
      view.rerender(<ExecutionShell shell={{ ...runningShell, items: nextItems }} concluded={false} />);
      for (const cb of roCallbacks) cb();
      expect(outerBody.scrollTop).toBe(136);
      expect(waapi.animations.length).toBeGreaterThan(0);
      expect(outerBody.getAttribute('data-mask-top')).toBe('true');
      expect(outerBody.getAttribute('data-mask-bottom')).toBeNull();

      // 用户上滚到中间段(0 < scrollTop < max):上下两端同时开启半透遮罩
      outerBody.scrollTop = 52;
      fireEvent.scroll(outerBody);
      expect(outerBody.getAttribute('data-mask-top')).toBe('true');
      expect(outerBody.getAttribute('data-mask-bottom')).toBe('true');

      // 用户滚回最顶部(scrollTop === 0):顶部清晰直出,仅底部保留半透遮罩
      outerBody.scrollTop = 0;
      fireEvent.scroll(outerBody);
      expect(outerBody.getAttribute('data-mask-top')).toBeNull();
      expect(outerBody.getAttribute('data-mask-bottom')).toBe('true');

      // 回合结束并由用户手动展开查看历史:移除 liveViewport 限高与全部遮罩属性
      const doneShell: ShellData = {
        ...runningShell,
        status: 'done',
        items: nextItems.map((r) => ({ ...r, pending: false })),
      };
      view.rerender(<ExecutionShell shell={doneShell} concluded />);
      fireEvent.click(outerDetails.querySelector(':scope > summary')!);
      const settledBody = outerDetails.querySelector(':scope > div') as HTMLDivElement;
      expect(settledBody.className).not.toMatch(/liveViewport/);
      expect(settledBody.getAttribute('data-mask-top')).toBeNull();
      expect(settledBody.getAttribute('data-mask-bottom')).toBeNull();
    } finally {
      waapi.restore();
    }
  });

  it('enforces zero ExecutionShell header divider, hidden horizontal/vertical scrollbars, and multi-stop mask rules', () => {
    const recordCss = readFileSync(
      resolve(__dirname, '../../../src/components/chat/primitives/record.module.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const shellCss = readFileSync(
      resolve(__dirname, '../../../src/components/chat/ExecutionShell.module.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');

    // 1. 壳头「进行中」下方零分割横线
    const flatBodyRule = /\.fold\.flat\[open\]\s*>\s*summary\s*\+\s*\.body\.stack\s*\{([^}]*)\}/.exec(recordCss);
    expect(flatBodyRule).not.toBeNull();
    expect(flatBodyRule?.[1]).toMatch(/border-top:\s*0\b/);
    expect(flatBodyRule?.[1]).not.toMatch(/solid/);

    // 2. 活动视口禁止横向溢出与横纵向拖拽滚动条,并吸收 -7px 行出血
    const viewportRule = /(?:\.liveViewport)+\s*\{([^}]*)\}/.exec(shellCss);
    expect(viewportRule).not.toBeNull();
    expect(viewportRule?.[1]).toMatch(/max-height:\s*176px/);
    expect(viewportRule?.[1]).toMatch(/margin-inline:\s*-7px/);
    expect(viewportRule?.[1]).toMatch(/padding-inline:\s*7px/);
    expect(viewportRule?.[1]).toMatch(/overflow-x:\s*hidden/);
    expect(viewportRule?.[1]).toMatch(/scrollbar-width:\s*none/);

    const scrollbarRule = /\.liveViewport::-webkit-scrollbar\s*\{([^}]*)\}/.exec(shellCss);
    expect(scrollbarRule).not.toBeNull();
    expect(scrollbarRule?.[1]).toMatch(/display:\s*none/);
    expect(scrollbarRule?.[1]).toMatch(/height:\s*0/);

    // 3. 三档边缘感知多段半透遮罩同时声明 -webkit-mask-image 与 mask-image
    expect(shellCss).toMatch(/(?:\.liveViewport)+\[data-mask-top='true'\]:not\(\[data-mask-bottom='true'\]\)\s*\{[^}]*-webkit-mask-image:/);
    expect(shellCss).toMatch(/(?:\.liveViewport)+\[data-mask-top='true'\]\[data-mask-bottom='true'\]\s*\{[^}]*mask-image:/);
    expect(shellCss).toMatch(/(?:\.liveViewport)+\[data-mask-bottom='true'\]:not\(\[data-mask-top='true'\]\)\s*\{[^}]*mask-image:/);
  });

  it('triggers SayText .rv reveal on single-chunk live flush even when next tool_use lands in the same batch', () => {
    vi.useFakeTimers();
    let msg: ChatMessage = {
      id: 'm-agy-say',
      role: 'assistant',
      content: '',
      runStatus: 'running',
      events: [],
    } as ChatMessage;
    const buffer = createBufferedTextUpdates({
      updateMessage: (updater) => {
        msg = updater(msg);
      },
      persistSoon: () => {},
    });

    // 模拟 Antigravity 连续推一条壳内叙述 + 紧接着一条 tool_use(同一帧落地,SayText 首帧 live=false)
    buffer.appendEvent({ kind: 'text', text: '正在逐张比对第 15 号与第 16 号背景图裁切参数。' });
    buffer.appendEvent({
      kind: 'tool_use',
      id: 'tu-py-1',
      name: 'Bash',
      input: { command: 'python3 -c "\nimport os\nprint(15)\n"' },
    });
    buffer.flush();
    buffer.cancel();

    const view = renderI18n(<AssistantMessage message={msg} streaming isLast />);
    expect(view.container.querySelectorAll('.rv').length).toBeGreaterThan(0);
    expect(view.container.textContent).toContain('python3 -c "import os print(15)"');

    act(() => {
      vi.advanceTimersByTime(REVEAL_BUDGET_MS + CHAR_MS + 50);
    });
    expect(view.container.querySelectorAll('.rv')).toHaveLength(0);
  });
});
