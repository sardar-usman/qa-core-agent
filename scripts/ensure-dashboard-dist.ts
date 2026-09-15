import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Runs before `npm run gateway`: build dashboard/dist when it is missing so
 * the gateway always has an app to serve at /. Installs the dashboard's
 * dependencies first when they are missing. A failed build is reported and
 * the gateway still starts (it serves a build hint at /).
 */
const root = process.cwd();
const dashboard = path.join(root, 'dashboard');
const dist = path.join(dashboard, 'dist', 'index.html');

if (fs.existsSync(dist)) process.exit(0);
if (!fs.existsSync(path.join(dashboard, 'package.json'))) process.exit(0);
try {
  if (!fs.existsSync(path.join(dashboard, 'node_modules'))) {
    console.log('dashboard: installing dependencies (first run)…');
    execSync('npm install', { cwd: dashboard, stdio: 'inherit' });
  }
  console.log('dashboard: dist missing, building…');
  execSync('npm run build', { cwd: dashboard, stdio: 'inherit' });
} catch (err) {
  console.error(`dashboard: build failed (${(err as Error).message}). The gateway will serve a build hint at /.`);
}
