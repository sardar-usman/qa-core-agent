import fs from 'node:fs';
import path from 'node:path';
import { envCredentialValues, maskString } from '../agent/credential-leak.js';

/**
 * The CLI's own copy of its console (invariant 75): every line it prints to
 * stdout and stderr, from start to end, written to console.log in the run
 * folder. Run 59540f's folder had no console.log, so the preflight result,
 * the map reuse line, Rule coverage and Cost existed in no artifact.
 *
 * The capture wraps both streams' write(). Lines printed before the run
 * folder is known are buffered and flushed when the CLI attaches the folder.
 * Every line is masked with the run-report's credential redaction
 * (maskString over the env's test-account values, invariant 70) before it
 * reaches the file, and is appended synchronously, so a process.exit on any
 * path (ceiling stop, billing or API error, SIGINT, login preflight stop)
 * finds the file complete; the unterminated tail is written on process exit.
 * A carriage-return status (the thinking and spend ticker) is its own line in
 * the file. console.log is a run artifact, never part of the framework zip
 * (RUN_ARTIFACTS in zip-framework.ts).
 */

export const CONSOLE_LOG_FILENAME = 'console.log';

export interface ConsoleCapture {
  /**
   * Start writing to <runDir>/console.log: the lines buffered so far first,
   * then every later line as it is printed. `append` keeps an existing file
   * (a resumed run continues its folder's log); otherwise it starts fresh.
   * Returns the file path.
   */
  attach(runDir: string, opts?: { append?: boolean }): string;
  /**
   * Stop writing to the file because the run folder is about to be removed
   * (a run that planned nothing keeps no folder). Later lines are still
   * printed, never written.
   */
  detach(): void;
  /** Write every unterminated line now (also runs on process exit). */
  flush(): void;
  /** Put the streams' own write() back. */
  restore(): void;
  /** The file being written, or null before attach and after detach. */
  readonly file: string | null;
}

type Writable = { write: (...args: never[]) => boolean };

/**
 * Wrap the two streams. Exported for smoke-console-log, which drives it with
 * fixture streams; the CLI starts it through console-capture.ts, imported
 * first so nothing prints before the copy starts.
 */
export function startConsoleCapture(opts: { stdout?: Writable; stderr?: Writable; env?: NodeJS.ProcessEnv } = {}): ConsoleCapture {
  const streams: Writable[] = [opts.stdout ?? (process.stdout as unknown as Writable), opts.stderr ?? (process.stderr as unknown as Writable)];
  const env = opts.env ?? process.env;
  const pending: string[] = [];
  const partial = new Map<Writable, string>();
  // A chunk that ended in \r closed its line at once (the ticker must not
  // wait for the next write, or it lands after later lines); a \n opening
  // the stream's next chunk is then the second half of \r\n, not a line.
  const endedWithCR = new Set<Writable>();
  let file: string | null = null;
  let detached = false;
  const originals = streams.map((s) => s.write);
  // The original stderr writer, for the one line that says the copy stopped.
  const rawErr = (text: string): void => { (originals[1] as unknown as (t: string) => boolean).call(streams[1], text); };

  const writeLines = (lines: string[]): void => {
    if (detached || lines.length === 0) return;
    if (file === null) {
      pending.push(...lines);
      return;
    }
    const secrets = envCredentialValues(env);
    try {
      fs.appendFileSync(file, lines.map((l) => `${maskString(l, secrets)}\n`).join(''));
    } catch (err) {
      // Loud, never a silently shorter log: say so on the real stderr and stop.
      const lost = file;
      file = null;
      detached = true;
      rawErr(`console.log copy stopped: could not write ${lost} (${(err as Error).message}); the lines after this one are not in the file.\n`);
    }
  };

  /** Split a stream's text into finished lines; \n, \r\n and a lone \r each end one. */
  const record = (stream: Writable, chunk: unknown, encoding: unknown): void => {
    const text = typeof chunk === 'string'
      ? chunk
      : chunk instanceof Uint8Array ? Buffer.from(chunk).toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8') : String(chunk);
    const skipLeadingLf = endedWithCR.has(stream) && text.startsWith('\n');
    endedWithCR.delete(stream);
    const buf = (partial.get(stream) ?? '') + (skipLeadingLf ? text.slice(1) : text);
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (c === '\n') {
        lines.push(buf.slice(start, i));
        start = i + 1;
      } else if (c === '\r') {
        lines.push(buf.slice(start, i));
        if (buf[i + 1] === '\n') i++;
        else if (i + 1 === buf.length) endedWithCR.add(stream);
        start = i + 1;
      }
    }
    partial.set(stream, buf.slice(start));
    writeLines(lines);
  };

  streams.forEach((s, i) => {
    const orig = originals[i]!;
    s.write = function (this: unknown, ...args: unknown[]): boolean {
      try {
        record(s, args[0], args[1]);
      } catch (err) {
        // The copy never breaks the console itself, and never loses a line
        // quietly: the file and the real stderr both say so.
        const note = `console.log copy: a printed chunk could not be recorded (${(err as Error).message})`;
        writeLines([`[${note}]`]);
        rawErr(`${note}\n`);
      }
      return (orig as unknown as (...a: unknown[]) => boolean).apply(this, args);
    } as Writable['write'];
  });

  const capture: ConsoleCapture = {
    attach(runDir, attachOpts = {}) {
      fs.mkdirSync(runDir, { recursive: true });
      const target = path.join(runDir, CONSOLE_LOG_FILENAME);
      if (!attachOpts.append) fs.writeFileSync(target, '');
      file = target;
      detached = false;
      const buffered = pending.splice(0, pending.length);
      writeLines(buffered);
      return target;
    },
    detach() {
      file = null;
      detached = true;
      pending.length = 0;
    },
    flush() {
      const tails: string[] = [];
      for (const s of streams) {
        const tail = partial.get(s) ?? '';
        partial.set(s, '');
        if (tail.length > 0) tails.push(tail);
      }
      writeLines(tails);
    },
    restore() {
      streams.forEach((s, i) => { s.write = originals[i]!; });
    },
    get file() {
      return file;
    },
  };
  return capture;
}
