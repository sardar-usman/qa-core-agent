/**
 * A local stand-in for the Anthropic Messages API, for smokes that spawn the
 * CLI as a child process (ANTHROPIC_BASE_URL points here). No request ever
 * leaves the machine and nothing is billed.
 *
 * Routing: a request with `tools` is the Explorer; a claude-sonnet model is
 * the Critic; anything else is the Planner. Each role answers from its own
 * script, in call order. Every tool_result the Explorer sends back is
 * checked, so a smoke can assert that every tool call its fixture drove
 * returned ok (standing rule 7).
 */
import http from 'node:http';

export type FakeContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> };

export interface FakeAnthropicScript {
  /** Planner answers by call order: the plan text for each plan() call. */
  planner?: string[];
  /** Explorer answers by call order: the content blocks of each response. Past the end, a plain end_turn. */
  explorer?: FakeContent[][];
  /** Critic answers by call order: the response text. */
  critic?: string[];
  /** Hold the Explorer's response with this 1-based call number open forever (a run to interrupt). */
  hangExplorerCall?: number;
  /** Answer every Planner call with this HTTP error (status and Anthropic error body); the SDK's own retries see it too. */
  plannerError?: { status: number; type: string; message: string };
}

export interface FakeAnthropic {
  baseUrl: string;
  calls: { planner: number; explorer: number; critic: number; other: number };
  /** Every tool_result the Explorer sent back with is_error true: tool name order is not known here, so the raw content. */
  toolErrors: string[];
  /** Resolves once the Explorer has sent its n-th request. */
  explorerCall(n: number): Promise<void>;
  close(): Promise<void>;
}

const USAGE = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

export async function startFakeAnthropic(script: FakeAnthropicScript): Promise<FakeAnthropic> {
  const calls = { planner: 0, explorer: 0, critic: 0, other: 0 };
  const toolErrors: string[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const held: http.ServerResponse[] = [];
  let toolId = 0;
  const reply = (res: http.ServerResponse, model: string, content: unknown[], stop: string): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `msg_fake_${Date.now()}`, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: USAGE }));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += String(d); });
    req.on('end', () => {
      let body: { model?: string; tools?: unknown[]; messages?: Array<{ role: string; content: unknown }> };
      try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end('{}'); return; }
      const model = body.model ?? 'unknown';
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        calls.explorer++;
        const n = calls.explorer;
        for (const w of waiters.filter((x) => x.n <= n)) w.resolve();
        // Rule 7: every tool result sent back must be ok.
        const last = body.messages?.[body.messages.length - 1];
        if (last && Array.isArray(last.content)) {
          for (const b of last.content as Array<{ type: string; is_error?: boolean; content?: unknown }>) {
            if (b.type === 'tool_result' && b.is_error) toolErrors.push(String(b.content));
          }
        }
        if (script.hangExplorerCall === n) { held.push(res); return; }
        const blocks = script.explorer?.[n - 1];
        if (!blocks) { reply(res, model, [{ type: 'text', text: 'done' }], 'end_turn'); return; }
        const content = blocks.map((b) => (b.type === 'tool_use' ? { type: 'tool_use', id: `toolu_fake_${++toolId}`, name: b.name, input: b.input } : b));
        reply(res, model, content, blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
        return;
      }
      if (model.startsWith('claude-sonnet')) {
        calls.critic++;
        reply(res, model, [{ type: 'text', text: script.critic?.[calls.critic - 1] ?? '[]\n<summary>no verdicts scripted</summary>' }], 'end_turn');
        return;
      }
      if (model.startsWith('claude-haiku')) {
        calls.planner++;
        if (script.plannerError) {
          res.writeHead(script.plannerError.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: script.plannerError.type, message: script.plannerError.message } }));
          return;
        }
        reply(res, model, [{ type: 'text', text: script.planner?.[calls.planner - 1] ?? '' }], 'end_turn');
        return;
      }
      calls.other++;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `fake server: no route for model ${model}` } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    toolErrors,
    explorerCall: (n) => new Promise<void>((resolve) => {
      if (calls.explorer >= n) resolve();
      else waiters.push({ n, resolve });
    }),
    close: () => new Promise<void>((resolve) => {
      for (const r of held) r.destroy();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
