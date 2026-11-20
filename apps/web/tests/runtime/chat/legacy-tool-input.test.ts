/**
 * **已经落库的** antigravity 旧消息,在今天的代码上也要看得懂。
 *
 * ── 为什么这一层不能只修 daemon ──────────────────────────────────────────
 *
 * 修完之后,`agy` 的入参在 **daemon 出口**就被归一成规范键了。但那只管**新流**:
 * 用户手上每一段历史对话里存的还是 agent 当年发的那份原始入参
 * (`{"CommandLine":"ls -la"}`),而聊天面板是从库里读事件、再 `buildTurnBlocks`
 * 落块的。也就是说只修 daemon 的话,今天打开昨天那段对话,那些行**仍然是**
 * 一行裸 `run_command` —— 「前端没生效」里有一半是这个,不是热更新。
 *
 * `normalizeToolInput` 因此在前端也认一遍别名。它是幂等的:新流的入参已经是规范键,
 * 一个别名都认不出来,原样返回同一引用。
 *
 * ── 一条边界的钉子 ─────────────────────────────────────────────────────
 *
 * `ToolRow.input` 存的**必须是原始入参**。它是详情面板那一格的内容,回答「agent
 * 到底发了什么」—— 把它换成归一视图就是替 agent 改口。下面有一条专门钉这件事。
 */
import { describe, expect, it } from 'vitest';
import type { PersistedAgentEvent } from '@open-design/contracts';
import { buildTurnBlocks, normalizeToolInput } from '../../../src/runtime/chat/build-turn-blocks';
import type { ToolRow, TurnBlock } from '../../../src/runtime/chat/contract';

const rowsOf = (events: PersistedAgentEvent[]): ToolRow[] => {
  const blocks = buildTurnBlocks({ events, runStatus: 'succeeded' });
  return blocks.flatMap((b: TurnBlock) =>
    b.kind === 'shell' ? [...b.items, ...b.segments.flatMap((s) => s.items)] : [],
  ).filter((i): i is ToolRow => i.kind === 'tool');
};

/** 旧库里 `agy` 真正存下来的那一行(prodcheck run `3c91eb42` 逐字) */
const legacyCall = (
  input: unknown,
  result = 'Command exited with code 0.\n\nCommand output:\ntotal 0',
): PersistedAgentEvent[] => ([
  { kind: 'tool_use', id: 'x:1', name: 'run_command', input, startedAt: 1_000 },
  { kind: 'tool_result', toolUseId: 'x:1', content: result, isError: false, completedAt: 2_000 },
] as unknown as PersistedAgentEvent[]);

describe('normalizeToolInput:纯函数', () => {
  it('认 agy 的 PascalCase', () => {
    expect(normalizeToolInput({ CommandLine: 'ls -la', toolSummary: 'List' })).toMatchObject({
      command: 'ls -la',
      description: 'List',
    });
  });

  it('路径优先级与 agy 自己的 describeToolCall 一致', () => {
    expect(normalizeToolInput({ TargetFile: '/a.html' })).toMatchObject({ file_path: '/a.html' });
    expect(normalizeToolInput({ AbsolutePath: '/b.md' })).toMatchObject({ file_path: '/b.md' });
    // Path 赢过 TargetFile
    expect(normalizeToolInput({ Path: '/p1', TargetFile: '/p2' })).toMatchObject({ file_path: '/p1' });
  });

  it('规范化键的入参原样返回**同一引用**', () => {
    const input = { command: 'ls' };
    expect(normalizeToolInput(input)).toBe(input);
  });

  it('非对象、数组、null 一律原样', () => {
    expect(normalizeToolInput(null)).toBeNull();
    expect(normalizeToolInput('cmd')).toBe('cmd');
    const arr = [1, 2];
    expect(normalizeToolInput(arr)).toBe(arr);
  });

  it('不修改原对象', () => {
    const input = { CommandLine: 'ls -la' };
    normalizeToolInput(input);
    expect(input).toEqual({ CommandLine: 'ls -la' });
    expect('command' in input).toBe(false);
  });
});

describe('落块:旧消息里的 antigravity 行不再是裸工具名', () => {
  it('run_command + CommandLine → 认得出在跑什么', () => {
    const [row] = rowsOf(legacyCall({ CommandLine: 'npm run build' }));
    expect(row!.command).toBe('npm run build');
    expect(row!.title).not.toBe('run_command');
  });

  it('read_file + Path → 认得出文件名', () => {
    const [row] = rowsOf([
      { kind: 'tool_use', id: 'x:2', name: 'read_file', input: { Path: '/p/brand.md' }, startedAt: 1_000 },
      { kind: 'tool_result', toolUseId: 'x:2', content: '# Brand', isError: false, completedAt: 2_000 },
    ] as unknown as PersistedAgentEvent[]);
    expect(row!.tool).toBe('read');
    expect(row!.file?.path).toBe('/p/brand.md');
  });

  it('toolSummary 成为那一行的人话标题', () => {
    const [row] = rowsOf(legacyCall({ CommandLine: 'npm run build', toolSummary: 'Package build' }));
    expect(row!.title).toBe('Package build');
  });

  it('write_to_file + CodeContent → 数得出改动量', () => {
    const [row] = rowsOf([
      {
        kind: 'tool_use', id: 'x:3', name: 'write_to_file',
        input: { TargetFile: '/p/a.html', CodeContent: 'a\nb\nc' }, startedAt: 1_000,
      },
      { kind: 'tool_result', toolUseId: 'x:3', content: 'ok', isError: false, completedAt: 2_000 },
    ] as unknown as PersistedAgentEvent[]);
    expect(row!.tool).toBe('write');
    expect(row!.file?.path).toBe('/p/a.html');
    expect(row!.delta).toEqual({ added: 3, removed: 0 });
  });

  /** 边界:分类读归一视图,`input` 那一格仍然是 agent 的原话 */
  it('row.input 保存的是**原始入参**,不是归一视图', () => {
    const [row] = rowsOf(legacyCall({ CommandLine: 'ls -la' }));
    expect(row!.input).toEqual({ CommandLine: 'ls -la' });
    expect((row!.input as Record<string, unknown>).command).toBeUndefined();
  });
});
