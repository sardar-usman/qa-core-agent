import fs from 'node:fs';
import path from 'node:path';
import { compactTimestamp } from '../agent/output-layout.js';
import { srsFileName, validateSrsUpload, type SrsUpload } from './run-explore.js';

/**
 * Project-level requirements document (dashboard v2 plan, PR E). One current
 * SRS per project, stored under output/<project-slug>/srs/<original name>
 * with its upload time in srs.json next to it. Replacing it renames the
 * previous file with its own upload time, so no SRS a run used is ever lost.
 * A run that uses the project SRS still gets its own copy in the run folder
 * (the Terminal sends it as the upload the request layer saves), so a run
 * folder stays self-contained. Files are truth: this module reads the
 * folder, never the index.
 */

export const PROJECT_SRS_DIR = 'srs';
const STATE_FILE = 'srs.json';

export interface ProjectSrsRecord {
  /** File name as stored under the srs directory. */
  file: string;
  /** The name the person uploaded (equals `file` for the current one). */
  original_name: string;
  /** Path relative to the project root, forward slashes. */
  path: string;
  uploaded_at: string;
  size: number;
}

export interface ProjectSrsState {
  current: ProjectSrsRecord | null;
  /** Older uploads, newest first, each renamed with its upload time. */
  previous: ProjectSrsRecord[];
}

export function projectSrsDir(root: string, slug: string): string {
  return path.join(root, 'output', slug, PROJECT_SRS_DIR);
}

function rel(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join('/');
}

/** The project's SRS state as recorded in its folder; empty when none was uploaded. */
export function readProjectSrs(root: string, slug: string): ProjectSrsState {
  const file = path.join(projectSrsDir(root, slug), STATE_FILE);
  if (!fs.existsSync(file)) return { current: null, previous: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectSrsState;
    const current = parsed.current && fs.existsSync(path.join(root, parsed.current.path)) ? parsed.current : null;
    return { current, previous: Array.isArray(parsed.previous) ? parsed.previous : [] };
  } catch {
    return { current: null, previous: [] };
  }
}

/**
 * Store an upload as the project's current SRS. Validates with the same rule
 * the Terminal and the run use (four types, 2 MB). The previous current file,
 * if any, is renamed to <stem>.<its upload time><ext> and kept in `previous`.
 */
export function storeProjectSrs(root: string, slug: string, upload: SrsUpload, now: Date = new Date()): ProjectSrsState {
  const bytes = Buffer.from(upload.base64 ?? '', 'base64');
  const err = validateSrsUpload(upload.name, bytes.length);
  if (err) throw new Error(err);
  const dir = projectSrsDir(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const state = readProjectSrs(root, slug);
  const previous = [...state.previous];
  if (state.current) {
    const cur = state.current;
    const ext = path.extname(cur.file);
    const stem = cur.file.slice(0, cur.file.length - ext.length);
    const stamp = compactTimestamp(new Date(cur.uploaded_at));
    let renamed = `${stem}.${stamp}${ext}`;
    let n = 1;
    while (fs.existsSync(path.join(dir, renamed))) renamed = `${stem}.${stamp}-${++n}${ext}`;
    fs.renameSync(path.join(dir, cur.file), path.join(dir, renamed));
    previous.unshift({ ...cur, file: renamed, path: rel(root, path.join(dir, renamed)) });
  }
  const file = srsFileName(upload.name);
  fs.writeFileSync(path.join(dir, file), bytes);
  const current: ProjectSrsRecord = { file, original_name: path.basename(upload.name), path: rel(root, path.join(dir, file)), uploaded_at: now.toISOString(), size: bytes.length };
  const next: ProjectSrsState = { current, previous };
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(next, null, 2));
  return next;
}

/** The current project SRS as an upload payload, so a run copies it into its own folder like a per-run attach. */
export function projectSrsUploadFor(root: string, slug: string): SrsUpload | null {
  const state = readProjectSrs(root, slug);
  if (!state.current) return null;
  const file = path.join(root, state.current.path);
  if (!fs.existsSync(file)) return null;
  return { name: state.current.original_name, base64: fs.readFileSync(file).toString('base64') };
}
