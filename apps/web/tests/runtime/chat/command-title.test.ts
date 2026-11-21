// @vitest-environment node
/**
 * 红测(B30):工具行上的命令要读得出在干什么。
 *
 * 线上量到:`执行 node - <<'NODE'` —— 标题取的是命令的第一行,而 heredoc 的第一行
 * 正好只有「解释器 + 从标准输入读 + 分隔符」,真正在跑的脚本全在后面几行。
 * 用户指认「这个命令没什么可读性呢」。
 */
import { describe, expect, it } from 'vitest';
import { toolTitle } from '../../../src/runtime/chat/tool-kind';

const bash = (command: string) => toolTitle('Bash', { command });

describe('命令标题', () => {
  it('heredoc:不把 `<<\'NODE\'` 这种分隔符摆出来', () => {
    expect(bash("node - <<'NODE'\nconsole.log(1)\nNODE")).toBe('node');
  });

  it('heredoc 写文件:保留真正在做的事', () => {
    expect(bash("cat > page.html <<'EOF'\n<html>\nEOF")).toBe('cat > page.html');
  });

  it('普通命令原样', () => {
    expect(bash('wc -l brand-spec.md transcript.html')).toBe('wc -l brand-spec.md transcript.html');
  });

  it('剥掉 shell 外壳之后再取第一行', () => {
    expect(bash(`/bin/zsh -lc 'ls -la'`)).toBe('ls -la');
  });

  it('agent 自己给了 description 就用它,不去猜命令', () => {
    expect(toolTitle('Bash', { command: "node - <<'X'", description: '生成封面图' })).toBe('生成封面图');
  });

  it('多行内联脚本(python3 -c "\\n..." / node -e):折叠空白保留脚本正文,不截成孤立引号', () => {
    expect(bash('python3 -c "\nimport os\nfrom PIL import Image\nprint(1)\n"'))
      .toBe('python3 -c "import os from PIL import Image print(1)"');
    expect(bash("python3 -c '\n# Scheme 16\nimport sys\nprint(sys.version)\n'"))
      .toBe("python3 -c 'import sys print(sys.version)'");
    expect(bash('node -e "\nconst x = 1;\nconsole.log(x);\n"'))
      .toBe('node -e "const x = 1; console.log(x);"');
  });

  it('反斜杠续行命令拼成单行摘要', () => {
    expect(bash('curl -fsSL \\\n  https://example.com/health')).toBe('curl -fsSL https://example.com/health');
  });
});
