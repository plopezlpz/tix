import { describe, expect, it } from 'vitest';
import { formatLine } from './format-stream.js';

const evt = (e: unknown): string => JSON.stringify(e);

describe('formatLine', () => {
  it('drops empty lines silently', () => {
    expect(formatLine('')).toEqual([]);
    expect(formatLine('   ')).toEqual([]);
  });

  it('passes through unparseable lines verbatim', () => {
    expect(formatLine('not json at all')).toEqual(['not json at all']);
  });

  it('skips system init events (noise)', () => {
    expect(formatLine(evt({ type: 'system', subtype: 'init' }))).toEqual([]);
  });
});

describe('user events', () => {
  it('renders user text with [user] prefix', () => {
    const out = formatLine(evt({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hello there' }] },
    }));
    expect(out).toEqual(['[user]      hello there']);
  });

  it('renders successful tool results with [tool->ok] and truncates them', () => {
    const out = formatLine(evt({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', is_error: false, content: 'short result' }],
      },
    }));
    expect(out[0]).toMatch(/^\[tool->ok\]/);
    expect(out[0]).toContain('short result');
  });

  it('does not truncate failed tool results — error bodies are the most diagnostic part of the log', () => {
    const longError = 'x'.repeat(500);
    const out = formatLine(evt({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', is_error: true, content: longError }],
      },
    }));
    expect(out[0]).toMatch(/^\[tool->err\]/);
    expect(out[0]).toContain(longError);
  });
});

describe('assistant events', () => {
  it('renders assistant text with [assist] prefix', () => {
    const out = formatLine(evt({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'thinking through the change' }] },
    }));
    expect(out).toEqual(['[assist]    thinking through the change']);
  });

  it('summarises a Read tool_use as "Read <path>"', () => {
    const out = formatLine(evt({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.md' } }],
      },
    }));
    expect(out).toEqual(['[tool]      Read /a/b.md']);
  });

  it('summarises a Bash tool_use as "Bash: <command>"', () => {
    const out = formatLine(evt({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }],
      },
    }));
    expect(out).toEqual(['[tool]      Bash: pnpm test']);
  });

  it('emits one line per content block when assistant text and tool_use are interleaved', () => {
    const out = formatLine(evt({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'reading the plan' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/.tix/plan.md' } },
        ],
      },
    }));
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('[assist]');
    expect(out[1]).toContain('[tool]');
  });
});

describe('result events', () => {
  it('emits a [done] summary with duration, turns, and cost', () => {
    const out = formatLine(evt({
      type: 'result',
      duration_ms: 14_200,
      num_turns: 3,
      total_cost_usd: 0.04,
      is_error: false,
    }));
    expect(out[0]).toMatch(/^\[done\].*duration=14\.2s.*turns=3.*cost=\$0\.0400/);
  });

  it('emits [failed] when is_error is true', () => {
    const out = formatLine(evt({
      type: 'result',
      duration_ms: 1_000,
      is_error: true,
    }));
    expect(out[0]).toMatch(/^\[failed\]/);
  });

  it('appends a [final] line when result text is present', () => {
    const out = formatLine(evt({
      type: 'result',
      duration_ms: 1_000,
      result: 'plan written, tix done called',
      is_error: false,
    }));
    expect(out).toHaveLength(2);
    expect(out[1]).toMatch(/^\[final\]/);
    expect(out[1]).toContain('plan written');
  });
});

describe('forward compatibility', () => {
  it('passes unknown event types through tagged with [?] so schema bumps stay visible', () => {
    const out = formatLine(evt({ type: 'future_event_type', payload: 'whatever' }));
    expect(out[0]).toMatch(/^\[\?\]/);
    expect(out[0]).toContain('future_event_type');
  });
});
