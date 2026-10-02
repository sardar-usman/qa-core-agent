/**
 * Capture readiness in the EMITTED framework (invariant 39).
 *
 * Replay polls a count capture's target to at least one match before the
 * read (`awaitCaptureReady` in replay.ts). Run 44cb3d's emitted spec read the
 * card count immediately after the goto, got 0 before the list rendered, and
 * the less compare could not hold ("Expected: < 0 Received: 2"); with a
 * greater relation a too-early 0 passes for the wrong reason. The emitted spec
 * now reads the page the way replay does, through a helper shipped in
 * helpers/assertions (POM) or inlined (single-file spec). One source for the
 * helper text in both languages, so the two emitters cannot drift.
 */
import type { TraceStep } from './trace.js';

/**
 * True when a count capture needs the readiness grace, exactly where replay
 * applies it: a later assert_compare reads the var (`relations` is
 * replay's relationsByVarName) with a relation other than absent. Text and
 * attribute captures need nothing: locator.textContent() and
 * locator.getAttribute() auto-wait for the element in Playwright.
 */
export function captureWaitNeeded(step: Extract<TraceStep, { kind: 'capture' }>, relations: Map<string, string>): boolean {
  if (step.source !== 'count') return false;
  const relation = relations.get(step.varName);
  return relation !== undefined && relation !== 'absent';
}

const DOC_LINES = [
  'Capture readiness grace: poll the locator until it matches at least one',
  'element or the timeout passes, then return. Never throws and never asserts:',
  'a legitimately empty baseline reads 0 after the wait. Mirrors the agent\'s',
  'replay engine, so the shipped spec reads the page the way the recording did.',
];

const BODY_LINES = [
  '  const deadline = Date.now() + timeoutMs;',
  '  while ((await locator.count()) === 0) {',
  '    if (Date.now() >= deadline) return;',
  '    await new Promise((resolve) => setTimeout(resolve, 100));',
  '  }',
];

/** The typed export for helpers/assertions.ts. */
export function renderAwaitCaptureReadyTs(): string {
  return [
    '/**',
    ...DOC_LINES.map((l) => ` * ${l}`),
    ' */',
    'export async function awaitCaptureReady(locator: Locator, timeoutMs: number): Promise<void> {',
    ...BODY_LINES,
    '}',
  ].join('\n');
}

/** The CommonJS + JSDoc function for helpers/assertions.js (exported by the module.exports line). */
export function renderAwaitCaptureReadyJs(): string {
  return [
    '/**',
    ...DOC_LINES.map((l) => ` * ${l}`),
    " * @param {import('@playwright/test').Locator} locator",
    ' * @param {number} timeoutMs',
    ' * @returns {Promise<void>}',
    ' */',
    'async function awaitCaptureReady(locator, timeoutMs) {',
    ...BODY_LINES,
    '}',
  ].join('\n');
}

/** The untyped inline copy for the single-file spec (transcriber.ts), like inlineParseNumberFn. */
export function inlineAwaitCaptureReadyFn(): string {
  return [
    ...DOC_LINES.map((l) => `// ${l}`),
    'async function awaitCaptureReady(locator, timeoutMs) {',
    ...BODY_LINES,
    '}',
  ].join('\n');
}
