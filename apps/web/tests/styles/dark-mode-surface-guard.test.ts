// @vitest-environment jsdom
/**
 * Systematic dark-mode surface, token parity, shimmer, and contrast guardrails.
 *
 * Prevents upstream merges or new components from silently reintroducing:
 *  1. Divergence between `[data-theme="dark"]` and `@media (prefers-color-scheme: dark)`;
 *  2. Default dark `--accent` collapsing back to `#353535` (1.00:1 against `--bg-panel`);
 *  3. `background: var(--accent)` rules hardcoding `color: white / #fff` (1.14:1 on `#ededed`);
 *  4. Text shimmer gradients mixing `var(--chat-bg)` / `var(--bg)` into highlight stops
 *     (which sweeps near-black `#121212` across dark-mode text);
 *  5. Hardcoded `#fff` / `#ffffff` slabs on core workspace, chat user-bubble, viewer,
 *     library, and share surfaces whose child text uses dark-aware ink tokens.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import postcss, { type AtRule, type Root, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_DARK_ACCENT_COLOR,
  applyAppearanceToDocument,
} from '../../src/state/appearance';

const WEB_ROOT = resolve('.');
const SRC_ROOT = resolve(WEB_ROOT, 'src');

function readWebFile(relFromWeb: string): string {
  return readFileSync(resolve(WEB_ROOT, relFromWeb), 'utf8');
}

function collectCssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return collectCssFiles(full);
    return extname(entry.name) === '.css' ? [full] : [];
  });
}

function customPropsInSelector(root: Root, selector: string, atRuleMatch?: string): Map<string, string> {
  const props = new Map<string, string>();
  root.walkRules((rule: Rule) => {
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    const parentAt = rule.parent?.type === 'atrule' ? (rule.parent as AtRule) : null;
    if (atRuleMatch) {
      if (!parentAt || !`${parentAt.name} ${parentAt.params}`.includes(atRuleMatch)) return;
    } else if (parentAt) {
      return;
    }
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) {
        props.set(decl.prop, decl.value.trim());
      }
    });
  });
  return props;
}

function ruleDecls(root: Root, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  root.walkRules((rule: Rule) => {
    if (rule.parent?.type === 'atrule') return;
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value.trim();
    });
  });
  return out;
}

describe('1. Global theme token parity (styles/tokens.css & app/layout.tsx)', () => {
  const tokensRoot = postcss.parse(readWebFile('src/styles/tokens.css'));
  const explicitDark = customPropsInSelector(tokensRoot, '[data-theme="dark"]');
  const systemDark = customPropsInSelector(
    tokensRoot,
    'html:not([data-theme])',
    'prefers-color-scheme: dark',
  );

  it('keeps [data-theme="dark"] and @media (prefers-color-scheme: dark) 100% in sync', () => {
    expect([...explicitDark.keys()].sort()).toEqual([...systemDark.keys()].sort());
    for (const [prop, val] of explicitDark.entries()) {
      expect(systemDark.get(prop), `Mismatch on ${prop}`).toBe(val);
    }
  });

  it('defines dark overrides for surface, accent, selection, primary-hover, and project tag tokens', () => {
    expect(explicitDark.get('--bg')).toBe('#121212');
    expect(explicitDark.get('--bg-app')).toBe('#121212');
    expect(explicitDark.get('--bg-panel')).toBe('#353535');
    expect(explicitDark.get('--accent')).toBe('#ededed');
    expect(explicitDark.get('--accent-contrast')).toBe('#202020');
    expect(explicitDark.get('--primary-hover')).toBe('#e4e4e4');
    expect(explicitDark.get('--selected')).toBe('#ededed');
    expect(explicitDark.has('--selected-soft')).toBe(true);
    expect(explicitDark.has('--tag-prototype-ink')).toBe(true);
    expect(explicitDark.has('--tag-live-artifact-ink')).toBe(true);
    expect(explicitDark.has('--tag-web-clone-ink')).toBe(true);
    expect(explicitDark.has('--tag-slide-ink')).toBe(true);
    expect(explicitDark.has('--tag-media-ink')).toBe(true);
  });

  it('resolves default neutral --accent to #ededed in dark mode at runtime and pre-hydration', () => {
    applyAppearanceToDocument({ theme: 'dark' });
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      DEFAULT_DARK_ACCENT_COLOR,
    );
    expect(document.documentElement.style.getPropertyValue('--accent')).not.toBe(
      DEFAULT_ACCENT_COLOR,
    );
    expect(document.documentElement.style.getPropertyValue('--accent-contrast')).toBe('#202020');

    const layoutSource = readWebFile('app/layout.tsx');
    expect(layoutSource).toContain("if(t==='dark'&&a==='#353535')a='#ededed'");
    expect(layoutSource).toContain("'--accent-contrast'");

    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('style');
  });
});

describe('2. Chat seam parity & shimmer highlight safety (ChatRoot.module.css + record.module.css)', () => {
  const chatRoot = postcss.parse(readWebFile('src/components/chat/ChatRoot.module.css'));
  const chatGlobal = postcss.parse(readWebFile('src/styles/chat.css'));
  const lightVars = customPropsInSelector(chatRoot, '.root');
  const explicitDarkVars = customPropsInSelector(chatRoot, ":global([data-theme='dark']) .root");
  const systemDarkChatRootVars = customPropsInSelector(
    chatGlobal,
    'html:not([data-theme]) [data-chat-root]',
    'prefers-color-scheme: dark',
  );

  it('declares identical --chat-* keys across light and [data-theme="dark"], plus system dark fallback for every diverging token', () => {
    expect([...explicitDarkVars.keys()].sort()).toEqual([...lightVars.keys()].sort());
    for (const [prop, darkVal] of explicitDarkVars.entries()) {
      const lightVal = lightVars.get(prop);
      if (darkVal !== lightVal) {
        expect(systemDarkChatRootVars.get(prop), `ChatRoot system dark drift on ${prop}`).toBe(
          darkVal,
        );
      }
    }
  });

  it('keeps --chat-shimmer-gleam bright in dark mode and never mixes --chat-bg into text-clipped shimmers', () => {
    expect(lightVars.get('--chat-shimmer-gleam')).toBe('#ffffff');
    expect(explicitDarkVars.get('--chat-shimmer-gleam')).toBe('#ffffff');
    expect(explicitDarkVars.get('--chat-live-name-base')).toBe('var(--chat-text-muted)');

    const allCss = collectCssFiles(SRC_ROOT);
    const darkSweepViolations: string[] = [];
    for (const file of allCss) {
      const root = postcss.parse(readFileSync(file, 'utf8'));
      root.walkRules((rule) => {
        let clipsText = false;
        let bgValue = '';
        rule.walkDecls((decl) => {
          if (
            (decl.prop === 'background-clip' || decl.prop === '-webkit-background-clip') &&
            decl.value.includes('text')
          ) {
            clipsText = true;
          }
          if (decl.prop === 'background' || decl.prop === 'background-image') {
            bgValue += ` ${decl.value}`;
          }
        });
        if (clipsText && /var\(--(?:chat-)?bg\b/.test(bgValue)) {
          darkSweepViolations.push(`${relative(WEB_ROOT, file)} :: ${rule.selector}`);
        }
      });
    }
    expect(darkSweepViolations).toEqual([]);
  });

  it('restricts chat shimmer gradients strictly to text glyphs (background-clip: text) and never paints full-row box sweeps', () => {
    const chatCssFiles = collectCssFiles(resolve(SRC_ROOT, 'components/chat'));
    const boxSweepViolations: string[] = [];

    for (const file of chatCssFiles) {
      const raw = readFileSync(file, 'utf8');
      expect(raw, `${relative(WEB_ROOT, file)} must not define tool-row-stream box sweep`).not.toContain(
        'tool-row-stream',
      );

      const root = postcss.parse(raw);
      root.walkRules((rule) => {
        // Skip prefers-reduced-motion reset blocks where animation: none is set.
        if (
          rule.parent?.type === 'atrule' &&
          (rule.parent as AtRule).name === 'media' &&
          (rule.parent as AtRule).params.includes('prefers-reduced-motion')
        ) {
          return;
        }

        let hasLinearGradientBg = false;
        let hasSweepAnimation = false;
        let clipsText = false;

        rule.walkDecls((decl) => {
          if (
            (decl.prop === 'background' || decl.prop === 'background-image') &&
            decl.value.includes('linear-gradient')
          ) {
            hasLinearGradientBg = true;
          }
          if (
            (decl.prop === 'animation' || decl.prop === 'animation-name') &&
            decl.value !== 'none'
          ) {
            hasSweepAnimation = true;
          }
          if (
            (decl.prop === 'background-clip' || decl.prop === '-webkit-background-clip') &&
            decl.value.includes('text')
          ) {
            clipsText = true;
          }
        });

        if (hasLinearGradientBg && hasSweepAnimation && !clipsText) {
          boxSweepViolations.push(`${relative(WEB_ROOT, file)} :: ${rule.selector}`);
        }
      });
    }

    expect(boxSweepViolations).toEqual([]);
  });
});

describe('3. Accent surface foreground contrast across all web stylesheets', () => {
  it('never pairs background: var(--accent) with hardcoded white/#fff ink', () => {
    const allCss = collectCssFiles(SRC_ROOT);
    const violations: string[] = [];

    for (const file of allCss) {
      // share-tokens.css is an explicitly documented fixed-light popover token file.
      if (file.endsWith('share-tokens.css')) continue;
      const root = postcss.parse(readFileSync(file, 'utf8'));
      root.walkRules((rule) => {
        let usesAccentFill = false;
        let hardcodedWhiteInk = false;
        rule.walkDecls((decl) => {
          if (
            (decl.prop === 'background' || decl.prop === 'background-color') &&
            /^var\(--accent(?:-(?:hover|strong))?(?:,[^)]+)?\)$/.test(decl.value.trim())
          ) {
            usesAccentFill = true;
          }
          if (
            decl.prop === 'color' &&
            /^(?:white|#fff|#ffffff|rgb\(\s*255[\s,]+255[\s,]+255\s*\))$/i.test(decl.value.trim())
          ) {
            hardcodedWhiteInk = true;
          }
        });
        if (usesAccentFill && hardcodedWhiteInk) {
          violations.push(`${relative(WEB_ROOT, file)} :: ${rule.selector}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});

describe('4. Core workspace, chat user bubble, viewer, library & share dark surfaces', () => {
  it('uses theme-aware var(--bg) on Design Files panels, empty state, and card chrome', () => {
    const routines = postcss.parse(readWebFile('src/styles/viewer/routines.css'));
    expect(ruleDecls(routines, '.app .df-panel').background).toBe('var(--bg)');
    expect(ruleDecls(routines, '.app .df-main').background).toBe('var(--bg)');
    expect(ruleDecls(routines, '.app .df-body').background).toBe('var(--bg)');
    expect(ruleDecls(routines, '.workspace-shell .workspace-tab.is-active').background).toBe(
      'var(--bg-elevated)',
    );

    const designFiles = postcss.parse(readWebFile('src/styles/workspace/design-files.css'));
    expect(ruleDecls(designFiles, '.df-empty')['background-color']).toBe('var(--bg)');
    expect(ruleDecls(designFiles, '.df-card').background).toBe('var(--bg)');

    const buildingStage = postcss.parse(
      readWebFile('src/components/design-files/DesignFilesBuildingState.module.css'),
    );
    expect(ruleDecls(buildingStage, '.stage').background).toBe('var(--bg)');
  });

  it('uses an elevated dark surface and light ink for chat user bubbles in both dark modes', () => {
    const chat = postcss.parse(readWebFile('src/styles/chat.css'));
    const darkUser = customPropsInSelector(chat, '[data-theme="dark"] .msg.user');
    const systemDarkUser = customPropsInSelector(
      chat,
      'html:not([data-theme]) .msg.user',
      'prefers-color-scheme: dark',
    );
    expect(darkUser.get('--chat-user-bubble-ground')).toBe('var(--bg-subtle)');
    expect(darkUser.get('--chat-user-bubble-ink')).toBe('var(--text-strong)');
    expect(systemDarkUser.get('--chat-user-bubble-ground')).toBe('var(--bg-subtle)');
    expect(systemDarkUser.get('--chat-user-bubble-ink')).toBe('var(--text-strong)');
    expect(ruleDecls(chat, '.msg.user .user-text').color).toBe('var(--chat-user-bubble-ink)');
  });

  it('keeps a unified transparent ground across the left chat pane and Electron vibrancy stack in dark mode without extra backing slabs', () => {
    const routines = postcss.parse(readWebFile('src/styles/viewer/routines.css'));
    expect(ruleDecls(routines, '.app .split-chat-slot > .pane').background).toBe('transparent');
    expect(ruleDecls(routines, '.app .chat-log').background).toBe('transparent');
    expect(ruleDecls(routines, '.chat-skin .chat-log').background).toBe('transparent');
    expect(ruleDecls(routines, '.chat-composer-fixed-layer .composer').background).toBe(
      'transparent',
    );
    expect(ruleDecls(routines, '.chat-composer-fixed-layer .composer-shell').background).toBe(
      'var(--chat-floating-card-bg)',
    );
    expect(
      ruleDecls(routines, '.chat-composer-fixed-layer .composer-shell')['border-color'],
    ).toBe('var(--chat-border-soft)');

    // Verify Electron macOS vibrancy & veil pass-through parity in app-wash.css and material.css.
    const appWash = postcss.parse(readWebFile('src/styles/app-wash.css'));
    const washRoot = customPropsInSelector(appWash, ':root');
    const washDark = customPropsInSelector(appWash, "[data-theme='dark']");
    const washSystemDark = customPropsInSelector(
      appWash,
      'html:not([data-theme])',
      'prefers-color-scheme: dark',
    );
    expect(washRoot.get('--veil-shell')).toBe('transparent');
    expect(washRoot.get('--veil-page')).toBe('transparent');
    expect(washRoot.get('--veil-canvas')).toBe('transparent');
    expect(washRoot.get('--veil-panel')).toBe('transparent');
    expect(washDark.get('--wash-base')).toBe('#202020');
    expect(washSystemDark.get('--wash-base')).toBe('#202020');
    expect(
      ruleDecls(appWash, "html:has(.workspace-shell--desktop[data-host-platform='darwin'])")
        .background,
    ).toBe('transparent');
    expect(
      ruleDecls(appWash, "html:has(.workspace-shell--desktop[data-host-platform='darwin']) body")
        .background,
    ).toBe('transparent');

    const material = postcss.parse(readWebFile('src/styles/material.css'));
    const materialDark = customPropsInSelector(material, "[data-theme='dark']");
    const materialSystemDark = customPropsInSelector(
      material,
      'html:not([data-theme])',
      'prefers-color-scheme: dark',
    );
    expect([...materialDark.keys()].sort()).toEqual([...materialSystemDark.keys()].sort());
    for (const [prop, val] of materialDark.entries()) {
      expect(materialSystemDark.get(prop), `material.css dark parity drift on ${prop}`).toBe(val);
    }

    // Scan ALL stylesheets in src/ so no dark-mode rule anywhere can reintroduce a solid/tinted
    // backing plate on any container in the ChatPane / tool-info pass-through hierarchy.
    const slabViolations: string[] = [];
    const forbiddenDarkSlabTargets = [
      '.workspace-shell',
      '.workspace-shell__body',
      '.app',
      '.split',
      '.split-chat-slot',
      '.split-chat-tabs-dock',
      '.split-chat-slot > .pane',
      '.chat-log-wrap',
      '.chat-log-viewport',
      '.chat-log',
      '.chat-composer-slot',
      '.chat-composer-fixed-layer',
      '.chat-composer-fixed-layer .composer',
    ];
    for (const file of collectCssFiles(SRC_ROOT)) {
      const root = postcss.parse(readFileSync(file, 'utf8'));
      root.walkRules((rule) => {
        const inSystemDark =
          rule.parent?.type === 'atrule' &&
          (rule.parent as AtRule).name === 'media' &&
          (rule.parent as AtRule).params.includes('prefers-color-scheme: dark');
        let paintsBackground = false;
        rule.walkDecls((decl) => {
          if (
            (decl.prop === 'background' || decl.prop === 'background-color') &&
            decl.value.trim() !== 'transparent' &&
            decl.value.trim() !== 'none'
          ) {
            paintsBackground = true;
          }
        });
        if (!paintsBackground) return;
        for (const sel of rule.selectors) {
          const trimmed = sel.trim();
          const isDarkSelector =
            trimmed.includes('[data-theme="dark"]') ||
            trimmed.includes("[data-theme='dark']") ||
            (inSystemDark && trimmed.includes('html:not([data-theme])'));
          if (!isDarkSelector) continue;
          if (forbiddenDarkSlabTargets.some((target) => trimmed.endsWith(target))) {
            slabViolations.push(`${relative(WEB_ROOT, file)} :: ${trimmed}`);
          }
        }
      });
    }
    expect(slabViolations).toEqual([]);
  });

  it('keeps dark-mode overrides on toolbar pills, viewer comments, library preview, and design-system rows', () => {
    const shareCss = readWebFile('src/components/share/ShareEntry.module.css');
    expect(shareCss).toContain(':global([data-theme="dark"]) .toolbarSecondary');
    expect(shareCss).toContain(':global(html:not([data-theme])) .toolbarSecondary');

    const viewerCore = readWebFile('src/styles/viewer/core.css');
    expect(viewerCore).toContain('[data-theme="dark"] .viewer-action.viewer-comment-count-trigger');
    expect(viewerCore).toContain('html:not([data-theme]) .viewer-action.viewer-comment-count-trigger');
    expect(viewerCore).toContain('[data-theme="dark"] .comment-side-panel');
    expect(viewerCore).toContain('html:not([data-theme]) .comment-side-panel');

    const libraryPreview = postcss.parse(readWebFile('src/components/LibraryPreviewModal.module.css'));
    expect(ruleDecls(libraryPreview, '.fontStage').background).toBe('var(--bg)');
    expect(ruleDecls(libraryPreview, '.textStage').background).toBe('var(--bg)');

    const dsTab = postcss.parse(readWebFile('src/components/DesignSystemsTab.module.css'));
    expect(ruleDecls(dsTab, '.itemRowActive').background).toBe('var(--bg)');
  });
});
