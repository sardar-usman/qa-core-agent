import { useEffect, useState } from 'react';
import { api, ApiError, type GatewaySettings } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { clearOverrides, setOverride, useSessionOverrides } from '@/lib/session-overrides';

/**
 * Settings: the gateway's effective defaults as read from its process at
 * request time, and this tab's session overrides of the run settings. No
 * secret is shown or editable; the API key and the gateway token appear only
 * as set or not set.
 */
export function SettingsPage() {
  const [settings, setSettings] = useState<GatewaySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const overrides = useSessionOverrides();
  useEffect(() => {
    let live = true;
    api.settings().then((s) => { if (live) { setSettings(s); setError(null); } }).catch((e: unknown) => { if (live) setError(e instanceof ApiError && e.status === 401 ? 'Unauthorized: add #token=<QA_CORE_GATEWAY_TOKEN> to the URL.' : (e as Error).message); });
    return () => { live = false; };
  }, []);
  if (error) return <EmptyState title="Could not load settings">{error}</EmptyState>;
  if (!settings) return <div className="text-small text-fg-2">Loading…</div>;
  const overrideCount = Object.keys(overrides).length;
  return (
    <div className="flex flex-col gap-8" data-testid="settings-page">
      <PageHeader title="Settings" description="The gateway's effective defaults, read from its process when this page loaded. Overrides below live in this browser tab only and apply to every run the Terminal starts from it." />

      <section className="rounded-lg border border-line bg-bg-1 p-6" data-testid="gateway-defaults">
        <h2 className="text-heading font-semibold">Gateway</h2>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
          <Row label="output root" value={settings.output_root} mono testid="setting-output-root" />
          <Row label="gateway" value={settings.gateway.host && settings.gateway.port ? `${settings.gateway.host}:${settings.gateway.port}` : 'unknown'} mono testid="setting-gateway" />
          <Row label="gateway token" value={settings.token_set ? 'set' : 'not set'} testid="setting-token" />
          <Row label="Anthropic API key" value={settings.api_key_set ? 'set' : 'not set'} testid="setting-api-key" />
        </dl>
        <p className="mt-2 text-small text-fg-2">Secrets are reported as set or not set; their values never leave the gateway process.</p>
      </section>

      <section className="rounded-lg border border-line bg-bg-1 p-6" data-testid="run-settings">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-heading font-semibold">Run settings</h2>
          <span className="text-small text-fg-2">default from the gateway, and this tab's session override</span>
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={clearOverrides} disabled={overrideCount === 0} data-testid="clear-overrides">Clear session overrides{overrideCount ? ` (${overrideCount})` : ''}</Button>
        </div>
        <table className="mt-4 w-full text-body" data-testid="run-settings-table">
          <thead><tr className="h-9 text-left text-caption font-medium text-fg-3"><th className="pr-3 font-medium">Setting</th><th className="pr-3 font-medium">Gateway default</th><th className="pr-3 font-medium">Session override</th></tr></thead>
          <tbody>
            {settings.run_settings.map((s) => (
              <tr key={s.name} className="border-t border-line/60" data-testid="run-setting" data-name={s.name}>
                <td className="py-3 pr-3"><div className="font-medium text-fg">{s.label}</div><div className="mono text-fg-2">{s.name}</div>{s.help ? <div className="mt-1 max-w-xl text-small text-fg-2" data-testid="setting-help">{s.help}</div> : null}</td>
                <td className="py-3 pr-3"><span className="mono text-fg" data-testid="setting-default">{s.value}</span> <span className="text-small text-fg-2">{s.fromEnv ? 'from env' : 'built-in default'}</span></td>
                <td className="py-3 pr-3">
                  <div className="flex items-center gap-2">
                    <input className="h-9 w-56 rounded-md border border-line-strong bg-bg-2 px-3 text-body text-fg placeholder:text-fg-3" placeholder={`default ${s.value}`} value={overrides[s.name] ?? ''} onChange={(e) => setOverride(s.name, e.target.value)} data-testid="setting-override" aria-label={`${s.label} session override`} />
                    {overrides[s.name] ? <Badge variant="accent" data-testid="override-badge">session override</Badge> : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-small text-fg-2">An override travels with each command as the same QA_CORE_* name the CLI reads and is applied for that run only. It is never written to disk or to the gateway's environment.</p>
      </section>
    </div>
  );
}

function Row({ label, value, mono, testid }: { label: string; value: string; mono?: boolean; testid: string }) {
  return (
    <div className="flex flex-col rounded-md border border-line bg-bg-2 px-3 py-2">
      <dt className="text-caption font-medium text-fg-2">{label}</dt>
      <dd className={`text-body text-fg ${mono ? 'mono' : ''}`} data-testid={testid}>{value}</dd>
    </div>
  );
}
