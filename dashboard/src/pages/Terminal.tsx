import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Paperclip, Play, X } from 'lucide-react';
import { api, type ParsedCommand } from '@/lib/api';
import { startCommand, useGateway } from '@/lib/gateway';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { buildCommand, defaultForm, formFromRequest, startBlocker, validateSrsFile, type TerminalForm } from '@/lib/command';

/**
 * The Terminal: start a QA-Core run from the dashboard and watch it live.
 * No shell. The composer serializes to the exact slash command it sends;
 * the raw box beneath accepts any of /explore, /resume, /transcribe, /heal,
 * /generate with every CLI flag. Both are parsed by ONE parser, the gateway's
 * parseGatewayCommand (POST /api/command/parse), so the form never interprets
 * a flag itself: a typed command is parsed server-side and the parsed request
 * fills the form.
 */

const MODEL_HINT = 'leave empty for the gateway default';

export function TerminalPage() {
  const gw = useGateway();
  const navigate = useNavigate();
  const [form, setForm] = useState<TerminalForm>(defaultForm);
  const [command, setCommand] = useState<string>(() => buildCommand(defaultForm()));
  const [parsed, setParsed] = useState<ParsedCommand | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [srs, setSrs] = useState<{ name: string; size: number; base64: string } | null>(null);
  const [srsError, setSrsError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Who edited last decides the direction: the form rewrites the command, the command refills the form.
  const source = useRef<'form' | 'raw'>('form');

  const setField = <K extends keyof TerminalForm>(k: K, v: TerminalForm[K]) => {
    source.current = 'form';
    setForm((f) => { const next = { ...f, [k]: v }; setCommand(buildCommand(next)); return next; });
  };
  const onRaw = (v: string) => { source.current = 'raw'; setCommand(v); };

  // Parse the displayed command on the gateway (debounced). A typed command
  // that parses as /explore fills the form from the parsed request.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.parseCommand(command, form.lang).then((p) => {
        if (!live) return;
        setParsed(p); setParseError(null);
        if (source.current === 'raw' && p.ok && p.kind === 'explore') setForm(formFromRequest(p.request as Parameters<typeof formFromRequest>[0]));
      }).catch((e: unknown) => { if (live) { setParsed(null); setParseError((e as Error).message); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [command, form.lang]);

  // A run_started for our command: go watch it.
  const liveId = gw.live?.runId ?? null;
  useEffect(() => { if (starting && liveId) { setStarting(false); navigate(`/runs/${encodeURIComponent(liveId)}`); } }, [starting, liveId, navigate]);
  useEffect(() => { if (starting && gw.lastError) setStarting(false); }, [starting, gw.lastError]);

  const blocker = useMemo(() => startBlocker({ socket: gw.socket, activeRunId: gw.activeRun?.run_id ?? null, command }) ?? (parsed && !parsed.ok ? parsed.error : null), [gw.socket, gw.activeRun, command, parsed]);
  const canStart = !blocker && !starting;

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
    const ok = startCommand({ content: command.trim(), lang: form.lang, ...(srs ? { srs: { name: srs.name, base64: srs.base64 } } : {}) });
    if (!ok) setStarting(false);
  };

  return (
    <div className="flex flex-col gap-5" data-testid="terminal">
      <header className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-m font-semibold">Terminal</h1>
        <span className="text-s text-fg-2">Start a QA-Core run and watch it live. Commands only: /explore, /resume, /transcribe, /heal, /generate, with every CLI flag.</span>
      </header>

      <section className="rounded-lg border border-line bg-bg-1 p-4" data-testid="composer">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="URL" hint="the entry page" wide>
            <input className={inputCls} data-testid="f-url" placeholder="https://www.saucedemo.com/" value={form.url} onChange={(e) => setField('url', e.target.value)} />
          </Field>
          <Field label="Features" hint="--features, comma-separated; empty lets the Planner infer">
            <input className={inputCls} data-testid="f-features" placeholder="login,cart" value={form.features} onChange={(e) => setField('features', e.target.value)} />
          </Field>
          <Field label="Pages" hint="--urls, comma-separated paths or URLs">
            <input className={inputCls} data-testid="f-urls" placeholder="/login,/cart" value={form.urls} onChange={(e) => setField('urls', e.target.value)} />
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
              <input className={`${inputCls} w-24`} data-testid="f-stabilizeAttempts" placeholder="3" inputMode="numeric" value={form.stabilizeAttempts} onChange={(e) => setField('stabilizeAttempts', e.target.value)} disabled={!form.stabilize} title="attempts" />
            </div>
          </Field>
          <Field label="Cost ceiling (USD)" hint="--ceiling">
            <input className={inputCls} data-testid="f-ceiling" placeholder={settingDefault(gw.settings, 'QA_CORE_COST_CEILING')} inputMode="decimal" value={form.ceiling} onChange={(e) => setField('ceiling', e.target.value)} />
          </Field>
          <Field label="Repair reserve" hint="--repair-reserve, fraction of the ceiling">
            <input className={inputCls} data-testid="f-repairReserve" placeholder={settingDefault(gw.settings, 'QA_CORE_REPAIR_RESERVE')} inputMode="decimal" value={form.repairReserve} onChange={(e) => setField('repairReserve', e.target.value)} />
          </Field>
          <Field label="Max steps" hint="--max-steps">
            <input className={inputCls} data-testid="f-maxSteps" placeholder={settingDefault(gw.settings, 'QA_CORE_MAX_STEPS')} inputMode="numeric" value={form.maxSteps} onChange={(e) => setField('maxSteps', e.target.value)} />
          </Field>
          <Field label="Planner model" hint={`--planner-model, ${MODEL_HINT}`}>
            <input className={`${inputCls} mono`} data-testid="f-plannerModel" placeholder={settingDefault(gw.settings, 'QA_CORE_PLANNER_MODEL')} value={form.plannerModel} onChange={(e) => setField('plannerModel', e.target.value)} />
          </Field>
          <Field label="Explorer model" hint={`--explorer-model, ${MODEL_HINT}`}>
            <input className={`${inputCls} mono`} data-testid="f-explorerModel" placeholder={settingDefault(gw.settings, 'QA_CORE_EXPLORER_MODEL')} value={form.explorerModel} onChange={(e) => setField('explorerModel', e.target.value)} />
          </Field>
          <Field label="Critic model" hint={`--critic-model, ${MODEL_HINT}`}>
            <input className={`${inputCls} mono`} data-testid="f-criticModel" placeholder={settingDefault(gw.settings, 'QA_CORE_CRITIC_MODEL')} value={form.criticModel} onChange={(e) => setField('criticModel', e.target.value)} />
          </Field>
          <Field label="SRS" hint="attach a .md, .txt, .pdf or .docx (2 MB cap); saved into the run folder and passed as --srs">
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" accept=".md,.txt,.pdf,.docx" hidden data-testid="f-srs" onChange={(e) => pickSrs(e.target.files?.[0])} />
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} data-testid="srs-attach"><Paperclip className="h-3.5 w-3.5" /> Attach SRS</Button>
              {srs ? <span className="text-s text-fg" data-testid="srs-name">{srs.name} <span className="text-fg-2">{formatSize(srs.size)}</span></span> : <span className="text-s text-fg-2" data-testid="srs-name">none attached</span>}
              {srs ? <Button type="button" variant="ghost" size="sm" onClick={() => { setSrs(null); if (fileRef.current) fileRef.current.value = ''; }} aria-label="Remove SRS"><X className="h-3.5 w-3.5" /></Button> : null}
            </div>
            {srsError ? <div className="mt-1 text-s text-reject" data-testid="srs-error">{srsError}</div> : null}
          </Field>
        </div>
      </section>

      <section className="rounded-lg border border-line bg-bg-1 p-4" data-testid="command-section">
        <div className="mb-1 flex items-baseline gap-2 text-s text-fg-2">
          <span className="font-semibold uppercase tracking-wide">Command</span>
          <span>this exact text is sent to the gateway; edit it and the form follows</span>
        </div>
        <textarea className={`${inputCls} mono min-h-[64px] w-full resize-y`} data-testid="command" value={command} onChange={(e) => onRaw(e.target.value)} spellCheck={false} />
        {srs ? <div className="mt-1 text-s text-fg-2" data-testid="command-srs-note">SRS attached: {srs.name}. It is sent with the command and saved into the run folder, then passed to the run as --srs.</div> : null}
        <div className="mt-2 text-s" data-testid="parsed">
          {parseError ? <span className="text-reject">{parseError}</span>
            : !parsed ? <span className="text-fg-2">parsing…</span>
            : !parsed.ok ? <span className="text-rework" data-testid="parse-error">{parsed.error}</span>
            : parsed.kind === 'explore' ? (
              <details>
                <summary className="cursor-pointer text-fg-2">parsed as /explore <span className="mono text-fg">{String(parsed.request.url ?? '')}</span>{parsed.notes.length ? <span className="text-fg-2"> · {parsed.notes.length} note{parsed.notes.length === 1 ? '' : 's'}</span> : null}</summary>
                <pre className="mono mt-1 max-h-64 overflow-auto rounded-md bg-bg-2 p-2 text-s text-fg-2" data-testid="parsed-request">{JSON.stringify(parsed.request, null, 1)}</pre>
                {parsed.notes.map((n, i) => <div key={i} className="text-fg-2">{n}</div>)}
              </details>
            ) : <span className="text-fg-2">parsed as /{parsed.kind}: {parsed.summary}</span>}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={start} disabled={!canStart} data-testid="start" title={blocker ?? 'Start the run'}><Play className="h-4 w-4" /> {starting ? 'Starting…' : 'Start'}</Button>
        {blocker ? <span className="text-s text-fg-2" data-testid="start-blocker">{blocker}</span> : <span className="text-s text-fg-2">the run opens at /runs/&lt;run id&gt; and streams live</span>}
        {gw.activeRun ? <Badge variant="accent" data-testid="active-run">running: {gw.activeRun.run_id}</Badge> : null}
        {gw.lastError && !starting ? <span className="text-s text-reject" data-testid="start-error">{gw.lastError}</span> : null}
      </div>
    </div>
  );
}

const inputCls = 'h-8 rounded-md border border-line-strong bg-bg-2 px-2 text-s text-fg placeholder:text-fg-2 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50';

function Field({ label, hint, wide, children }: { label: string; hint: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? 'md:col-span-2' : ''}`}>
      <span className="text-s font-semibold text-fg">{label} <span className="font-normal text-fg-2">{hint}</span></span>
      {children}
    </label>
  );
}

function Toggle({ checked, onChange, label, testid }: { checked: boolean; onChange: (v: boolean) => void; label: string; testid: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} data-testid={testid} data-checked={checked ? 'true' : 'false'} onClick={() => onChange(!checked)} className={`inline-flex h-8 items-center gap-2 rounded-md border px-2 text-s ${checked ? 'border-transparent bg-accent-soft text-accent' : 'border-line-strong bg-bg-2 text-fg-2'}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${checked ? 'bg-accent' : 'bg-neutral'}`} />{label}
    </button>
  );
}

function settingDefault(settings: Array<{ name: string; value: string }>, name: string): string {
  return settings.find((s) => s.name === name)?.value ?? '';
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
