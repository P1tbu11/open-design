/**
 * Antigravity (`agy`) 的工具入参 → OD 的规范入参形状。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────────
 *
 * `agy` 的 `step_update.tool_info.parameters` 用的是 **PascalCase**(工具 schema 就
 * 长那样,见 agy 自己的 `describeToolCall`: `args.toolSummary` / `args.Path ||
 * args.AbsolutePath || args.TargetFile` / `args.CommandLine`),而 OD 前端整条管线读的
 * 是**小写**规范键:
 *
 *   `tool-kind.ts`   `commandOf` → `command`,`fileOf` → `file_path|filePath|path`,
 *                    `searchPattern` → `pattern|query`,`toolTitle` → `description`
 *   `format.ts`      `diffStat` → `content` / `old_string` + `new_string`
 *
 * 不归一的后果不是「少显示一格」,是**整行退化**:`toolKind('run_command', {CommandLine})`
 * 落到 `other`,`toolTitle` 只剩工具名 —— 界面上就是裸露的 `read_file` / `run_command`
 * 加一个耗时,命令、文件、输出全都看不见。真机语料(`prodcheck` 命名空间,
 * run `3c91eb42`)逐字印证:`input` 是 `{"CommandLine":"ls -la && …"}`。
 *
 * ── 原始参数不丢 ─────────────────────────────────────────────────────
 *
 * 归一之后的键是给**机器**读的;展开面板要给人看的是 agent 真正发了什么。所以原始
 * 对象原样挂在 `od_tool_args` 上(命名沿用仓库既有的 `od_diff_stat` 那一族约定)。
 * 不合并进规范键,否则面板里同一件事会出现两遍。
 *
 * 认不出来的工具**照样**带 `od_tool_args` —— 这正是「裸工具名」那一档能被展开看
 * 参数的原因,和 `tool-kind.ts` 里「认不出来就归 `other`,不谎报」是同一条纪律。
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** agy 自己的 `describeToolCall` 用的就是这一串优先级,照抄以免两边对不上 */
function pathOf(params: JsonRecord): string | null {
  return str(params.Path) ?? str(params.AbsolutePath) ?? str(params.TargetFile);
}

/**
 * 工具名 → 参数别名表。
 *
 * 只收**在 agy 二进制里读到过 schema 的**那几种(`json:"CommandLine" json:"TargetFile"
 * json:"CodeContent" json:"ReplacementChunks" jsonschema:"required"` 等),不按猜测扩张。
 * 认不出的名字仍然会带 `od_tool_args`,所以漏掉一种的代价是「那一行还是裸名 + 可展开」,
 * 不是错报。
 */
export function normalizeAntigravityToolParameters(
  toolName: string,
  parameters: unknown,
): JsonRecord | null {
  if (!isRecord(parameters)) return null;

  const raw = parameters;
  const name = String(toolName ?? '').toLowerCase();
  const out: JsonRecord = {};

  // agy 给这两个字段的说明逐字是「Brief 2-5 word noun phrase」/「one sentence」,
  // 正是 `toolTitle` 认的 `description`。
  const description = str(raw.toolSummary) ?? str(raw.toolAction);
  if (description) out.description = description;

  const path = pathOf(raw);
  if (path) out.file_path = path;

  if (name === 'run_command') {
    const command = str(raw.CommandLine);
    if (command) out.command = command;
  }

  // 写文件:内容进 `content`,`diffStat` 才数得出 `+N`。
  const content = str(raw.CodeContent);
  if (content) out.content = content;

  // 读写行的请求行区间(不是返回区间)。前端 `readRequestRange` 只认这两个名字。
  if (typeof raw.StartLine === 'number') out.offset = raw.StartLine;
  if (typeof raw.EndLine === 'number' && typeof raw.StartLine === 'number') {
    out.limit = raw.EndLine - raw.StartLine + 1;
  }

  // 搜索类:`Query` 是模式本身;`SearchPath` 是搜索根,前端 `fileOf` 认 `path`。
  const query = str(raw.Query);
  if (query) out.query = query;
  const searchPath = str(raw.SearchPath);
  if (searchPath) out.path = searchPath;

  // 目录列举:目标是个目录,不是文件。`fileOf` 会把它当路径读,`other` 行上只影响
  // 摘要,不影响归类。
  const directory = str(raw.DirectoryPath);
  if (directory && !out.path) out.path = directory;

  out.od_tool_args = raw;
  return out;
}

/**
 * 命令结果信封里的退出码判断。
 *
 * `agy` 的 `tool_info.output` 逐字带着(真机语料):
 *
 *   Created At: 2026-11-20T23:41:58+08:00
 *   Completed At: 2026-11-20T23:41:58+08:00
 *   Command exited with code 0.
 *
 *   Command output:
 *   …
 *
 * 只看 `step.state === 'ERROR'` 会漏掉「命令自己退出非零、但这一步在 agy 看来跑完了」
 * 的那一档 —— 那是最常见的失败形状(`cd /nope && …`、`npm run build` 报错)。
 * 信封里那行退出码是**唯一**的证人,所以只认它:没有那一行就按成功画,不猜。
 */
export function antigravityCommandFailed(content: string): boolean {
  const match = /(?:^|\n)\s*Command exited with code (-?\d+)\./.exec(content);
  if (!match) return false;
  const code = Number(match[1]);
  return Number.isFinite(code) && code !== 0;
}
