/**
 * 工具调用**详情面板**里那两段文字的格式化:入参(Input)与输出(Output)。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────────
 *
 * 各家 agent 的入参和输出形状根本不统一:`agy` 发 PascalCase 对象、opencode 发
 * 字符串、MCP 工具发嵌套 JSON、`manage_task` 发一小撮标量。直接塞进 JSX 的后果是
 * 要么 `[object Object]`,要么一个未转义的对象让 React 抛错,要么整份 JSON 挤成一行
 * 读不了。
 *
 * 所以这里只做三件确定的事:
 *   ① **类型安全地取字符串**:string 原样,对象 / 数组 `JSON.stringify(v, null, 2)`,
 *      取不出来就 `String(v)` —— 任何一档都不会抛;
 *   ② **折叠态的一句话摘要**:从入参里挑出最有信息量的那个标量(命令 / 路径 / 查询),
 *      截成一行。这是「调用时立刻能看出在干什么」的那半格;
 *   ③ **超长截断**:参数 JSON 和工具输出都可能是整份文件或上万行日志。展开面板是
 *      唯一没有别的机制兜底的容器(命令终端那一条有限高 + memo + daemon 侧 16KB
 *      预算,见 `record.module.css` 的 `.term`),所以截断落在这一层。
 *
 * ── 为什么截断只在这里 ────────────────────────────────────────────────
 *
 * 命令输出走的是 `TerminalOutput`(`.term`:`max-height` + 贴底跟随 + 记忆化),
 * 它自己已经是一条有界、可滚动的通道,而且**用户要读的正是末尾** —— 在数据层截掉
 * 尾部的构建日志等于把要读的那一半删了。详情面板没有那一套,内容是一次性铺开的
 * `<pre>` 级文本,所以它必须自己封顶。
 */

import { commandHeadline } from './tool-kind';

/** 详情面板里一段文字的字数上限。超过就截断并给出提示。 */
export const TOOL_DETAIL_MAX_CHARS = 2_000;

/** 折叠态那句话摘要的长度上限(一行截断,和 `commandHeadline` 同一档体感)。 */
export const TOOL_PREVIEW_MAX_CHARS = 96;

/** 摘要在入参里优先读的键 —— 顺序就是「谁更能说明这次调用在干什么」。 */
const PREVIEW_KEYS = ['command', 'cmd', 'CommandLine', 'file_path', 'filePath', 'path', 'Path', 'AbsolutePath', 'TargetFile', 'query', 'Query', 'pattern', 'url', 'prompt'];

/** 这几个键装的是**命令**,摘要要走 `commandHeadline` 那一套剥壳 / 剥 heredoc。 */
const COMMAND_KEYS = new Set(['command', 'cmd', 'CommandLine']);

export interface FormattedToolText {
  text: string;
  /** 是否发生过截断(界面据此追加「输出过长已截断」) */
  truncated: boolean;
  /** 被切掉的字数,只在 `truncated` 为真时有意义 */
  omittedChars: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 任意值 → 给人看的一段文字。**永不抛**。
 *
 * 对象用两空格缩进:参数面板是给人读的,一行 JSON 读不出层级。循环引用会让
 * `JSON.stringify` 抛错,那种情况退回 `String(v)` —— 显示 `[object Object]` 也比
 * 整行渲染崩掉强。
 */
export function formatToolValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value, null, 2);
    return typeof json === 'string' ? json : String(value);
  } catch {
    return String(value);
  }
}

/** 一段文字按字数封顶。切在字符上(`slice`),不切坏代理对之外的任何结构。 */
export function truncateToolText(
  text: string,
  max = TOOL_DETAIL_MAX_CHARS,
): FormattedToolText {
  if (!text) return { text: '', truncated: false, omittedChars: 0 };
  if (text.length <= max) return { text, truncated: false, omittedChars: 0 };
  return { text: text.slice(0, max), truncated: true, omittedChars: text.length - max };
}

/** 一行摘要:压平空白、去掉 markdown 记号,再按字数截断。 */
export function oneLinePreview(text: string, max = TOOL_PREVIEW_MAX_CHARS): string | null {
  const flat = String(text ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function firstLine(value: string): string {
  const line = value.split('\n', 1)[0] ?? '';
  return line.trim();
}

/**
 * 折叠态摘要:从入参里挑一句「这次在干什么」。
 *
 * 只读**标量**。数组和对象一概不下探 —— 一个 MCP 工具的嵌套 arguments 里第一个
 * 字符串多半是 `id` 或 `type`,拿它当摘要比不显示更误导(和 `tool-kind.ts` 里
 * 「认不出来就归 `other`,不谎报」同一条纪律)。
 */
export function toolInputPreview(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === 'string') return oneLinePreview(firstLine(input));
  if (!isRecord(input)) return null;

  for (const key of PREVIEW_KEYS) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    // 命令走 `commandHeadline`:它把 heredoc 的开启标记剥掉(`node - <<'NODE'` →
    // `node`),否则摘要会停在那段最没信息量的分隔符上 —— 和 `toolTitle` 同一条口径,
    // 不另写一份。
    const line = COMMAND_KEYS.has(key) ? commandHeadline(value) : firstLine(value);
    if (line) return oneLinePreview(line);
  }
  return null;
}

/**
 * 入参面板要不要存在。
 *
 * 空对象、空串都没什么可读的 —— 画一个空的面板比不画更糟(多一圈边框,少一个答案)。
 */
export function hasToolInput(input: unknown): boolean {
  if (input == null) return false;
  if (typeof input === 'string') return input.trim().length > 0;
  if (Array.isArray(input)) return input.length > 0;
  if (isRecord(input)) return Object.keys(input).length > 0;
  return true;
}

/**
 * 详情面板的入参文字。
 *
 * `od_tool_args` 在的时候**只显示它** —— 那是 agent 真正发出去的原始参数,而规范键
 * (`command` / `file_path` / `od_tool_args`)是同一件事的第二份读法。两份一起铺,
 * 面板里就是「路径出现两次」,读的人还得先猜哪份是原话。
 *
 * 命令类不走这个面板(它有自己的终端块),所以命令原文不会因为去掉规范键而丢。
 */
export function formatToolInput(input: unknown): FormattedToolText | null {
  if (!hasToolInput(input)) return null;
  const raw = isRecord(input) ? input.od_tool_args : undefined;
  return truncateToolText(formatToolValue(hasToolInput(raw) ? raw : input));
}
