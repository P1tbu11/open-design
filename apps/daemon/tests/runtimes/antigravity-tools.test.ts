/**
 * Antigravity (`agy`) 的工具调用:**入参归一 + 在途行 + 失败判定**。
 *
 * 修之前,界面上一个 antigravity 的工具调用只有一行裸工具名(`run_command` /
 * `read_file`)加一个耗时:命令、文件、输出全都看不见。原因是 `agy` 的
 * `tool_info.parameters` 是 **PascalCase**(`CommandLine` / `Path` / `TargetFile` /
  `CodeContent`),而 OD 前端整条管线读的是小写规范键 —— 于是每一次调用都落到
 * `ToolKind: 'other'`,`toolTitle` 只剩工具名。
 *
 * 这里的帧形状**逐字来自真机**:
 *  · `prodcheck` 命名空间 run `3c91eb42` 的 `events.jsonl`(`run_command` +
 *    `Command exited with code N` 信封)
 *  · agy 自己的 `describeToolCall`(二进制里的 `args.Path || args.AbsolutePath ||
 *    args.TargetFile`)
 *  · agy 二进制里的工具 schema(`json:"CodeContent"`、`jsonschema:"required"
 *    jsonschema_description:"Path to file to view. Must be an absolute path."`)
 *
 * 刻意**不**用 `docs-success` 那个夹具来测归一:它只覆盖 `run_command` 一种形状,
 * 而「裸名字」的根因在其它工具上一样成立。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  antigravityCommandFailed,
  normalizeAntigravityToolParameters,
} from '../../src/runtimes/antigravity-tools.js';
import { createJsonEventStreamHandler } from '../../src/runtimes/json-event-stream.js';

type JsonStreamEvent = Record<string, unknown>;

function collectEvents() {
  const events: JsonStreamEvent[] = [];
  const handler = createJsonEventStreamHandler('antigravity', (event) => events.push(event));
  return { events, handler };
}

function stepFrame(step: Record<string, unknown>): string {
  return `${JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: 'c-1', ...step },
  })}\n`;
}

function toolStep(over: Record<string, unknown> = {}): string {
  return stepFrame({
    step_index: 4,
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: {
      name: 'run_command',
      parameters: { CommandLine: 'ls -la && ls -la assets' },
      output: 'total 0\r\n',
    },
    ...over,
  });
}

/* ── 归一:agy 的 PascalCase → 前端认的规范键 ───────────────────────────── */

test('run_command 的 CommandLine 变成 command,toolSummary 变成 description', () => {
  assert.deepEqual(
    normalizeAntigravityToolParameters('run_command', {
      CommandLine: 'ls -la && ls -la assets/shop-bg',
      WaitMsBeforeAsync: 5000,
      toolSummary: 'Check workspace files',
    }),
    {
      description: 'Check workspace files',
      command: 'ls -la && ls -la assets/shop-bg',
      od_tool_args: {
        CommandLine: 'ls -la && ls -la assets/shop-bg',
        WaitMsBeforeAsync: 5000,
        toolSummary: 'Check workspace files',
      },
    },
  );
});

test('文件工具的路径优先级与 agy 自己的 describeToolCall 一致', () => {
  // `args.Path || args.AbsolutePath || args.TargetFile`,逐字照抄
  assert.equal(
    (normalizeAntigravityToolParameters('read_file', { Path: '/p/a.md' }) as Record<string, unknown>).file_path,
    '/p/a.md',
  );
  assert.equal(
    (normalizeAntigravityToolParameters('view_file', { AbsolutePath: '/p/b.md' }) as Record<string, unknown>).file_path,
    '/p/b.md',
  );
  assert.equal(
    (normalizeAntigravityToolParameters('write_to_file', { TargetFile: '/p/c.html' }) as Record<string, unknown>).file_path,
    '/p/c.html',
  );
  // Path 赢过 TargetFile —— 同一个优先级列表,不是按出现顺序
  assert.equal(
    (normalizeAntigravityToolParameters('write_to_file', {
      Path: '/p/from-path.html',
      TargetFile: '/p/from-target.html',
    }) as Record<string, unknown>).file_path,
    '/p/from-path.html',
  );
});

test('写文件带上 content,diffStat 才数得出 +N', () => {
  const input = normalizeAntigravityToolParameters('write_to_file', {
    TargetFile: '/p/index.html',
    CodeContent: '<h1>a</h1>\n<h2>b</h2>',
    Overwrite: true,
  });
  assert.equal(input!.content, '<h1>a</h1>\n<h2>b</h2>');
  // 原始参数一个字段都不许丢 —— 展开面板要给人看 agent 真正发了什么
  assert.deepEqual(input!.od_tool_args, {
    TargetFile: '/p/index.html',
    CodeContent: '<h1>a</h1>\n<h2>b</h2>',
    Overwrite: true,
  });
});

test('读文件的行区间:StartLine / EndLine → offset / limit', () => {
  assert.deepEqual(
    normalizeAntigravityToolParameters('read_file', { Path: '/p/a.md', StartLine: 11, EndLine: 20 }),
    {
      file_path: '/p/a.md',
      offset: 11,
      limit: 10,
      od_tool_args: { Path: '/p/a.md', StartLine: 11, EndLine: 20 },
    },
  );
});

test('搜索:Query 是模式(搜索行要显示「搜索 <模式>」)', () => {
  const input = normalizeAntigravityToolParameters('grep_search', {
    Query: 'useThinkingFollow',
    SearchPath: '/p/src',
  });
  assert.equal(input!.query, 'useThinkingFollow');
  assert.equal(input!.path, '/p/src');
});

test('认不出来的工具也带 od_tool_args —— 裸名字那一档至少能展开看参数', () => {
  assert.deepEqual(
    normalizeAntigravityToolParameters('manage_task', { action: 'kill', id: 't-1' }),
    { od_tool_args: { action: 'kill', id: 't-1' } },
  );
});

test('没有 parameters 时返回 null,不凭空造一个空对象', () => {
  assert.equal(normalizeAntigravityToolParameters('run_command', null), null);
  assert.equal(normalizeAntigravityToolParameters('run_command', 'not-an-object'), null);
  assert.equal(normalizeAntigravityToolParameters('run_command', ['a']), null);
});

/* ── 退出码信封:命令自己失败,agy 却认为这一步跑完了 ─────────────────── */

test('`Command exited with code N` 是命令失败的唯一证人', () => {
  const envelope = (code: number) => [
    'Created At: 2026-11-20T23:41:58+08:00',
    'Completed At: 2026-11-20T23:41:58+08:00',
    `Command exited with code ${code}.`,
    '',
    'Command output:',
    '…',
  ].join('\n');
  assert.equal(antigravityCommandFailed(envelope(0)), false);
  assert.equal(antigravityCommandFailed(envelope(1)), true);
  assert.equal(antigravityCommandFailed(envelope(127)), true);
  // 没有那行信封 = 不知道,按成功画(不猜)
  assert.equal(antigravityCommandFailed('total 0\r\n'), false);
  // 正文里碰巧出现这句话不算 —— 必须自己独占一行(`echo "Command exited …"` 是输出,不是信封)
  assert.equal(antigravityCommandFailed('echo "Command exited with code 1."'), false);
});

/* ── 整条帧流:一条调用、一行、参数与输出都在 ─────────────────────────── */

test('agy 的 tool 步骤落成规范的 tool_use / tool_result 对', () => {
  const { events, handler } = collectEvents();

  handler.feed(toolStep());
  handler.flush();

  assert.deepEqual(events.filter((event) => event.type !== 'status'), [
    {
      type: 'tool_use',
      id: 'c-1:4',
      name: 'run_command',
      input: {
        command: 'ls -la && ls -la assets',
        od_tool_args: { CommandLine: 'ls -la && ls -la assets' },
      },
    },
    {
      type: 'tool_result',
      toolUseId: 'c-1:4',
      content: 'total 0\r\n',
      isError: false,
    },
  ]);
});

test('还在跑的步骤发 tool_in_flight(不是 tool_use)—— 客户端把它并进同一行', () => {
  const { events, handler } = collectEvents();

  handler.feed(stepFrame({
    step_index: 7,
    state: 'RUNNING',
    step_type: 'tool',
    tool_info: {
      name: 'run_command',
      parameters: { CommandLine: 'npm run build' },
      output: 'vite v5 building…',
    },
  }));

  const inFlight = events.find((event) => event.type === 'tool_in_flight');
  assert.ok(inFlight, '在跑的步骤要有早期形态,否则那一行整段时间不存在');
  assert.equal(inFlight!.id, 'c-1:7');
  assert.equal(inFlight!.name, 'run_command');
  assert.deepEqual((inFlight!.input as Record<string, unknown>).command, 'npm run build');
  assert.equal(inFlight!.output, 'vite v5 building…');
  assert.equal(events.some((event) => event.type === 'tool_use'), false);
});

test('同一步从 RUNNING 翻成 DONE:早形态一次 + 结算对一次,不会多出第三行', () => {
  const { events, handler } = collectEvents();

  handler.feed(stepFrame({
    step_index: 9,
    state: 'RUNNING',
    step_type: 'tool',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 3' } },
  }));
  handler.feed(stepFrame({
    step_index: 9,
    state: 'DONE',
    step_type: 'tool',
    tool_info: {
      name: 'run_command',
      parameters: { CommandLine: 'sleep 3' },
      output: 'Command exited with code 0.',
    },
  }));
  handler.feed(stepFrame({
    step_index: 9,
    state: 'DONE',
    step_type: 'tool',
    tool_info: {
      name: 'run_command',
      parameters: { CommandLine: 'sleep 3' },
      output: 'Command exited with code 0.',
    },
  }));

  assert.equal(events.filter((event) => event.type === 'tool_in_flight').length, 1);
  assert.equal(events.filter((event) => event.type === 'tool_use').length, 1);
  // 重复的终态帧不许再发一条 tool_result
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 1);
});

test('非零退出码让结算的 tool_result 标成失败', () => {
  const { events, handler } = collectEvents();

  handler.feed(toolStep({
    tool_info: {
      name: 'run_command',
      parameters: { CommandLine: 'cd /nope' },
      output: 'Command exited with code 2.\n\nCommand output:\ncd: no such file',
    },
  }));
  handler.flush();

  const result = events.find((event) => event.type === 'tool_result');
  assert.equal(result!.isError, true);
});

test('读文件那一行也拿得到文件名(裸 read_file 不再出现)', () => {
  const { events, handler } = collectEvents();

  handler.feed(stepFrame({
    step_index: 2,
    state: 'DONE',
    step_type: 'tool',
    tool_info: {
      name: 'read_file',
      parameters: { Path: '/Users/me/proj/design/brand.md' },
      output: 'Showing lines 1-40 of 40',
    },
  }));
  handler.flush();

  const use = events.find((event) => event.type === 'tool_use');
  assert.equal(use!.name, 'read_file');
  assert.equal((use!.input as Record<string, unknown>).file_path, '/Users/me/proj/design/brand.md');
});
