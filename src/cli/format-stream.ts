/**
 * Read claude's `--output-format stream-json` from stdin and print a
 * human-readable line for each event:
 *
 *   [user]      <prompt excerpt>
 *   [assist]    <text excerpt>
 *   [tool]      Read /abs/path
 *   [tool]      Bash: pnpm test
 *   [tool->ok]  read 42 lines
 *   [tool->err] command exited 1
 *   [done]      duration=14.2s, turns=8, cost=$0.04
 *
 * Lossy by design — tee the raw stream alongside if you need full fidelity.
 */
import readline from 'node:readline';

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  is_error?: boolean;
}

const TRUNC = 200;

function trunc(s: string, n = TRUNC): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

function summarizeToolInput(name: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!input) return name ?? 'unknown';
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${name} ${input.file_path ?? ''}`;
    case 'Bash':
      return `Bash: ${trunc(String(input.command ?? ''), 160)}`;
    case 'Grep':
      return `Grep '${input.pattern ?? ''}'${input.path ? ' in ' + input.path : ''}`;
    case 'Glob':
      return `Glob ${input.pattern ?? ''}`;
    case 'WebFetch':
      return `WebFetch ${input.url ?? ''}`;
    case 'TodoWrite':
      return `TodoWrite (${Array.isArray(input.todos) ? input.todos.length : '?'} items)`;
    default:
      return `${name} ${trunc(JSON.stringify(input), 100)}`;
  }
}

function summarizeToolResult(content: unknown, isError: boolean): string {
  let body: string;
  if (typeof content === 'string') body = content;
  else if (Array.isArray(content)) {
    body = content
      .map((c) => (typeof c === 'string' ? c : (c as { text?: string }).text ?? ''))
      .join(' ');
  } else body = JSON.stringify(content);
  const tag = isError ? 'tool->err' : 'tool->ok';
  // Errors get the full body — they're the most diagnostic part of the log.
  // Successes stay truncated to keep the live tail readable.
  if (isError) {
    const flat = body.replace(/\s+/g, ' ').trim();
    return `[${tag}]   ${flat}`;
  }
  return `[${tag}]   ${trunc(body, 160)}`;
}

/**
 * Pure function: turn one input line into zero-or-more output lines.
 * Exported so tests can drive it without a stream.
 */
export function formatLine(line: string): string[] {
  if (!line.trim()) return [];
  let evt: StreamEvent;
  try {
    evt = JSON.parse(line) as StreamEvent;
  } catch {
    return [line];
  }
  switch (evt.type) {
    case 'system':
      return [];
    case 'user': {
      const out: string[] = [];
      for (const c of evt.message?.content ?? []) {
        if (c.type === 'text' && c.text) out.push(`[user]      ${trunc(c.text)}`);
        else if (c.type === 'tool_result') out.push(summarizeToolResult(c.content, !!c.is_error));
      }
      return out;
    }
    case 'assistant': {
      const out: string[] = [];
      for (const c of evt.message?.content ?? []) {
        if (c.type === 'text' && c.text) out.push(`[assist]    ${trunc(c.text)}`);
        else if (c.type === 'tool_use') out.push(`[tool]      ${summarizeToolInput(c.name, c.input)}`);
      }
      return out;
    }
    case 'result': {
      const dur = evt.duration_ms != null ? `${(evt.duration_ms / 1000).toFixed(1)}s` : '?';
      const turns = evt.num_turns ?? '?';
      const cost = evt.total_cost_usd != null ? `$${evt.total_cost_usd.toFixed(4)}` : '?';
      const tag = evt.is_error ? 'failed' : 'done';
      const out = [`[${tag}]      duration=${dur}, turns=${turns}, cost=${cost}`];
      if (evt.result) out.push(`[final]     ${trunc(evt.result, 400)}`);
      return out;
    }
    default:
      // Unknown event type — pass through tagged with `?` so a future schema
      // change is visible rather than silently dropped.
      return [`[?]         ${trunc(line, 200)}`];
  }
}

export async function runFormatStream(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    for (const out of formatLine(line)) process.stdout.write(out + '\n');
  }
}
