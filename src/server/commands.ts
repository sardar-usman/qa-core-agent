import { stripNpmStyleLeadingDashes, detectPastedCliCommand } from '../agent/parse-hints.js';
import {
  parseExploreTokens, tokenizeCommand, validateEnvOverride, RUN_ENV_SETTINGS,
  type ExploreRequest,
} from '../agent/explore-request.js';

/**
 * Pure parsing of the slash commands the dashboard sends. No I/O, no model
 * call, so the gateway smoke can assert every command shape offline. The
 * gateway resolves a natural-language feature hint (Haiku) and runs the
 * command after this returns.
 */

export const EXPLORE_USAGE =
  'Usage: `/explore <url> [--features login,cart] [--srs <file>] [--urls /a,/b] [--discover] ' +
  '[--lang ts|js] [--no-pom] [--no-stabilize] [--stabilize-attempts N] [--ceiling USD] [or a natural-language hint after the URL]`';
export const RESUME_USAGE = 'Usage: `/resume <path/to/checkpoint.json> [--ceiling USD]`';
export const TRANSCRIBE_USAGE = 'Usage: `/transcribe <path/to/run-report.json> [--out <dir>]`';

export const HELP_TEXT =
  "I didn't recognise that command. I respond to:\n" +
  '  • `/explore <url>` to drive the browser and generate a framework\n' +
  '  • `/resume <checkpoint.json>` to continue a stopped run\n' +
  '  • `/transcribe <run-report.json>` to regenerate a framework without exploring\n' +
  '  • `/generate <story>` to turn a user story into a spec\n' +
  '  • `/heal <spec-path>` to re-resolve broken selectors\n' +
  '  • `/eval` to run the benchmark against 3 public sites';

export type GatewayCommand =
  | { kind: 'explore'; request: ExploreRequest; naturalHint?: string; notes: string[] }
  | { kind: 'transcribe'; reportPath: string; outDir?: string }
  | { kind: 'generate'; story: string }
  | { kind: 'heal'; specPath: string }
  | { kind: 'eval'; pom: boolean }
  | { kind: 'reply'; text: string };

export interface CommandDefaults {
  /** The dashboard's output-language toggle; `--lang` in the text wins. */
  lang: 'ts' | 'js';
  /** Setting overrides from the dashboard's run-settings form. */
  env?: Record<string, string>;
}

export function parseGatewayCommand(content: string, defaults: CommandDefaults): GatewayCommand {
  const text = content.trim();

  const pasteHint = detectPastedCliCommand(text);
  if (pasteHint) {
    return {
      kind: 'reply',
      text:
        'Looks like you pasted a terminal command. In the dashboard, drop the ' +
        '`npm run ... --` prefix and use the slash command directly:\n\n' +
        `  \`${pasteHint.suggestion}\``,
    };
  }

  if (text === '/explore' || text.startsWith('/explore ')) {
    return parseExplore(text.slice('/explore'.length).trim(), defaults);
  }
  if (text === '/resume' || text.startsWith('/resume ')) {
    const rest = text.slice('/resume'.length).trim();
    if (!rest) return { kind: 'reply', text: RESUME_USAGE };
    const tokens = tokenizeCommand(rest);
    // `/resume <cp>` is sugar for `/explore --resume <cp>`.
    if (tokens[0] && !tokens[0].startsWith('--')) tokens.unshift('--resume');
    return parseExplore(tokens.map(quoteIfNeeded).join(' '), defaults);
  }
  if (text === '/transcribe' || text.startsWith('/transcribe ')) {
    const rest = text.slice('/transcribe'.length).trim();
    const tokens = tokenizeCommand(rest);
    let reportPath: string | undefined;
    let outDir: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === '--out') { outDir = tokens[++i]; if (!outDir) return { kind: 'reply', text: '--out expects a directory. ' + TRANSCRIBE_USAGE }; }
      else if (t.startsWith('--')) return { kind: 'reply', text: `Unknown flag ${t}. ${TRANSCRIBE_USAGE}` };
      else if (!reportPath) reportPath = t;
    }
    if (!reportPath) return { kind: 'reply', text: TRANSCRIBE_USAGE };
    return { kind: 'transcribe', reportPath, ...(outDir ? { outDir } : {}) };
  }
  if (text.startsWith('/generate ')) {
    const story = text.slice('/generate '.length).trim();
    if (!story) return { kind: 'reply', text: 'Usage: `/generate <user story>`' };
    return { kind: 'generate', story };
  }
  if (text.startsWith('/heal ')) {
    const specPath = text.slice('/heal '.length).trim();
    if (!specPath) return { kind: 'reply', text: 'Usage: `/heal <spec-path>`' };
    return { kind: 'heal', specPath };
  }
  if (text === '/eval' || text.startsWith('/eval ')) {
    const rest = text.slice('/eval'.length).trim();
    return { kind: 'eval', pom: !/(^|\s)--no-pom(\s|$)/.test(rest) };
  }
  return { kind: 'reply', text: HELP_TEXT };
}

function quoteIfNeeded(t: string): string {
  return /\s/.test(t) ? `"${t}"` : t;
}

function parseExplore(rest: string, defaults: CommandDefaults): GatewayCommand {
  if (!rest) return { kind: 'reply', text: EXPLORE_USAGE };
  const notes: string[] = [];
  // Users carry `-- <url>` over from npm syntax; strip it when a URL follows.
  const dashFix = stripNpmStyleLeadingDashes(rest);
  if (dashFix.stripped) {
    notes.push("Note: I removed the leading `--` for you. That's only needed when running the command through npm in your terminal.");
  }
  const tokens = tokenizeCommand(dashFix.cleaned);
  const parsed = parseExploreTokens(tokens);
  if (!parsed.ok) return { kind: 'reply', text: `✗ ${parsed.error}\n\n${EXPLORE_USAGE}` };
  const { request, positional } = parsed;
  if (request.outBase) return { kind: 'reply', text: '✗ --out is not available here: the dashboard scans output/ for run history. Use the CLI for a custom output root.' };
  if (request.review || request.fromPlan) return { kind: 'reply', text: '✗ Review mode (--review / --from-plan) needs the CLI: it pauses for a CSV edit at the terminal.' };
  if (!request.langProvided) request.lang = defaults.lang;
  // Dashboard-level setting overrides apply under the text flags.
  if (defaults.env) {
    for (const [name, value] of Object.entries(defaults.env)) {
      const err = validateEnvOverride(name, value);
      if (err) return { kind: 'reply', text: `✗ ${err}` };
      if (!(name in request.env)) request.env[name] = value;
    }
  }
  const url = positional[0];
  if (request.resume) {
    if (url) request.url = url;
    return { kind: 'explore', request, notes };
  }
  if (!url) return { kind: 'reply', text: EXPLORE_USAGE };
  request.url = url;
  // Words after the URL are a natural-language feature hint, unless the user
  // gave --features (then, like the CLI, extra words are ignored).
  const naturalHint = positional.slice(1).join(' ');
  if (!request.stabilize) notes.push('Note: Stabilizer (Stage 5b) is OFF. Flaky scenarios will be dropped without an LLM recovery attempt.');
  if (request.stabilizeAttempts !== 3) notes.push(`Note: Stabilizer will try up to ${request.stabilizeAttempts} fix attempt${request.stabilizeAttempts === 1 ? '' : 's'} per flaky scenario.`);
  for (const [name, value] of Object.entries(request.env)) {
    const setting = RUN_ENV_SETTINGS.find((s) => s.name === name);
    notes.push(`Note: ${setting?.label ?? name} = ${value} for this run.`);
  }
  return {
    kind: 'explore', request, notes,
    ...(naturalHint && request.features.length === 0 ? { naturalHint } : {}),
  };
}
