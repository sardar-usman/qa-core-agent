import type { AgentEvent } from '../agent/runtime.js';

/**
 * Trim an AgentEvent for the dashboard's event stream. Only tool payloads
 * are cut (a get_dom result can be tens of kilobytes); every other event,
 * critic_done and its verdicts included, is forwarded as the runtime emitted
 * it. This runs AFTER the runtime parsed the critic's response, so nothing
 * here can affect what parseVerdicts saw.
 */
export function eventForUi(e: AgentEvent): object {
  if (e.type === 'tool_result') {
    const { data, ...rest } = e;
    const preview = data === undefined ? undefined : JSON.stringify(data).slice(0, 200);
    return preview === undefined ? rest : { ...rest, preview };
  }
  if (e.type === 'tool_call') {
    return { ...e, input: JSON.parse(JSON.stringify(e.input ?? null, (_k, v) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 297) + '...' : v))) };
  }
  return e;
}
