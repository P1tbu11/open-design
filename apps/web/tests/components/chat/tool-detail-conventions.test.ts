/**
 * 工具调用详情面板的样式**必须跟这一族既有的量法**,不能自己挑数。
 *
 * 这三条都是「同一个屏里两套规矩」的典型形态 —— 单看一条规则都说得通,并排看才发现
 * 一个是 96px 一个是 320px、一个滚在字上另一个不滚、一个靠字号分档另一个靠字重。
 * 用户对这类不一致的反馈是「不如原生细腻」,而不是「这个值不对」,所以只能逐条钉住。
 *
 * 断言的是**规则文本**,不是渲染结果:CSS Module 在 jsdom 里不参与层叠,只挂个类名,
 * 宽度、滚动条、字号一概量不出来。同一副打法见 `record-cascade.test.ts` 与
 * `execution-hierarchy-type.test.tsx`(那个文件开头写了这么做的理由)。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(
  resolve(HERE, '../../../src/components/chat/primitives/record.module.css'),
  'utf-8',
).replace(/\/\*[\s\S]*?\*\//g, '');
const BASE_CSS = readFileSync(resolve(HERE, '../../../src/styles/base.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const TOKENS_CSS = readFileSync(resolve(HERE, '../../../src/styles/tokens.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** 取某条规则的声明块;选择器可以给多个(逗号分隔的那几条都拼在一起看) */
function bodyOfFrom(sheet: string, selector: string): string {
  for (const m of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const one of (m[1] ?? '').split(',')) {
      if (one.split(/\s+/).join(' ').trim() === selector) return m[2] ?? '';
    }
  }
  throw new Error(`找不到规则:${selector}`);
}

function bodyOf(selector: string): string {
  return bodyOfFrom(CSS, selector);
}

/** 声明块里某条属性值(只处理本文件用到的单值形态) */
function declOfFrom(sheet: string, selector: string, prop: string): string | null {
  const body = bodyOfFrom(sheet, selector).replace(/\s+/g, ' ');
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(body);
  return m?.[1]?.trim() ?? null;
}

function declOf(selector: string, prop: string): string | null {
  return declOfFrom(CSS, selector, prop);
}

describe('详情面板:限高走这一屏唯一的那一档', () => {
  it('限高吃 `--chat-window-h`,不是自己挑的像素', () => {
    // 交付稿 1252 行 + 3674 行注释:「96px ≈ 5 行,这一屏里所有『够看但不占屏』
    // 的窗口都是这一档」。
    expect(declOf('.detailText', 'max-height')).toBe('var(--chat-window-h)');
  });

  it('那枚变量在 `.detail` 上声明,值为 96px', () => {
    expect(declOf('.detail', '--chat-window-h')).toBe('96px');
  });

  it('**不许**再出现一个自选的限高数字', () => {
    // 上一版这里是 320px —— 和同屏的 96px 差三倍。
    expect(declOf('.detailText', 'max-height')).not.toMatch(/^\d+px$/);
  });
});

describe('详情面板:滚动条自己一条车道(OPEND-2643,收拢至全局 base.css)', () => {
  it('全局 ::-webkit-scrollbar 给显式 8px 宽度 —— 否则 Chromium 用覆盖式滚动条压住字', () => {
    expect(declOfFrom(BASE_CSS, '::-webkit-scrollbar', 'width')).toBe('var(--scrollbar-size)');
    expect(declOfFrom(TOKENS_CSS, ':root', '--scrollbar-size')).toBe('8px');
  });

  it('scrollbar-gutter: stable —— 内容从「不滚」变「要滚」时正文不横跳', () => {
    expect(declOf('.detailText', 'scrollbar-gutter')).toBe('stable');
  });

  it('拇指靠透明边收窄,和字之间留空', () => {
    expect(bodyOfFrom(BASE_CSS, '::-webkit-scrollbar-thumb')).toMatch(
      /background-clip:\s*padding-box/,
    );
  });

  it('**不许**加未受 @supports 保护的 scrollbar-width / scrollbar-color —— 那会让上面那套整体失效', () => {
    // Chromium 121 起,这两个标准属性一旦给了非 auto 的值,::-webkit-scrollbar 静默失效。
    const body = bodyOf('.detailText').replace(/\s+/g, ' ');
    expect(body).not.toMatch(/scrollbar-width/);
    expect(body).not.toMatch(/scrollbar-color/);
  });
});

describe('详情面板:标签与正文分两档字号', () => {
  it('正文是 13px 那一档,标签是 12px 那一档', () => {
    // 2026-09-02 掉头(104fc5c5dc):整族同色之后主次只由**字号**和字重承担。
    // 两段都用 --chat-t-cap 时层级只剩一个 600 字重,等于把方向退回去了。
    expect(declOf('.detailText', 'font-size')).toBe('var(--chat-t-body)');
    expect(declOf('.detailLabel', 'font-size')).toBe('var(--chat-t-cap)');
  });

  it('两档必须**不同** —— 这一条防的是「两处都写同一个 token」', () => {
    expect(declOf('.detailText', 'font-size')).not.toBe(declOf('.detailLabel', 'font-size'));
  });
});

describe('折叠态摘要:让位顺序是「摘要先归零,标题最后」', () => {
  it('摘要的 flex-shrink 高于标题', () => {
    /*
     * `.fold > summary .name` 是 `flex: 0 1 auto`,`flex-shrink` 默认 1。
     * 摘要也是 0 1 auto 的话,收缩按基础宽度成比例分给两家 —— 长标题被截一半,
     * 可有可无的摘要还占着位置。`flex-shrink` 是**加权**的,抬到 10 才让它先归零。
     */
    expect(declOf('.preview', 'flex-shrink')).toBe('10');
  });

  it('摘要自己也要能收(`min-width: 0` + 省略号),否则加权也不生效', () => {
    expect(declOf('.preview', 'min-width')).toBe('0');
    expect(declOf('.preview', 'text-overflow')).toBe('ellipsis');
    expect(declOf('.preview', 'white-space')).toBe('nowrap');
  });
});
