import { describe, expect, it } from 'vitest';
import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import {
  CODEBUDDY_DEFAULT_MAX_TURNS,
  CODEBUDDY_HEADLESS_INLINE_SETTINGS,
  codebuddyAgentDef,
} from '../../src/runtimes/defs/codebuddy.js';

describe('codebuddy buildArgs', () => {
  it('emits base args with -p, stream-json formats, verbose, and bypassPermissions', () => {
    const args = codebuddyAgentDef.buildArgs('prompt', [], [], {}, {});
    expect(args).toContain('-p');
    expect(args).toContain('--input-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--output-format');
    expect(args).toContain('--verbose');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  });

  it('flags promptViaStdin and never embeds the prompt in argv', () => {
    expect(codebuddyAgentDef.promptViaStdin).toBe(true);
    expect(codebuddyAgentDef.promptInputFormat).toBe('stream-json');

    const longPrompt = 'x'.repeat(200_000);
    const args = codebuddyAgentDef.buildArgs(longPrompt, [], [], {}, {});
    expect(args).not.toContain(longPrompt);
    for (const arg of args) {
      expect(typeof arg === 'string' && arg.length < 1000).toBe(true);
    }
  });

  it('appends --model when a non-default model is selected', () => {
    const args = codebuddyAgentDef.buildArgs('', [], [], { model: 'glm-5.1-ioa' }, {});
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('glm-5.1-ioa');
  });

  it('omits --model when model is default', () => {
    const args = codebuddyAgentDef.buildArgs('', [], [], { model: 'default' }, {});
    expect(args).not.toContain('--model');
  });

  it('appends --effort when reasoning is set', () => {
    const args = codebuddyAgentDef.buildArgs('', [], [], { reasoning: 'high' }, {});
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  it('omits --effort when reasoning is not set', () => {
    const args = codebuddyAgentDef.buildArgs('', [], [], {}, {});
    expect(args).not.toContain('--effort');
  });

  it('omits --effort when reasoning is the synthetic "default" sentinel', () => {
    // The picker fallback `reasoningOptions[0].id` is "default", which must
    // round-trip to "no --effort flag" so Codebuddy uses its own default.
    const args = codebuddyAgentDef.buildArgs('', [], [], { reasoning: 'default' }, {});
    expect(args).not.toContain('--effort');
  });

  it('passes --add-dir for valid extra dirs', () => {
    const args = codebuddyAgentDef.buildArgs('', [], ['/repo/skills', '/repo/design-systems'], {}, {});
    expect(args).toContain('--add-dir');
    const addDirIndex = args.indexOf('--add-dir');
    expect(args[addDirIndex + 1]).toBe('/repo/skills');
    expect(args[addDirIndex + 2]).toBe('/repo/design-systems');
  });

  it('filters empty / null / undefined dirs', () => {
    const args = codebuddyAgentDef.buildArgs('', [], ['', null, '/repo/skills', undefined] as unknown as string[], {}, {});
    const addDirIndex = args.indexOf('--add-dir');
    expect(addDirIndex).toBeGreaterThanOrEqual(0);
    expect(args[addDirIndex + 1]).toBe('/repo/skills');
    expect(args.filter((a) => a === '--add-dir').length).toBe(1);
  });

  it('passes headless --settings overlay and --max-turns budget by default', () => {
    agentCapabilities.delete('codebuddy');
    const args = codebuddyAgentDef.buildArgs('', [], [], {}, {});

    const settingsIndex = args.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(args[settingsIndex + 1]).toBe(CODEBUDDY_HEADLESS_INLINE_SETTINGS);

    const parsed = JSON.parse(args[settingsIndex + 1]!) as {
      hooks: Record<string, unknown[]>;
      memory: { autoMemoryEnabled: boolean };
      enabledPlugins: Record<string, boolean>;
    };
    expect(parsed.hooks.PreToolUse).toEqual([]);
    expect(parsed.hooks.PostToolUse).toEqual([]);
    expect(parsed.hooks.Stop).toEqual([]);
    expect(parsed.memory.autoMemoryEnabled).toBe(false);
    expect(parsed.enabledPlugins['ponytail@ponytail']).toBe(false);

    const maxTurnsIndex = args.indexOf('--max-turns');
    expect(maxTurnsIndex).toBeGreaterThanOrEqual(0);
    expect(args[maxTurnsIndex + 1]).toBe(CODEBUDDY_DEFAULT_MAX_TURNS);
  });

  it('omits --settings and --max-turns when capability probe marks them unsupported', () => {
    agentCapabilities.set('codebuddy', {
      inlineSettings: false,
      maxTurns: false,
    });
    try {
      const args = codebuddyAgentDef.buildArgs('', [], [], {}, {});
      expect(args).not.toContain('--settings');
      expect(args).not.toContain('--max-turns');
    } finally {
      agentCapabilities.delete('codebuddy');
    }
  });
});

describe('codebuddy session resume', () => {
  it('emits --session-id with the minted id on a create turn', () => {
    const args = codebuddyAgentDef.buildArgs('prompt', [], [], {}, {
      newSessionId: '11111111-1111-4111-8111-111111111111',
      resumeSessionId: null,
    });
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(args).not.toContain('--resume');
  });

  it('emits --resume with the stored id on a resume turn', () => {
    const args = codebuddyAgentDef.buildArgs('prompt', [], [], {}, {
      newSessionId: '22222222-2222-4222-8222-222222222222',
      resumeSessionId: 'stored-session-abc',
    });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('stored-session-abc');
    expect(args).not.toContain('--session-id');
  });

  it('emits neither flag when no session context is supplied', () => {
    const args = codebuddyAgentDef.buildArgs('prompt', [], [], {}, {});
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--session-id');
  });

  it('declares it resumes its session via the CLI', () => {
    expect(codebuddyAgentDef.resumesSessionViaCli).toBe(true);
  });
});

describe('codebuddy definition metadata', () => {
  it('has correct id, name, and bin', () => {
    expect(codebuddyAgentDef.id).toBe('codebuddy');
    expect(codebuddyAgentDef.name).toBe('Codebuddy Code');
    expect(codebuddyAgentDef.bin).toBe('codebuddy');
  });

  it('falls back to cbc binary', () => {
    expect(codebuddyAgentDef.fallbackBins).toEqual(['cbc']);
  });

  it('uses claude-stream-json stream format', () => {
    expect(codebuddyAgentDef.streamFormat).toBe('claude-stream-json');
  });

  it('uses claude-mcp-json for external MCP injection', () => {
    expect(codebuddyAgentDef.externalMcpInjection).toBe('claude-mcp-json');
  });

  it('fails closed to the CLI-configured default when live model discovery is unavailable', () => {
    expect(codebuddyAgentDef.fallbackModels).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
    ]);
  });

  it('probes -p subcommand for capability flags', () => {
    expect(codebuddyAgentDef.helpArgs).toEqual(['-p', '--help']);
    expect(codebuddyAgentDef.capabilityFlags).toHaveProperty('--include-partial-messages', 'partialMessages');
    expect(codebuddyAgentDef.capabilityFlags).toHaveProperty('--add-dir', 'addDir');
    expect(codebuddyAgentDef.capabilityFlags).toHaveProperty('--settings', 'inlineSettings');
    expect(codebuddyAgentDef.capabilityFlags).toHaveProperty('--max-turns', 'maxTurns');
    expect(codebuddyAgentDef.defaultModelEnvVar).toBe('OD_CODEBUDDY_DEFAULT_MODEL');
  });

  it('provides install and docs URLs', () => {
    expect(codebuddyAgentDef.installUrl).toBe('https://www.codebuddy.cn');
    expect(codebuddyAgentDef.docsUrl).toBe('https://www.codebuddy.cn/docs/workbuddy/Overview');
  });
});

describe('codebuddy model discovery', () => {
  it('parses the model ids advertised by the installed CLI help', () => {
    const help = `
Options:
  --model <model>  Model for the current session. Please provide the model ID. Currently supported: (hy3, glm-5.2, glm-5.1,
                     glm-5v-turbo, minimax-m3, kimi-k3-1, deepseek-v4-pro)
  --text-to-image-model <model>  Model for text-to-image generation
`;

    expect(codebuddyAgentDef.listModels?.args).toEqual(['--help']);
    expect(codebuddyAgentDef.listModels?.parse(help)).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'hy3', label: 'hy3' },
      { id: 'glm-5.2', label: 'glm-5.2' },
      { id: 'glm-5.1', label: 'glm-5.1' },
      { id: 'glm-5v-turbo', label: 'glm-5v-turbo' },
      { id: 'minimax-m3', label: 'minimax-m3' },
      { id: 'kimi-k3-1', label: 'kimi-k3-1' },
      { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
    ]);
  });

  it('deduplicates advertised model ids while preserving CLI order', () => {
    const help = '--model <model> Currently supported: (hy3, glm-5.2, hy3)';

    expect(codebuddyAgentDef.listModels?.parse(help)?.map((model) => model.id)).toEqual([
      'default',
      'hy3',
      'glm-5.2',
    ]);
  });

  it('returns null when the CLI does not advertise a usable model catalog', () => {
    expect(codebuddyAgentDef.listModels?.parse('--model <model> Model for the session')).toBeNull();
    expect(codebuddyAgentDef.listModels?.parse('--model <model> Currently supported: ()')).toBeNull();
  });
});

describe('codebuddy reasoning round-trip', () => {
  it('declares reasoningOptions so the daemon sanitizer does not drop effort', () => {
    expect(codebuddyAgentDef.reasoningOptions).toBeDefined();
    expect(codebuddyAgentDef.reasoningOptions!.length).toBeGreaterThan(0);
  });

  it('lists all Codebuddy effort levels as reasoningOptions', () => {
    const ids = codebuddyAgentDef.reasoningOptions!.map((o) => o.id);
    // First item is the synthetic "default" sentinel (drives picker
    // fallback to "omit --effort"), followed by the 6 real CLI levels.
    expect(ids).toEqual(['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('puts "default" first so AvatarMenu/SettingsDialog fall back to it', () => {
    const first = codebuddyAgentDef.reasoningOptions![0];
    expect(first).toBeDefined();
    expect(first!.id).toBe('default');
  });

  it('survives sanitization: a valid reasoning option lands in argv', () => {
    // Simulates the daemon sanitizer: only pass reasoning if the value
    // appears in the adapter's declared reasoningOptions.
    const validIds = new Set(codebuddyAgentDef.reasoningOptions!.map((o) => o.id));
    const selected = 'xhigh';
    expect(validIds.has(selected)).toBe(true);

    const args = codebuddyAgentDef.buildArgs('', [], [], { reasoning: selected }, {});
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
  });

  it('drops an undeclared reasoning value (simulating sanitizer)', () => {
    const validIds = new Set(codebuddyAgentDef.reasoningOptions!.map((o) => o.id));
    const invalid = 'ultra';
    expect(validIds.has(invalid)).toBe(false);

    // After sanitizer strips the invalid value, buildArgs receives no reasoning.
    const args = codebuddyAgentDef.buildArgs('', [], [], {}, {});
    expect(args).not.toContain('--effort');
  });

  it('every reasoning option maps correctly: real levels emit --effort, "default" omits it', () => {
    for (const opt of codebuddyAgentDef.reasoningOptions!) {
      const args = codebuddyAgentDef.buildArgs('', [], [], { reasoning: opt.id }, {});
      if (opt.id === 'default') {
        // Synthetic sentinel — must NOT emit --effort.
        expect(args).not.toContain('--effort');
      } else {
        // Real CLI level — must emit --effort <id>.
        expect(args).toContain('--effort');
        expect(args[args.indexOf('--effort') + 1]).toBe(opt.id);
      }
    }
  });
});
