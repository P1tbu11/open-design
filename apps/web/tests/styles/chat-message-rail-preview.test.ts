import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatCss = readFileSync(new URL('../../src/styles/chat.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
const chatRootCss = readFileSync(
  new URL('../../src/components/chat/ChatRoot.module.css', import.meta.url),
  'utf8',
);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function seamScopeBlock(css: string, selector: string): string {
  const clean = stripComments(css);
  const pattern = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((s) => s.trim());
    if (selectors.includes(selector) && (match[2] ?? '').includes('--chat-')) {
      return match[2] ?? '';
    }
  }
  throw new Error(`Missing seam block for ${selector}`);
}

describe('chat message rail preview card and floating-card dark seam', () => {
  it('right-aligns to the transcript and reads the floating-card seam tokens', () => {
    const previewRule = chatCss.match(/\.chat-message-rail__preview\s*\{([^}]*)\}/)?.[1];
    expect(previewRule).toBeTruthy();
    expect(previewRule).toMatch(/right:\s*16px;/);
    expect(previewRule).toMatch(/background:\s*var\(--chat-floating-card-bg\);/);
    expect(previewRule).toMatch(/color:\s*var\(--chat-floating-card-text\);/);
    expect(previewRule).not.toMatch(/linear-gradient|backdrop-filter/);

    const lightScope = seamScopeBlock(chatRootCss, '.root');
    expect(lightScope).toMatch(/--chat-floating-card-bg:\s*#fff;/);
    expect(lightScope).toMatch(/--chat-floating-card-text:\s*#202020;/);
    expect(lightScope).toMatch(/--chat-plan-current-text:\s*#353535;/);
  });

  it('maps floating-card and plan-current tokens to dark surfaces/inks in [data-theme="dark"]', () => {
    const darkScope = seamScopeBlock(chatRootCss, ":global([data-theme='dark']) .root");
    expect(darkScope).toMatch(/--chat-floating-card-bg:\s*var\(--bg\);/);
    expect(darkScope).toMatch(/--chat-floating-card-text:\s*var\(--text-strong\);/);
    expect(darkScope).toMatch(/--chat-plan-current-text:\s*var\(--text\);/);
    expect(darkScope).not.toMatch(/--chat-floating-card-bg:\s*#(?:fff|ffffff)\b/i);
    expect(darkScope).not.toMatch(/--chat-floating-card-text:\s*#202020\b/i);
    expect(darkScope).not.toMatch(/--chat-plan-current-text:\s*#353535\b/i);

    const cleanTokens = stripComments(tokensCss);
    const darkTokensBlock = cleanTokens.match(/\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(darkTokensBlock).toMatch(/--select-ink:\s*var\(--text-strong\);/);
  });
});
