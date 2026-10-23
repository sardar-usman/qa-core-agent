/**
 * Run discovery alone against a site, $0, read only:
 *
 *   npx tsx scripts/discover-site.ts <url> [--map <requirements-map.json>] [--features a,b]
 *
 * Runs discoverPages (the ladder the runtime runs: SRS URLs, --urls is not
 * offered here, sitemap as a seed, the fetch crawl, the browser crawl) and
 * the robots-skip feature check (invariant 75), prints the method, every
 * candidate with its source, the robots skips, the feature lines and the
 * warning lines, then exits.
 *
 * No model call. The requirements map is read from a requirements-map.json
 * file; an SRS document (.md, .txt, .pdf, .docx) would need the Haiku map
 * build, so it is refused before anything runs. The feature list is the
 * deterministic comma split the CLI uses. ANTHROPIC_API_KEY is removed from
 * this process's environment before discovery starts, so no client could
 * call a model even by mistake. No form is submitted (discovery only loads
 * pages and reads their links), and nothing is written: no run folder, no
 * discovery.json, nothing under output/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverPages, discoveryFeatureList, robotsBlockedFeatures } from '../src/agent/discovery.js';
import { featureTokenMap, type RequirementsMap } from '../src/agent/requirements.js';
import { parseCommaSeparated } from '../src/agent/parse-features.js';

const USAGE = 'usage: npx tsx scripts/discover-site.ts <url> [--map <requirements-map.json>] [--features a,b]';

function refuse(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

const args = process.argv.slice(2);
let url: string | undefined;
let mapPath: string | undefined;
let featuresArg: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--map' || a === '--features') {
    const v = args[i + 1];
    if (!v || v.startsWith('--')) refuse(`${a} expects a value.`);
    if (a === '--map') mapPath = v; else featuresArg = v;
    i++;
  } else if (a.startsWith('--')) {
    refuse(`unknown option ${a}.`);
  } else if (!url) {
    url = a;
  } else {
    refuse(`unexpected argument ${a}.`);
  }
}
if (!url) refuse('a URL is required.');
let entry: URL;
try {
  entry = new URL(url);
  if (entry.protocol !== 'http:' && entry.protocol !== 'https:') throw new Error('not http or https');
} catch {
  refuse(`"${url}" is not an http or https URL.`);
}

// The map must already exist as JSON: building one from an SRS is a model call.
let map: RequirementsMap | undefined;
if (mapPath) {
  if (!mapPath.toLowerCase().endsWith('.json')) {
    refuse(`--map takes a requirements-map.json; ${path.basename(mapPath)} would need a model call to build a map, which this script never makes.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  } catch (err) {
    refuse(`--map ${mapPath} could not be read as JSON (${(err as Error).message}).`);
  }
  const candidate = raw as Partial<RequirementsMap>;
  if (!candidate || !Array.isArray(candidate.features)) refuse(`--map ${mapPath} has no features array; it is not a requirements-map.json.`);
  map = { features: candidate.features, roles: Array.isArray(candidate.roles) ? candidate.roles : [], truncated: candidate.truncated === true };
}
const features = featuresArg ? parseCommaSeparated(featuresArg) : [];

// No client in this process can reach a model.
delete process.env.ANTHROPIC_API_KEY;

const disc = await discoverPages({ entryUrl: entry.toString(), ...(map ? { requirements: map } : {}), ...(features.length > 0 ? { features } : {}) });
const featureList = discoveryFeatureList(map, features);
const blocked = robotsBlockedFeatures({
  entryUrl: entry.toString(),
  features: featureList,
  candidates: disc.pages,
  robotsSkipped: disc.robotsSkipped,
  ...(map ? { featureTokens: featureTokenMap(map) } : {}),
});

const pathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return u; } };
console.log(`discover-site: ${entry.toString()}`);
console.log(`method: ${disc.method}`);
console.log(`candidates: ${disc.pages.length}`);
for (const p of disc.pages) {
  const extra = [p.source, ...(p.volatile ? ['volatile'] : []), ...(p.linkedFrom ? [`linked from ${pathOf(p.linkedFrom)}`] : [])];
  console.log(`  ${p.url}  (${extra.join(', ')})`);
}
if (disc.robotsSkipped) {
  console.log(`robotsSkipped: ${disc.robotsSkipped.length}`);
  for (const s of disc.robotsSkipped) console.log(`  ${s.path}  (Disallow: ${s.rule})`);
} else {
  console.log('robotsSkipped: not recorded (no remote rung examined a link; the warnings say why)');
}
const featureSource = map && featureList.length > 0 ? `from the requirements map ${mapPath}` : features.length > 0 ? 'from --features' : 'none given';
console.log(`features: ${featureList.length > 0 ? featureList.join(', ') : '(none)'} (${featureSource})`);
for (const b of blocked) console.log(b.line);
if (featureList.length > 0 && blocked.length === 0) console.log('no feature is kept out of reach by robots.txt');
console.log(`warnings: ${disc.warnings.length}`);
for (const w of disc.warnings) console.log(`  ${w}`);
