import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, HelpCircle, Paperclip, Pencil, Play, X } from 'lucide-react';
import { api, type ParsedCommand } from '@/lib/api';
import { startCommand, useGateway } from '@/lib/gateway';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { buildCommand, defaultForm, formFromRequest, startBlocker, validateSrsFile, type TerminalForm } from '@/lib/command';
import { useSessionOverrides } from '@/lib/session-overrides';
import { fmtDate } from '@/lib/utils';

/**
 * The Terminal: start a QA-Core run from the dashboard and watch it live.
 * No shell. The composer serializes to the exact slash command it sends;
 * the command box (a read-only preview, editable on request) accepts any of
 * /explore, /resume, /transcribe, /heal, /generate with every CLI flag. Both
 * are parsed by ONE parser, the gateway's parseGatewayCommand
 * (POST /api/command/parse), so the form never interprets a flag itself: a
 * typed command is parsed server-side and the parsed request fills the form.
 *
 * Three tiers: the top row (URL, features, SRS, Start), "Scope" (pages,
 * discovery, output, language, stabilizer) and "Budget and models" (ceiling,
 * repair reserve, max steps, the three models). Defaults are shown as values
 * with a "default" chip, never as placeholders; placeholders are examples
 * prefixed "e.g." and rendered dimmer than typed text.
 */

/** Placeholders are examples: prefixed "e.g." and visibly dimmer than typed text (the ph-example class). */
const PH = 'ph-example placeholder:text-fg-3 placeholder:italic';
const inputCls = `h-8 rounded-md border border-line-strong bg-bg-2 px-2 text-s text-fg focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 ${PH}`;

const SETTING_FIELDS: Array<{ field: 'ceiling' | 'repairReserve' | 'maxSteps' | 'plannerModel' | 'explorerModel' | 'criticModel'; env: string; label: string; flag: string; mono?: boolean }> = [
  { field: 'ceiling', env: 'QA_CORE_COST_CEILING', label: 'Cost ceiling (USD)', flag: '--ceiling' },
  { field: 'repairReserve', env: 'QA_CORE_REPAIR_RESERVE', label: 'Repair reserve', flag: '--repair-reserve' },
  { field: 'maxSteps', env: 'QA_CORE_MAX_STEPS', label: 'Max steps', flag: '--max-steps' },
  { field: 'plannerModel', env: 'QA_CORE_PLANNER_MODEL', label: 'Planner model', flag: '--planner-model', mono: true },
  { field: 'explorerModel', env: 'QA_CORE_EXPLORER_MODEL', label: 'Explorer model', flag: '--explorer-model', mono: true },
  { field: 'criticModel', env: 'QA_CORE_CRITIC_MODEL', label: 'Critic model', flag: '--critic-model', mono: true },
];

export function TerminalPage() {
  const gw = useGateway();
  const navigate = useNavigate();
  const [form, setForm] = useState<TerminalForm>(defaultForm);
  const [command, setCommand] = useState<string>(() => buildCommand(defaultForm()));
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [parsed, setParsed] = useState<ParsedCommand | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [srs, setSrs] = useState<{ name: string; size: number; base64: string } | null>(null);
  const [srsError, setSrsError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const overrides = useSessionOverrides();
  // The project the URL lands in (the indexer's host slug rule) and its requirements document, if any.
  const [projectSrs, setProjectSrs] = useState<{ projectId: string; name: string; uploadedAt: string; path: string } | null>(null);
  const [useProjectSrs, setUseProjectSrs] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  // Who edited last decides the direction: the form rewrites the command, the command refills the form.
  const source = useRef<'form' | 'raw'>('form');

  const setField = <K extends keyof TerminalForm>(k: K, v: TerminalForm[K]) => {
    source.current = 'form';
    setForm((f) => { const next = { ...f, [k]: v }; setCommand(buildCommand(next)); return next; });
  };
  const onRaw = (v: string) => { source.current = 'raw'; setCommand(v); };

  useEffect(() => {
    let live = true;
    const url = form.url.trim();
    if (!/^https?:\/\/[^/]+/i.test(url)) { setProjectSrs(null); return () => { live = false; }; }
    const t = setTimeout(() => {
      api.matchProject(url).then((m) => { if (live) setProjectSrs(m.project_id && m.srs ? { projectId: m.project_id, name: m.srs.original_name, uploadedAt: m.srs.uploaded_at, path: m.srs.path } : null); }).catch(() => { if (live) setProjectSrs(null); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [form.url]);

  // Parse the displayed command on the gateway (debounced). A typed command
  // that parses as /explore fills the form from the parsed request.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.parseCommand(command, form.lang, overrides).then((p) => {
        if (!live) return;
        setParsed(p); setParseError(null);
        if (source.current === 'raw' && p.ok && p.kind === 'explore') setForm(formFromRequest(p.request as Parameters<typeof formFromRequest>[0]));
      }).catch((e: unknown) => { if (live) { setParsed(null); setParseError((e as Error).message); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [command, form.lang, overrides]);

  // A run_started for our command: go watch it.
  const liveId = gw.live?.runId ?? null;
  useEffect(() => { if (starting && liveId) { setStarting(false); navigate(`/runs/${encodeURIComponent(liveId)}`); } }, [starting, liveId, navigate]);
  useEffect(() => { if (starting && gw.lastError) setStarting(false); }, [starting, gw.lastError]);

  const blocker = useMemo(() => startBlocker({ socket: gw.socket, activeRunId: gw.activeRun?.run_id ?? null, command }) ?? (parsed && !parsed.ok ? parsed.error : null), [gw.socket, gw.activeRun, command, parsed]);
  const canStart = !blocker && !starting;
  const gatewayDefault = (env: string) => gw.settings.find((s) => s.name === env)?.value ?? '';
  // The ceiling this run stops at: the form value when typed, else the session override, else the gateway default (the parser's own precedence).
  const effectiveCeiling = form.ceiling.trim() || overrides.QA_CORE_COST_CEILING || gatewayDefault('QA_CORE_COST_CEILING');
  const isExplore = /^\/explore(\s|$)/.test(command.trim());
  // The preview shows what will run: the command as sent plus where the SRS will come from.
  const srsPreview = srs ? ` --srs <run folder>/${srs.name}` : projectSrs && useProjectSrs && isExplore ? ` --srs ${projectSrs.path}` : '';
  const preview = command.trim() + srsPreview;

  const pickSrs = (file: File | undefined) => {
    setSrsError(null);
    if (!file) return;
    const err = validateSrsFile(file.name, file.size);
    if (err) { setSrs(null); setSrsError(err); return; }
    const reader = new FileReader();
    reader.onload = () => { const url = String(reader.result ?? ''); setSrs({ name: file.name, size: file.size, base64: url.slice(url.indexOf(',') + 1) }); };
    reader.readAsDataURL(file);
  };

  const start = () => {
    if (!canStart) return;
    setStarting(true);
    const ok = startCommand({
      content: command.trim(), lang: form.lang, env: overrides,
      ...(srs ? { srs: { name: srs.name, base64: srs.base64 } } : projectSrs && useProjectSrs ? { srsProject: projectSrs.projectId } : {}),
    });
    if (!ok) setStarting(false);
  };
  const copy = () => { navigator.clipboard?.writeText(preview).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => { /* clipboard blocked */ }); };

  return (
    <div className="flex flex-col gap-5" data-testid="terminal">
      <header className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-m font-semibold">Terminal</h1>
        <span className="text-s text-fg-2">Start a QA-Core run and watch it live. Commands only, no shell.</span>
        <details className="relative ml-auto text-s" data-testid="usage-help">
          <summary className="inline-flex cursor-pointer items-center gap-1 text-fg-2 hover:text-fg"><HelpCircle className="h-3.5 w-3.5" /> usage</summary>
          <div className="absolute right-0 z-10 mt-1 w-[28rem] rounded-lg border border-line bg-bg-1 p-3 text-fg-2 shadow-lg">
            <div className="mb-1 font-semibold text-fg">Commands the gateway accepts</div>
            <ul className="mono flex flex-col gap-1">
              <li>/explore &lt;url&gt; [--features a,b] [--urls /a,/b] [--discover] [--lang ts|js] [--no-pom] [--no-stabilize] [--stabilize-attempts N] [--ceiling USD] [--repair-reserve F] [--max-steps N] [--planner-model M] [--explorer-model M] [--critic-model M]</li>
              <li>/resume &lt;path/to/checkpoint.json&gt; [--ceiling USD]</li>
              <li>/transcribe &lt;path/to/run-report.json&gt;</li>
              <li>/heal &lt;spec-path&gt;</li>
              <li>/generate &lt;user story&gt;</li>
            </ul>
            <div className="mt-2">Every flag the CLI accepts works here the same way. Words after the URL are a natural-language feature hint.</div>
          </div>
        </details>
      </header>

      {/* Tier 1: what to test, with what, and go. */}
      <section className="rounded-lg border border-line bg-bg-1 p-4" data-testid="composer" data-tier="top">
        <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
          <Field label="URL" hint="the entry page">
            <input className={inputCls} data-testid="f-url" placeholder="e.g. https://www.saucedemo.com/" value={form.url} onChange={(e) => setField('url', e.target.value)} />
          </Field>
          <Field label="Features" hint="--features; empty lets the Planner infer">
            <input className={inputCls} data-testid="f-features" placeholder="e.g. login,cart" value={form.features} onChange={(e) => setField('features', e.target.value)} />
          </Field>
          <Field label="SRS" hint=".md, .txt, .pdf, .docx; 2 MB cap">
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" accept=".md,.txt,.pdf,.docx" hidden data-testid="f-srs" onChange={(e) => pickSrs(e.target.files?.[0])} />
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} data-testid="srs-attach"><Paperclip className="h-3.5 w-3.5" /> Attach</Button>
              {srs ? <span className="text-s text-fg" data-testid="srs-name">{srs.name} <span className="text-fg-2">{formatSize(srs.size)}</span></span> : <span className="text-s text-fg-2" data-testid="srs-name">none attached</span>}
              {srs ? <Button type="button" variant="ghost" size="sm" onClick={() => { setSrs(null); if (fileRef.current) fileRef.current.value = ''; }} aria-label="Remove SRS"><X className="h-3.5 w-3.5" /></Button> : null}
            </div>
          </Field>
          <div className="flex flex-col items-start gap-1">
            <Button type="button" onClick={start} disabled={!canStart} data-testid="start" title={blocker ?? 'Start the run'}><Play className="h-4 w-4" /> {starting ? 'Starting…' : 'Start'}</Button>
            {isExplore && effectiveCeiling ? <span className="text-s text-fg-2" data-testid="start-ceiling">ceiling <span className="mono text-cost">${Number(effectiveCeiling).toFixed(2)}</span>, stops cleanly if reached</span> : null}
          </div>
        </div>
        {srsError ? <div className="mt-2 text-s text-reject" data-testid="srs-error">{srsError}</div> : null}
        {projectSrs && !srs ? (
          <label className="mt-2 flex flex-wrap items-center gap-2 text-s text-fg" data-testid="project-srs-option">
            <input type="checkbox" checked={useProjectSrs} onChange={(e) => setUseProjectSrs(e.target.checked)} data-testid="use-project-srs" />
            <span>use project SRS (<span className="mono">{projectSrs.name}</span>, uploaded {fmtDate(projectSrs.uploadedAt)})</span>
            <span className="text-fg-2">a copy is saved into the run folder</span>
          </label>
        ) : null}
        {projectSrs && srs ? <div className="mt-2 text-s text-fg-2" data-testid="project-srs-overridden">The attached file overrides the project SRS ({projectSrs.name}).</div> : null}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-s">
          {blocker ? <span className="text-fg-2" data-testid="start-blocker">{blocker}</span> : <span className="text-fg-2">the run opens at /runs/&lt;run id&gt; and streams live</span>}
          {gw.activeRun ? <Badge variant="accent" data-testid="active-run">running: {gw.activeRun.run_id}</Badge> : null}
          {gw.lastError && !starting ? <span className="text-reject" data-testid="start-error">{gw.lastError}</span> : null}
        </div>
      </section>

      {/* Tier 2: scope. */}
      <details className="rounded-lg border border-line bg-bg-1" data-testid="tier-scope" data-tier="scope">
        <summary className="cursor-pointer px-4 py-3 text-m font-semibold">Scope <span className="text-s font-normal text-fg-2">pages, discovery, output, language, stabilizer</span></summary>
        <div className="grid gap-3 px-4 pb-4 md:grid-cols-2">
          <Field label="Pages" hint="--urls, comma-separated paths or URLs">
            <input className={inputCls} data-testid="f-urls" placeholder="e.g. /login,/cart" value={form.urls} onChange={(e) => setField('urls', e.target.value)} />
          </Field>
          <Field label="Discovery" hint="--discover: sitemap and crawl for more pages">
            <Toggle testid="f-discover" checked={form.discover} onChange={(v) => setField('discover', v)} label={form.discover ? 'on' : 'off'} />
          </Field>
          <Field label="Output" hint="--no-pom emits one inline spec instead of the POM framework">
            <Toggle testid="f-pom" checked={form.pom} onChange={(v) => setField('pom', v)} label={form.pom ? 'POM framework' : 'inline spec'} />
          </Field>
          <Field label="Language" hint="--lang">
            <select className={inputCls} data-testid="f-lang" value={form.lang} onChange={(e) => setField('lang', e.target.value === 'js' ? 'js' : 'ts')}>
              <option value="ts">TypeScript</option>
              <option value="js">JavaScript</option>
            </select>
          </Field>
          <Field label="Stabilizer" hint="--no-stabilize turns Stage 5b off; --stabilize-attempts caps fix attempts">
            <div className="flex items-center gap-3">
              <Toggle testid="f-stabilize" checked={form.stabilize} onChange={(v) => setField('stabilize', v)} label={form.stabilize ? 'on' : 'off'} />
              <ValueWithDefault testid="f-stabilizeAttempts" value={form.stabilizeAttempts} onChange={(v) => setField('stabilizeAttempts', v)} defaultValue="3" override={undefined} disabled={!form.stabilize} width="w-20" />
              <span className="text-s text-fg-2">attempts</span>
            </div>
          </Field>
        </div>
      </details>

      {/* Tier 3: budget and models. */}
      <details className="rounded-lg border border-line bg-bg-1" data-testid="tier-budget" data-tier="budget">
        <summary className="cursor-pointer px-4 py-3 text-m font-semibold">Budget and models <span className="text-s font-normal text-fg-2">ceiling, repair reserve, max steps, the three models</span></summary>
        <div className="grid gap-3 px-4 pb-4 md:grid-cols-2">
          {SETTING_FIELDS.map((s) => (
            <Field key={s.field} label={s.label} hint={s.flag}>
              <ValueWithDefault testid={`f-${s.field}`} value={form[s.field]} onChange={(v) => setField(s.field, v)} defaultValue={gatewayDefault(s.env)} override={overrides[s.env]} mono={s.mono} />
            </Field>
          ))}
          <div className="text-s text-fg-2 md:col-span-2">A typed value becomes the flag in the command. A <Badge variant="accent">session override</Badge> travels as the command's per-run setting (change or clear it in <Link to="/settings" className="text-accent underline">Settings</Link>). Otherwise the gateway default applies.</div>
        </div>
      </details>

      {/* The command: a read-only preview of exactly what will run; edit on request. */}
      <section className="rounded-lg border border-line bg-bg-1 p-4" data-testid="command-section">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-s text-fg-2">
          <span className="font-semibold uppercase tracking-wide">Command</span>
          <span>exactly what will run</span>
          <div className="ml-auto flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={copy} data-testid="copy-command" title="Copy the command"><Copy className="h-3.5 w-3.5" /> {copied ? 'copied' : 'copy'}</Button>
            <Button type="button" variant={editing ? 'outline' : 'ghost'} size="sm" onClick={() => setEditing((e) => !e)} data-testid="edit-command" aria-pressed={editing}><Pencil className="h-3.5 w-3.5" /> {editing ? 'done editing' : 'edit command'}</Button>
          </div>
        </div>
        {editing ? (
          <textarea className={`${inputCls} mono min-h-[64px] w-full resize-y`} data-testid="command" value={command} onChange={(e) => onRaw(e.target.value)} spellCheck={false} />
        ) : (
          <code className="mono block w-full overflow-x-auto whitespace-nowrap rounded-md border border-line bg-bg-2 px-2 py-1.5 text-s text-fg" data-testid="command-preview">{preview}</code>
        )}
        {editing && srsPreview ? <div className="mt-1 text-s text-fg-2">plus{srsPreview}</div> : null}
        {Object.keys(overrides).length ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-s" data-testid="session-overrides">
            <span className="text-fg-2">sent with this command as per-run settings:</span>
            {Object.entries(overrides).map(([k, v]) => <Badge key={k} variant="accent" data-testid="override-chip" data-name={k}>session override <span className="mono">{k.replace('QA_CORE_', '').toLowerCase().replace(/_/g, ' ')} = {v}</span></Badge>)}
            <Link to="/settings" className="text-accent underline">change or clear in Settings</Link>
          </div>
        ) : null}
        {srs ? <div className="mt-1 text-s text-fg-2" data-testid="command-srs-note">SRS attached: {srs.name}. It is sent with the command and saved into the run folder, then passed to the run as --srs.</div> : null}
        <div className="mt-2 text-s" data-testid="parsed">
          {parseError ? <span className="text-reject">{parseError}</span>
            : !parsed ? <span className="text-fg-2">parsing…</span>
            : !parsed.ok ? (isExplore && !/^\/explore\s+(?!--)\S/.test(command.trim()) ? <span className="text-fg-2">waiting for a URL; see usage for the flags</span> : <span className="text-rework" data-testid="parse-error">{parsed.error}</span>)
            : parsed.kind === 'explore' ? (
              <details>
                <summary className="cursor-pointer text-fg-2">parsed as /explore <span className="mono text-fg">{String(parsed.request.url ?? '')}</span>{parsed.notes.length ? <span className="text-fg-2"> · {parsed.notes.length} note{parsed.notes.length === 1 ? '' : 's'}</span> : null}</summary>
                <pre className="mono mt-1 max-h-64 overflow-auto rounded-md bg-bg-2 p-2 text-s text-fg-2" data-testid="parsed-request">{JSON.stringify(parsed.request, null, 1)}</pre>
                {parsed.notes.map((n, i) => <div key={i} className="text-fg-2">{n}</div>)}
              </details>
            ) : <span className="text-fg-2">parsed as /{parsed.kind}: {parsed.summary}</span>}
        </div>
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-s font-semibold text-fg">{label} <span className="font-normal text-fg-2">{hint}</span></span>
      {children}
    </label>
  );
}

/**
 * A setting input whose empty state shows the effective value as a VALUE with
 * a chip: "default" from the gateway, or "session override" from this tab.
 * Never a placeholder, so a default can never be mistaken for typed text.
 */
function ValueWithDefault({ testid, value, onChange, defaultValue, override, mono, disabled, width }: { testid: string; value: string; onChange: (v: string) => void; defaultValue: string; override: string | undefined; mono?: boolean; disabled?: boolean; width?: string }) {
  const effective = value.trim() ? null : override ?? defaultValue;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={`${testid}-wrap`}>
      <input className={`${inputCls} ${mono ? 'mono' : ''} ${width ?? 'w-56'}`} data-testid={testid} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={testid} />
      {effective !== null ? (
        <span className="flex items-center gap-1 text-s" data-testid={`${testid}-effective`}>
          <span className={`text-fg ${mono ? 'mono' : ''}`}>{effective || 'unknown'}</span>
          {override ? <Badge variant="accent" data-testid="override-chip-field">session override</Badge> : <Badge variant="outline" data-testid="default-chip">default</Badge>}
        </span>
      ) : null}
    </div>
  );
}

function Toggle({ checked, onChange, label, testid }: { checked: boolean; onChange: (v: boolean) => void; label: string; testid: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} data-testid={testid} data-checked={checked ? 'true' : 'false'} onClick={() => onChange(!checked)} className={`inline-flex h-8 items-center gap-2 rounded-md border px-2 text-s ${checked ? 'border-transparent bg-accent-soft text-accent' : 'border-line-strong bg-bg-2 text-fg-2'}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${checked ? 'bg-accent' : 'bg-neutral'}`} />{label}
    </button>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
