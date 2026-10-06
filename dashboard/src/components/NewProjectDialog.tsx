import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiWriteError, PROJECT_ENVIRONMENTS } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { InfoTerm, TermTip } from '@/components/Term';

/**
 * Create a project by host. The base URL is the identity (invariant 50): a
 * host that already has a project is refused by the API with a 409 that
 * names the existing one, and that message is shown inline. The name
 * defaults to the host brand, the environment is an optional label. The
 * only client-side check is that the base URL parses as http or https;
 * every other rule is the API's and its own message is shown.
 */
export function NewProjectDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** The 409 case, built only from the API body's `existing` (id and name), never from the message text. */
  const [conflict, setConflict] = useState<{ id: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  const reset = () => { setBaseUrl(''); setName(''); setEnvironment(''); setError(null); setConflict(null); setSaving(false); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const url = baseUrl.trim();
    setConflict(null);
    if (!url) { setError('Base URL is required.'); return; }
    let parsed: URL | null = null;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.hostname) { setError('Base URL must be a full http or https address, like https://shop.example/.'); return; }
    setSaving(true); setError(null);
    try {
      await api.createProject({ name: name.trim(), base_url: url, environment: environment || null });
      setOpen(false); reset(); onCreated();
    } catch (err) {
      const w = err instanceof ApiWriteError ? err : null;
      const existing = w?.body.existing as { id?: unknown; name?: unknown } | undefined;
      if (w?.status === 409 && existing && typeof existing.id === 'string' && typeof existing.name === 'string') setConflict({ id: existing.id, name: existing.name });
      else setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" data-testid="new-project-open">New project</Button>
      </DialogTrigger>
      <DialogContent data-testid="new-project-dialog" onOpenAutoFocus={(e) => { e.preventDefault(); urlRef.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>One project per website. Every run against that site is grouped here.</DialogDescription>
        </DialogHeader>
        <form className="mt-4 flex flex-col gap-4" onSubmit={(e) => { void submit(e); }} noValidate>
          <Field id="np-url" label="Base URL" term="projectBaseUrl" required help="The site's address, like https://shop.example/. It becomes the project's identity and cannot be changed later.">
            <input ref={urlRef} id="np-url" className={inputCls} data-testid="new-project-url" placeholder="https://shop.example/" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoComplete="off" inputMode="url" />
          </Field>
          <Field id="np-name" label="Name" term="projectName" help="Leave empty to use the host name, for example shop for shop.example.">
            <input id="np-name" className={inputCls} data-testid="new-project-name" placeholder="shop" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </Field>
          <Field id="np-env" label="Environment" term="projectEnvironment" help="An optional label for the cards and the project page: staging, production or other.">
            <select id="np-env" className={inputCls} data-testid="new-project-env" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
              <option value="">Not set</option>
              {PROJECT_ENVIRONMENTS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          {conflict ? (
            <div role="status" className="rounded-md border border-line-strong bg-bg-2 px-3 py-2 text-small text-fg" data-testid="new-project-conflict">
              This site already has a project: <span className="font-medium">{conflict.name}</span>. <Link to={`/projects/${encodeURIComponent(conflict.id)}`} className="font-medium text-accent underline-offset-2 hover:underline" data-testid="new-project-existing" onClick={() => setOpen(false)}>Open project</Link>
            </div>
          ) : null}
          {error ? <div role="alert" className="rounded-md border border-reject/30 bg-reject-soft px-3 py-2 text-small text-reject" data-testid="new-project-error">{error}</div> : null}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline" size="sm" data-testid="new-project-cancel">Cancel</Button></DialogClose>
            <TermTip term="createProject"><Button type="submit" size="sm" disabled={saving} data-testid="new-project-submit">{saving ? 'Creating…' : 'Create'}</Button></TermTip>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, term, help, required, children }: { id: string; label: string; term: 'projectBaseUrl' | 'projectName' | 'projectEnvironment'; help: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-center gap-1 text-caption font-medium text-fg">
        {label}{required ? <span className="text-reject" aria-hidden="true">*</span> : <span className="font-normal text-fg-2">optional</span>}
        <InfoTerm term={term} />
      </label>
      {children}
      <p className="text-caption text-fg-2">{help}</p>
    </div>
  );
}

const inputCls = 'h-9 w-full rounded-md border border-line-strong bg-bg-2 px-3 text-body text-fg placeholder:text-fg-3 focus:outline-none focus:ring-2 focus:ring-accent';
