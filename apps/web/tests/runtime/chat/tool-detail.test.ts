/**
 * 工具调用详情面板的格式化层(纯函数)。
 *
 * 这一层回答的问题只有一个:**把一个 agent 任意形状的入参 / 输出变成能上屏的文字。**
 * 三家 agent 的形状在这里都得过:字符串、对象、数组、嵌套 MCP arguments、PascalCase
 * 的 `agy`,以及整份文件内容那种上万字符的串。
 */
import { describe, expect, it } from 'vitest';
import {
  TOOL_DETAIL_MAX_CHARS,
  TOOL_PREVIEW_MAX_CHARS,
  formatToolInput,
  formatToolValue,
  hasToolInput,
  oneLinePreview,
  toolInputPreview,
  truncateToolText,
} from '../../../src/runtime/chat/tool-detail';

describe('formatToolValue:任何形状都要变出一段文字,且不许抛', () => {
  it('字符串原样', () => {
    expect(formatToolValue('ls -la')).toBe('ls -la');
  });

  it('对象用两空格缩进 —— 参数面板是给人读的,一行 JSON 读不出层级', () => {
    expect(formatToolValue({ Path: '/p/a.md' })).toBe('{\n  "Path": "/p/a.md"\n}');
  });

  it('数组也一样', () => {
    expect(formatToolValue(['a', 'b'])).toBe('[\n  "a",\n  "b"\n]');
  });

  it('标量与空值', () => {
    expect(formatToolValue(0)).toBe('0');
    expect(formatToolValue(false)).toBe('false');
    expect(formatToolValue(null)).toBe('');
    expect(formatToolValue(undefined)).toBe('');
  });

  it('循环引用不许把整行渲染搞崩', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    // `JSON.stringify` 会抛,这一层退回 String()
    expect(() => formatToolValue(cyclic)).not.toThrow();
    expect(formatToolValue(cyclic)).toContain('object');
  });
});

describe('truncateToolText:超长输出必须封顶(防浏览器卡死)', () => {
  it('没超就一个字不动', () => {
    expect(truncateToolText('short')).toEqual({ text: 'short', truncated: false, omittedChars: 0 });
  });

  it('刚好等于上限不算截断', () => {
    const exact = 'x'.repeat(TOOL_DETAIL_MAX_CHARS);
    const out = truncateToolText(exact);
    expect(out.truncated).toBe(false);
    expect(out.text).toHaveLength(TOOL_DETAIL_MAX_CHARS);
  });

  it('超一个字符就截断,并报出切掉多少', () => {
    const long = 'x'.repeat(TOOL_DETAIL_MAX_CHARS + 7);
    const out = truncateToolText(long);
    expect(out.truncated).toBe(true);
    expect(out.text).toHaveLength(TOOL_DETAIL_MAX_CHARS);
    expect(out.omittedChars).toBe(7);
  });

  it('空串', () => {
    expect(truncateToolText('')).toEqual({ text: '', truncated: false, omittedChars: 0 });
  });
});

describe('oneLinePreview:压平空白、按字数收口', () => {
  it('多行压成一行', () => {
    expect(oneLinePreview('ls -la\ncd /p\n  pwd')).toBe('ls -la cd /p pwd');
  });

  it('去掉行内代码记号', () => {
    expect(oneLinePreview('读取 `brand.md`')).toBe('读取 brand.md');
  });

  it('超长截断并补省略号', () => {
    const out = oneLinePreview('a'.repeat(TOOL_PREVIEW_MAX_CHARS + 20))!;
    expect(out.length).toBeLessThanOrEqual(TOOL_PREVIEW_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('全空白给 null,不画一句假的', () => {
    expect(oneLinePreview('   \n  ')).toBeNull();
  });
});

describe('toolInputPreview:挑出最能说明「在干什么」的那个标量', () => {
  it('命令优先', () => {
    expect(toolInputPreview({ command: 'npm run build', file_path: '/p/a' })).toBe('npm run build');
  });

  it('agy 的 PascalCase 也认(那一档的摘要就是命令原文)', () => {
    expect(toolInputPreview({ CommandLine: 'ls -la && ls -la assets' })).toBe('ls -la && ls -la assets');
  });

  it('没有命令就取路径(文件名那一行之外唯一有用的东西)', () => {
    expect(toolInputPreview({ file_path: '/Users/me/proj/brand.md' })).toBe('/Users/me/proj/brand.md');
  });

  it('查询串', () => {
    expect(toolInputPreview({ pattern: 'useThinkingFollow' })).toBe('useThinkingFollow');
  });

  it('只有首行 —— 一条含 heredoc 的命令摘要读第一行就够', () => {
    expect(toolInputPreview({ command: "cat > page.html <<'EOF'\n<html>\nEOF" })).toBe('cat > page.html');
  });

  it('不下探对象/数组:嵌套 arguments 里的第一个串多半是 id,拿它当摘要会误导', () => {
    expect(toolInputPreview({ arguments: { id: 't-1', name: 'x' } })).toBeNull();
  });

  it('什么都没有就是 null', () => {
    expect(toolInputPreview(null)).toBeNull();
    expect(toolInputPreview({})).toBeNull();
    expect(toolInputPreview({ WaitMsBeforeAsync: 5000 })).toBeNull();
  });
});

describe('hasToolInput / formatToolInput:空的不画面板', () => {
  it('空对象、空串、空数组都不算有参数', () => {
    expect(hasToolInput({})).toBe(false);
    expect(hasToolInput('   ')).toBe(false);
    expect(hasToolInput([])).toBe(false);
    expect(hasToolInput(null)).toBe(false);
  });

  it('有内容就算', () => {
    expect(hasToolInput({ a: 1 })).toBe(true);
    expect(hasToolInput('ls')).toBe(true);
  });

  it('有 `od_tool_args` 时只铺原始参数 —— 规范键是同一件事的第二份读法', () => {
    const out = formatToolInput({
      file_path: '/p/brand.md',
      od_tool_args: { Path: '/p/brand.md', StartLine: 11 },
    })!;
    // 面板里只出现一次路径
    expect(out.text.match(/\/p\/brand\.md/g) ?? []).toHaveLength(1);
    expect(out.text).toContain('StartLine');
    // 规范键(那一层是给机器读的)不再重复铺一遍
    expect(out.text).not.toContain('file_path');
  });

  it('没有 `od_tool_args` 时铺入参本身(其它 agent 的规范形状)', () => {
    const out = formatToolInput({ file_path: '/p/a.md' })!;
    expect(out.text).toContain('/p/a.md');
  });

  it('formatToolInput 把超长参数也封顶', () => {
    const out = formatToolInput({ content: 'x'.repeat(TOOL_DETAIL_MAX_CHARS + 100) })!;
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(TOOL_DETAIL_MAX_CHARS);
  });

  it('没有参数时给 null(那一格整段不画)', () => {
    expect(formatToolInput({})).toBeNull();
  });
});
