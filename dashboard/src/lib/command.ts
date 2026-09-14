/**
 * The Terminal composer's form and its ONE way out: a command string. The
 * form never parses a flag. It serializes to `/explore <url> --flag value ...`
 * and the gateway parses that string with parseGatewayCommand, the same
 * parser the socket runs (src/agent/explore-request.ts is the only parser).
 * A typed command flows the other way through `formFromRequest`, fed by the
 * parsed ExploreRequest the gateway returned.
 *
 * Every field names its EXPLORE_FLAGS row in FORM_FIELDS; smoke-terminal walks
 * the table and checks that parseExploreTokens on the built command yields
 * the field's value. No `@/` imports here so the smoke can load this file
 * directly under tsx.
 */

export interface TerminalForm {
  url: string;
  /** Comma-separated feature names (--features). */
  features: string;
  /** Comma-separated page paths or URLs (--urls). */
  urls: string;
  discover: boolean;
  pom: boolean;
  lang: 'ts' | 'js';
  stabilize: boolean;
  /** Kept as text so a half-typed number does not snap; empty means default. */
  stabilizeAttempts: string;
  ceiling: string;
  repairReserve: string;
  maxSteps: string;
  plannerModel: string;
  explorerModel: string;
  criticModel: string;
}

export type FormField = keyof TerminalForm;

/** Each form field with the CLI flag it serializes to (the EXPLORE_FLAGS row). */
export const FORM_FIELDS: ReadonlyArray<{ field: FormField; flag: string; kind: 'url' | 'list' | 'toggle' | 'choice' | 'value' }> = [
  { field: 'url', flag: '(positional)', kind: 'url' },
  { field: 'features', flag: '--features', kind: 'list' },
  { field: 'urls', flag: '--urls', kind: 'list' },
  { field: 'discover', flag: '--discover', kind: 'toggle' },
  { field: 'pom', flag: '--no-pom', kind: 'toggle' },
  { field: 'lang', flag: '--lang', kind: 'choice' },
  { field: 'stabilize', flag: '--no-stabilize', kind: 'toggle' },
  { field: 'stabilizeAttempts', flag: '--stabilize-attempts', kind: 'value' },
  { field: 'ceiling', flag: '--ceiling', kind: 'value' },
  { field: 'repairReserve', flag: '--repair-reserve', kind: 'value' },
  { field: 'maxSteps', flag: '--max-steps', kind: 'value' },
  { field: 'plannerModel', flag: '--planner-model', kind: 'value' },
  { field: 'explorerModel', flag: '--explorer-model', kind: 'value' },
  { field: 'criticModel', flag: '--critic-model', kind: 'value' },
];

export function defaultForm(): TerminalForm {
  return {
    url: '', features: '', urls: '', discover: false, pom: true, lang: 'ts', stabilize: true, stabilizeAttempts: '',
    ceiling: '', repairReserve: '', maxSteps: '', plannerModel: '', explorerModel: '', criticModel: '',
  };
}

function quote(v: string): string {
  return /\s/.test(v) ? `"${v.replace(/"/g, '')}"` : v;
}

function list(v: string): string {
  return v.split(',').map((s) => s.trim()).filter(Boolean).join(',');
}

/** The exact command the Start button sends. */
export function buildCommand(f: TerminalForm): string {
  const t: string[] = ['/explore'];
  if (f.url.trim()) t.push(quote(f.url.trim()));
  if (list(f.features)) t.push('--features', quote(list(f.features)));
  if (list(f.urls)) t.push('--urls', quote(list(f.urls)));
  if (f.discover) t.push('--discover');
  if (!f.pom) t.push('--no-pom');
  if (f.lang !== 'ts') t.push('--lang', f.lang);
  if (!f.stabilize) t.push('--no-stabilize');
  if (f.stabilizeAttempts.trim()) t.push('--stabilize-attempts', f.stabilizeAttempts.trim());
  if (f.ceiling.trim()) t.push('--ceiling', f.ceiling.trim());
  if (f.repairReserve.trim()) t.push('--repair-reserve', f.repairReserve.trim());
  if (f.maxSteps.trim()) t.push('--max-steps', f.maxSteps.trim());
  if (f.plannerModel.trim()) t.push('--planner-model', quote(f.plannerModel.trim()));
  if (f.explorerModel.trim()) t.push('--explorer-model', quote(f.explorerModel.trim()));
  if (f.criticModel.trim()) t.push('--critic-model', quote(f.criticModel.trim()));
  return t.join(' ');
}

/** The ExploreRequest shape the gateway's parser returns (the fields the form reads). */
export interface ParsedRequestShape {
  url?: string;
  lang?: 'ts' | 'js';
  pom?: boolean;
  features?: string[];
  urls?: string[];
  discover?: boolean;
  stabilize?: boolean;
  stabilizeAttempts?: number;
  env?: Record<string, string>;
}

/** Fill the form from a request the gateway parsed out of a typed command. */
export function formFromRequest(r: ParsedRequestShape): TerminalForm {
  const env = r.env ?? {};
  return {
    url: r.url ?? '',
    features: (r.features ?? []).join(','),
    urls: (r.urls ?? []).join(','),
    discover: r.discover === true,
    pom: r.pom !== false,
    lang: r.lang === 'js' ? 'js' : 'ts',
    stabilize: r.stabilize !== false,
    stabilizeAttempts: r.stabilizeAttempts !== undefined && r.stabilizeAttempts !== 3 ? String(r.stabilizeAttempts) : '',
    ceiling: env.QA_CORE_COST_CEILING ?? '',
    repairReserve: env.QA_CORE_REPAIR_RESERVE ?? '',
    maxSteps: env.QA_CORE_MAX_STEPS ?? '',
    plannerModel: env.QA_CORE_PLANNER_MODEL ?? '',
    explorerModel: env.QA_CORE_EXPLORER_MODEL ?? '',
    criticModel: env.QA_CORE_CRITIC_MODEL ?? '',
  };
}

/** The SRS types the gateway accepts and its size cap. Mirrors run-explore.ts; the server enforces the same. */
export const SRS_EXTENSIONS = ['.md', '.txt', '.pdf', '.docx'];
export const SRS_MAX_BYTES = 2 * 1024 * 1024;

export function validateSrsFile(name: string, sizeBytes: number): string | null {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  if (!SRS_EXTENSIONS.includes(ext)) return `Unsupported SRS type "${ext || 'none'}" for ${name || 'the upload'}. Allowed: ${SRS_EXTENSIONS.join(', ')}.`;
  if (sizeBytes > SRS_MAX_BYTES) return `The SRS ${name} is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB; the cap is 2 MB.`;
  return null;
}

/** Why Start is disabled, or null when it may run. */
export function startBlocker(input: { socket: string; activeRunId: string | null; command: string }): string | null {
  if (input.socket !== 'connected') return 'the gateway socket is not connected';
  if (input.activeRunId) return `a run is already in progress: ${input.activeRunId}`;
  const c = input.command.trim();
  if (!c) return 'type a command or fill the form';
  if (/^\/explore(\s|$)/.test(c) && !/^\/explore\s+(?!--)\S/.test(c)) return 'enter a URL';
  return null;
}
