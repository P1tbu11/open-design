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

describe('5. Unified global scrollbar contract (WebKit primary + @supports standard fallback)', () => {
  it('defines transparent-track, low-alpha neutral --scrollbar-* tokens in light, dark, and system-dark', () => {
    const tokens = postcss.parse(readWebFile('src/styles/tokens.css'));
    const rootVars = customPropsInSelector(tokens, ':root');
    const darkVars = customPropsInSelector(tokens, '[data-theme="dark"]');
    const systemDarkVars = customPropsInSelector(
      tokens,
      'html:not([data-theme])',
      'prefers-color-scheme: dark',
    );

    expect(rootVars.get('--scrollbar-size')).toBe('8px');
    expect(rootVars.get('--scrollbar-thumb-inset')).toBe('2px');
    expect(rootVars.get('--scrollbar-track')).toBe('transparent');
    expect(rootVars.get('--scrollbar-thumb')).toMatch(/^rgba\(\s*0,\s*0,\s*0,/);
    expect(rootVars.get('--scrollbar-thumb-hover')).toMatch(/^rgba\(\s*0,\s*0,\s*0,/);
    expect(rootVars.get('--scrollbar-thumb-active')).toMatch(/^rgba\(\s*0,\s*0,\s*0,/);

    for (const vars of [darkVars, systemDarkVars]) {
      expect(vars.get('--scrollbar-track')).toBe('transparent');
      expect(vars.get('--scrollbar-thumb')).toMatch(/^rgba\(\s*255,\s*255,\s*255,/);
      expect(vars.get('--scrollbar-thumb-hover')).toMatch(/^rgba\(\s*255,\s*255,\s*255,/);
      expect(vars.get('--scrollbar-thumb-active')).toMatch(/^rgba\(\s*255,\s*255,\s*255,/);
    }
  });

  it('defines ::-webkit-scrollbar* in base.css (hidden at rest, snappy hover fade-in) and gates standard scrollbar-width/color inside @supports not selector(::-webkit-scrollbar)', () => {
    const base = postcss.parse(readWebFile('src/styles/base.css'));

    let foundScrollbarProperty = false;
    base.walkAtRules('property', (atRule) => {
      if (atRule.params.trim() === '--scrollbar-thumb-bg') {
        const propDecls: Record<string, string> = {};
        atRule.walkDecls((d) => {
          propDecls[d.prop] = d.value.trim();
        });
        expect(propDecls.syntax).toBe("'<color>'");
        expect(propDecls.inherits).toBe('true');
        expect(propDecls['initial-value']).toBe('rgba(0, 0, 0, 0)');
        foundScrollbarProperty = true;
      }
    });
    expect(foundScrollbarProperty).toBe(true);

    expect(ruleDecls(base, ':where(*)')['--scrollbar-thumb-bg']).toBe('rgba(0, 0, 0, 0)');
    expect(ruleDecls(base, ':where(*)')['transition']).toBe('--scrollbar-thumb-bg 100ms linear');
    expect(ruleDecls(base, ':where(*:hover, *:focus-visible)')['--scrollbar-thumb-bg']).toBe(
      'var(--scrollbar-thumb)',
    );
    expect(ruleDecls(base, ':where(*:hover, *:focus-visible)')['transition-duration']).toBe('80ms');

    expect(ruleDecls(base, '::-webkit-scrollbar').width).toBe('var(--scrollbar-size)');
    expect(ruleDecls(base, '::-webkit-scrollbar').height).toBe('var(--scrollbar-size)');
    expect(ruleDecls(base, '::-webkit-scrollbar-track').background).toBe('var(--scrollbar-track)');
    expect(ruleDecls(base, '::-webkit-scrollbar-corner').background).toBe('transparent');
    expect(ruleDecls(base, '::-webkit-scrollbar-thumb')['background-color']).toBe(
      'var(--scrollbar-thumb-bg, transparent)',
    );
    expect(ruleDecls(base, '::-webkit-scrollbar-thumb')['background-clip']).toBe('padding-box');
    expect(ruleDecls(base, '::-webkit-scrollbar-thumb:hover')['background-color']).toBe(
      'var(--scrollbar-thumb-hover)',
    );
    expect(ruleDecls(base, '::-webkit-scrollbar-thumb:active')['background-color']).toBe(
      'var(--scrollbar-thumb-active)',
    );

    let foundSupportsRest = false;
    let foundSupportsHover = false;
    base.walkAtRules('supports', (atRule) => {
      if (atRule.params.replace(/\s+/g, ' ').trim() === 'not selector(::-webkit-scrollbar)') {
        atRule.walkRules((rule) => {
          const decls: Record<string, string> = {};
          rule.walkDecls((d) => {
            decls[d.prop] = d.value.trim();
          });
          if (rule.selector.trim() === '*') {
            expect(decls['scrollbar-width']).toBe('thin');
            expect(decls['scrollbar-color']).toBe('transparent transparent');
            foundSupportsRest = true;
          }
          if (rule.selectors.map((s) => s.trim()).includes('*:hover')) {
            expect(decls['scrollbar-color']).toBe('var(--scrollbar-thumb) var(--scrollbar-track)');
            foundSupportsHover = true;
          }
        });
      }
    });
    expect(foundSupportsRest).toBe(true);
    expect(foundSupportsHover).toBe(true);
  });

  it('forbids stray scrollbar-width/scrollbar-color, bespoke ::-webkit-scrollbar* rules, or unapproved vertical scrollbar suppression across apps/web and packages/components', () => {
    const REPO_ROOT = resolve(WEB_ROOT, '../..');
    const COMPONENTS_SRC = resolve(REPO_ROOT, 'packages/components/src');
    const allUiCssFiles = [...collectCssFiles(SRC_ROOT), ...collectCssFiles(COMPONENTS_SRC)];

    // Only horizontal strips whose `overflow-x: auto` lives in a base selector
    // or vertical scrollports with a dedicated custom rail / masked live
    // auto-follow viewport may suppress native scrollbars.
    const ALLOWED_HIDDEN_SCROLLBAR_SELECTORS = new Set([
      '.app .ws-tabs-bar',
      '.chat-log',
      '.chat-message-rail__track',
      '.liveViewport.liveViewport.liveViewport.liveViewport.liveViewport',
    ]);

    const violations: string[] = [];

    for (const file of allUiCssFiles) {
      const rel = relative(REPO_ROOT, file);
      const root = postcss.parse(readFileSync(file, 'utf8'));
      const isBaseCss = rel === 'apps/web/src/styles/base.css';

      root.walkRules((rule) => {
        const inSupportsWebkitFallback =
          isBaseCss &&
          rule.parent?.type === 'atrule' &&
          (rule.parent as AtRule).name === 'supports' &&
          (rule.parent as AtRule).params.includes('not selector(::-webkit-scrollbar)');

        let hasHorizontalScroll = false;
        let hidesScrollbarWidth = false;

        rule.walkDecls((decl) => {
          if (decl.prop === 'overflow-x' && /^(auto|scroll)$/.test(decl.value.trim())) {
            hasHorizontalScroll = true;
          }
          if (decl.prop === 'scrollbar-color' && !inSupportsWebkitFallback) {
            violations.push(`${rel} :: ${rule.selector} -> scrollbar-color: ${decl.value}`);
          }
          if (decl.prop === 'scrollbar-width') {
            const val = decl.value.trim();
            if (val === 'none') {
              hidesScrollbarWidth = true;
            } else if (!inSupportsWebkitFallback) {
              violations.push(`${rel} :: ${rule.selector} -> scrollbar-width: ${decl.value}`);
            }
          }
        });

        if (
          hidesScrollbarWidth &&
          !hasHorizontalScroll &&
          !rule.selectors.every((s) => ALLOWED_HIDDEN_SCROLLBAR_SELECTORS.has(s.trim()))
        ) {
          violations.push(
            `${rel} :: ${rule.selector} -> vertical scrollbar-width: none without custom rail`,
          );
        }

        if (!isBaseCss && rule.selector.includes('::-webkit-scrollbar')) {
          if (
            rule.selector.includes('::-webkit-scrollbar-thumb') ||
            rule.selector.includes('::-webkit-scrollbar-track') ||
            rule.selector.includes('::-webkit-scrollbar-corner')
          ) {
            violations.push(`${rel} :: ${rule.selector} -> bespoke webkit scrollbar part`);
            return;
          }
          let hidesScrollbar = false;
          rule.walkDecls((decl) => {
            if (decl.prop === 'display' && decl.value.trim() === 'none') {
              hidesScrollbar = true;
            }
          });
          if (!hidesScrollbar) {
            violations.push(
              `${rel} :: ${rule.selector} -> ::-webkit-scrollbar without display: none`,
            );
          }
        }
      });
    }

    expect(violations).toEqual([]);

    const speakerNotesSource = readWebFile('src/runtime/speaker-notes.ts');
    expect(speakerNotesSource).toContain('::-webkit-scrollbar { width: 8px; height: 8px; }');
    expect(speakerNotesSource).toContain('@supports not selector(::-webkit-scrollbar)');
  });
});
