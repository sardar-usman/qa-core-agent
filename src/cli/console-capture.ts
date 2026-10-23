import { startConsoleCapture } from './console-log.js';

/**
 * Imported FIRST by src/cli/explore.ts: the console copy (invariant 75)
 * starts before any other module is evaluated, so no line the CLI prints is
 * missed. The CLI attaches the run folder once it is known; the unterminated
 * tail is written when the process exits, on every path.
 */
export const consoleCapture = startConsoleCapture();
process.on('exit', () => consoleCapture.flush());
