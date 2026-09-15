/**
 * Locks the Settings page (dashboard v2 plan, PR E1):
 *   - GET /api/settings reports the gateway's effective defaults as read
 *     from its process (run settings with their env/default origin, output
 *     root, host and port, token set yes/no) and never a secret value
 *   - session overrides travel as the command's env and merge under text
 *     flags through the same parser the socket uses (POST /api/command/parse)
 *   - on the page: defaults render, an override set in Settings shows on the
 *     Terminal as a "session override" chip and in the parsed request, and
 *     one button clears it; no secret appears in any page text
 * Real gateway process over a fixture root; no model, no live run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { gatewaySettings } from '../src/server/api.js';
import { RUN_ENV_SETTINGS } from '../src/agent/explore-request.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

/* ─── pure: the settings payload never carries a secret ─── */
const SECRET_KEY = 'sk-ant-secret-must-not-leak';
const TOKEN = 'settings-token-must-not-leak';
const pure = gatewaySettings({ root: '/tmp/x', token: TOKEN, gateway: { host: '127.0.0.1', port: 1 } }, { ANTHROPIC_API_KEY: SECRET_KEY, QA_CORE_GATEWAY_TOKEN: TOKEN, QA_CORE_COST_CEILING: '3' } as NodeJS.ProcessEnv);
const pureText = JSON.stringify(pure);
check('A. gatewaySettings reports set/not set for the API key and the token, never their values', pure.token_set === true && pure.api_key_set === true && !pureText.includes(SECRET_KEY) && !pureText.includes(TOKEN));
check('A2. run settings come from the env passed in, with their origin', (pure.run_settings as Array<{ name: string; value: string; fromEnv: boolean }>).find((s) => s.name === 'QA_CORE_COST_CEILING')?.value === '3' && (pure.run_settings as Array<{ fromEnv: boolean }>).filter((s) => !s.fromEnv).length === RUN_ENV_SETTINGS.length - 1);
check('A3. without keys the payload says not set', gatewaySettings({ root: '/tmp/x', token: '' }, {} as NodeJS.ProcessEnv).api_key_set === false && gatewaySettings({ root: '/tmp/x', token: '' }, {} as NodeJS.ProcessEnv).token_set === false);

/* ─── gateway ─── */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-settings-'));
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
const repo = process.cwd();
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.'); process.exit(1); }
const PORT = 18795;
const gw = spawn('npx', ['tsx', path.join(repo, 'src', 'server', 'gateway.ts')], {
  cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, QA_CORE_GATEWAY_PORT: String(PORT), QA_CORE_GATEWAY_TOKEN: TOKEN, QA_CORE_DASHBOARD_DIST: dist, QA_CORE_DB_PATH: path.join(root, 'data', 'qa-core.sqlite'), ANTHROPIC_API_KEY: SECRET_KEY, QA_CORE_COST_CEILING: '3', QA_CORE_EXPLORER_MODEL: 'claude-opus-4-7' },
});
const killGw = (): void => { if (gw.pid) { try { process.kill(-gw.pid, 'SIGKILL'); } catch { /* gone */ } } };
process.on('exit', killGw);
process.on('uncaughtException', (err) => { console.error(err); killGw(); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error(err); killGw(); process.exit(1); });
let gwLog = '';
gw.stdout.on('data', (c) => { gwLog += String(c); });
gw.stderr.on('data', (c) => { gwLog += String(c); });
const deadline = Date.now() + 60_000;
while (!/listening on/.test(gwLog) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
check('B. gateway boots', /listening on http/.test(gwLog), gwLog.slice(0, 300));
const base = `http://127.0.0.1:${PORT}`;
const auth = { Authorization: `Bearer ${TOKEN}` };

/* ─── API ─── */
const res = await fetch(`${base}/api/settings`, { headers: auth });
const text = await res.text();
const settings = JSON.parse(text) as { run_settings: Array<{ name: string; value: string; fromEnv: boolean }>; output_root: string; gateway: { host: string; port: number }; token_set: boolean; api_key_set: boolean };
check('C. /api/settings needs the token', (await fetch(`${base}/api/settings`)).status === 401);
check('D. /api/settings reads the process: ceiling 3 from env, explorer model from env, the others built-in defaults', settings.run_settings.length === RUN_ENV_SETTINGS.length && settings.run_settings.find((s) => s.name === 'QA_CORE_COST_CEILING')?.value === '3' && settings.run_settings.find((s) => s.name === 'QA_CORE_COST_CEILING')?.fromEnv === true && settings.run_settings.find((s) => s.name === 'QA_CORE_REPAIR_RESERVE')?.fromEnv === false && settings.run_settings.find((s) => s.name === 'QA_CORE_REPAIR_RESERVE')?.value === '0.15', JSON.stringify(settings.run_settings));
check('E. output root, gateway host and port, token set, API key set', settings.output_root === path.join(fs.realpathSync(root), 'output') && settings.gateway.host === '127.0.0.1' && settings.gateway.port === PORT && settings.token_set === true && settings.api_key_set === true, JSON.stringify({ o: settings.output_root, g: settings.gateway }));
check('F. no secret value in the response', !text.includes(SECRET_KEY) && !text.includes(TOKEN));
const parsed = await (await fetch(`${base}/api/command/parse`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '/explore https://shop.example/ --max-steps 70', lang: 'ts', env: { QA_CORE_MAX_STEPS: '55', QA_CORE_REPAIR_RESERVE: '0.2' } }) })).json() as { ok: boolean; request: { env: Record<string, string> } };
check('G. session overrides merge under the text flags through the one parser: text --max-steps wins, the reserve override applies', parsed.ok && parsed.request.env.QA_CORE_MAX_STEPS === '70' && parsed.request.env.QA_CORE_REPAIR_RESERVE === '0.2', JSON.stringify(parsed));
const badEnv = await (await fetch(`${base}/api/command/parse`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '/explore https://shop.example/', lang: 'ts', env: { ANTHROPIC_API_KEY: 'x' } }) })).json() as { ok: boolean; error?: string };
check('H. an override outside the per-run allowlist is rejected by the parser', badEnv.ok === false && /not a per-run setting/.test(badEnv.error ?? ''));

/* ─── page ─── */
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}/settings#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="run-setting"]');
const shown = await page.evaluate(() => ({
  rows: Array.from(document.querySelectorAll('[data-testid="run-setting"]')).map((r) => ({ name: r.getAttribute('data-name'), def: r.querySelector('[data-testid="setting-default"]')?.textContent })),
  token: document.querySelector('[data-testid="setting-token"]')?.textContent, key: document.querySelector('[data-testid="setting-api-key"]')?.textContent,
  gateway: document.querySelector('[data-testid="setting-gateway"]')?.textContent, body: document.body.textContent ?? '',
}));
check('I. page: every run setting with its gateway default; token and API key as set; gateway host:port', shown.rows.length === RUN_ENV_SETTINGS.length && shown.rows.find((r) => r.name === 'QA_CORE_COST_CEILING')?.def === '3' && shown.token === 'set' && shown.key === 'set' && shown.gateway === `127.0.0.1:${PORT}`, JSON.stringify(shown.rows));
check('J. page: no secret in the page text', !shown.body.includes(SECRET_KEY) && !shown.body.includes(TOKEN));
check('K. page: the clear button is disabled with no overrides', await page.isDisabled('[data-testid="clear-overrides"]'));
await page.fill('[data-testid="run-setting"][data-name="QA_CORE_MAX_STEPS"] [data-testid="setting-override"]', '55');
await page.waitForSelector('[data-testid="override-badge"]');
check('L. page: an override shows its badge and enables the clear button', (await page.$$('[data-testid="override-badge"]')).length === 1 && !(await page.isDisabled('[data-testid="clear-overrides"]')));
await page.click('a[href="/terminal"]');
await page.waitForSelector('[data-testid="composer"]');
await page.fill('[data-testid="f-url"]', 'https://shop.example/');
await page.waitForSelector('[data-testid="override-chip"]');
await page.waitForSelector('[data-testid="parsed-request"]', { state: 'attached' });
await page.waitForFunction(() => /QA_CORE_MAX_STEPS/.test(document.querySelector('[data-testid="parsed-request"]')?.textContent ?? ''));
const term = await page.evaluate(() => ({ chips: Array.from(document.querySelectorAll('[data-testid="override-chip"]')).map((c) => c.textContent ?? ''), parsed: JSON.parse(document.querySelector('[data-testid="parsed-request"]')?.textContent ?? '{}') as { env?: Record<string, string> } }));
check('M. Terminal: the override shows as a "session override" chip and is in the gateway-parsed request env', term.chips.length === 1 && /session override/.test(term.chips[0]!) && /max steps = 55/.test(term.chips[0]!) && term.parsed.env?.QA_CORE_MAX_STEPS === '55', JSON.stringify(term));
await page.click('a[href="/settings"]');
await page.waitForSelector('[data-testid="clear-overrides"]');
await page.click('[data-testid="clear-overrides"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="override-badge"]').length === 0);
await page.click('a[href="/terminal"]');
await page.waitForSelector('[data-testid="composer"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="override-chip"]').length === 0);
check('N. one button clears every override; the Terminal chip is gone', (await page.$$('[data-testid="override-chip"]')).length === 0);
// A real reload with the token in the hash (client-side routing dropped it), then wait for the composer.
await page.goto(`${base}/terminal#token=${TOKEN}`);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="composer"]');
check('O. overrides live in this tab\'s session only: after clearing nothing comes back on reload', (await page.$$('[data-testid="override-chip"]')).length === 0);
check('P. zero console errors', errors.filter((e) => !/404|WebSocket/.test(e)).length === 0, errors.join(' | '));

await browser.close();
killGw();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: Settings reads the gateway process, never shows a secret, and session overrides ride each command as per-run env through the one parser.');
