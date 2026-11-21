/**
 * 工具调用的详情面板 —— 展开后那两段等宽文字:**参数 / 命令(Input)** 与
 * **执行输出(Output)**。
 *
 * 这是「工具调用是一等公民」里「看得见过程」的那一半。折叠态那一行
 * (`ToolRow` 的 summary)回答「在干什么」,这一层回答「它到底收到了什么、回了什么」。
 *
 * ── 谁在用 ──────────────────────────────────────────────────────
 *
 * `ToolRow` 在所有**不是命令**的可折叠行上用(`read` / `write` / `edit` / `search` /
 * `other` 里认出参数的那些)。命令类不走这里 —— 它们有自己的 `div.code`:
 * 命令原文 + `TerminalOutput`(限高、贴底跟随、`$` / `✗` 记号),那是终端,
 * 不是「参数与返回值」。
 *
 * ── 为什么截断不在这里 ────────────────────────────────────────────
 *
 * 字数上限与「输出过长已截断」的判据都在 `runtime/chat/tool-detail.ts`(纯函数、可
 * 单测)。这一层只负责把算好的结果画出来 —— 组件里做字符串处理的那一半,历来是
 * 这个仓库最容易漏测的地方。
 */
import type { ReactElement } from 'react';
import { useT } from '../../../i18n';
import {
  extractToolOutputLinks,
  formatToolInput,
  formatToolValue,
  truncateToolText,
} from '../../../runtime/chat/tool-detail';
import { STROKE_ICON } from './icons';
import styles from './record.module.css';

export interface ToolDetailProps {
  /** 调用收到的原始入参。没东西可显示时整段不画。 */
  input: unknown;
  /** 调用的输出原文。`undefined` / 空串时整段不画。 */
  output?: string | null;
}

const LinkGlobeIcon = (): ReactElement => (
  <svg {...STROKE_ICON} width="12" height="12">
    <circle cx="12" cy="12" r="9" />
    <path d="M3.6 9h16.8M3.6 15h16.8" />
    <path d="M12 3a14.2 14.2 0 013.8 9 14.2 14.2 0 01-3.8 9 14.2 14.2 0 01-3.8-9A14.2 14.2 0 0112 3z" />
  </svg>
);

export function ToolDetail({ input, output }: ToolDetailProps): ReactElement | null {
  const t = useT();
  const inputText = formatToolInput(input);
  const outputText = output ? truncateToolText(output) : null;
  const links = output ? extractToolOutputLinks(output) : [];
  if (!inputText && !outputText) return null;

  return (
    <div className={styles.detail} data-testid="chat-tool-detail">
      {inputText ? (
        <section className={styles.detailSection} data-testid="chat-tool-detail-input">
          <span className={styles.detailLabel}>{t('chat.record.input')}</span>
          <pre className={styles.detailText}>{inputText.text}</pre>
          {inputText.truncated
            ? <span className={styles.detailMore}>{t('chat.record.truncated')}</span>
            : null}
        </section>
      ) : null}
      {links.length > 0 ? (
        <div className={styles.detailLinks} data-testid="chat-tool-detail-links">
          {links.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.detailLink}
            >
              <span className={styles.detailLinkIcon}><LinkGlobeIcon /></span>
              <span className={styles.detailLinkTitle}>{link.title}</span>
              <span className={styles.detailDomain}>{link.domain}</span>
            </a>
          ))}
        </div>
      ) : null}
      {outputText ? (
        <section className={styles.detailSection} data-testid="chat-tool-detail-output">
          <span className={styles.detailLabel}>{t('chat.record.output')}</span>
          <pre className={styles.detailText}>{outputText.text}</pre>
          {outputText.truncated
            ? <span className={styles.detailMore}>{t('chat.record.truncated')}</span>
            : null}
        </section>
      ) : null}
    </div>
  );
}

/**
 * 详情面板里那段「参数」的纯文字版本,`ToolRow` 拿它判断这一行该不该做成折叠块。
 *
 * 判据和 `ToolDetail` 里同一份:`formatToolInput` 给出 `null` = 没有可读的参数;
 * 再叠上「有没有输出」,两者全无的行就不该长出一枚展不开的箭头
 * (`failed-file-row-expand.test.tsx` 那条「一个展不开的折叠块比单行更糟」)。
 */
export function hasToolDetail(input: unknown, output?: string | null): boolean {
  if (formatToolInput(input)) return true;
  return Boolean(output && formatToolValue(output).trim());
}
