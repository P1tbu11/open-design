import { describe, expect, it } from 'vitest';
import { extractToolOutputLinks } from '../../../src/runtime/chat/tool-detail';

describe('extractToolOutputLinks', () => {
  it('extracts markdown links with normalized domain and clean title', () => {
    const out = [
      '1. [React 18 Transitions Guide](https://www.react.dev/reference/react/useTransition)',
      '2. [MDN Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API).',
    ].join('\n');

    expect(extractToolOutputLinks(out)).toEqual([
      {
        title: 'React 18 Transitions Guide',
        url: 'https://www.react.dev/reference/react/useTransition',
        domain: 'react.dev',
      },
      {
        title: 'MDN Web Animations API',
        url: 'https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API',
        domain: 'developer.mozilla.org',
      },
    ]);
  });

  it('deduplicates repeated URLs and falls back to bare https URLs when not in markdown', () => {
    const out = [
      '[Docs](https://beui.dev/docs/components/agent-activity)',
      'Duplicate: https://beui.dev/docs/components/agent-activity',
      'Raw source: https://w3c.github.io/csswg-drafts/web-animations-1/).',
    ].join('\n');

    expect(extractToolOutputLinks(out)).toEqual([
      {
        title: 'Docs',
        url: 'https://beui.dev/docs/components/agent-activity',
        domain: 'beui.dev',
      },
      {
        title: 'w3c.github.io/csswg-drafts/web-animations-1',
        url: 'https://w3c.github.io/csswg-drafts/web-animations-1/',
        domain: 'w3c.github.io',
      },
    ]);
  });

  it('ignores non-http protocols and respects the max link cap', () => {
    const many = Array.from(
      { length: 12 },
      (_, idx) => `[Item ${idx}](https://example.com/p/${idx})`,
    ).join('\n');
    const links = extractToolOutputLinks(`javascript:alert(1)\nfile:///etc/hosts\n${many}`, 4);
    expect(links).toHaveLength(4);
    expect(links.map((item) => item.url)).toEqual([
      'https://example.com/p/0',
      'https://example.com/p/1',
      'https://example.com/p/2',
      'https://example.com/p/3',
    ]);
  });
});
