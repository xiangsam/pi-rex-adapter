import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { atomicJson, readJson, piArgs } from './core.mjs';
import { loadConfig } from './config.mjs';
import { shellStart, shellEnd } from './shell-display.mjs';

// New launches use this supervisor only for shell jobs. Keep the Pi branch for
// legacy manifests; new Agent/BTW panes exec Pi directly from Rex.
const dir = process.argv[2];
const run = await readJson(join(dir, 'run.json'));
const extension = fileURLToPath(new URL('./index.mjs', import.meta.url));
const shell = run.kind === 'shell';
const display = shell && process.stdout.isTTY;
const language = display ? (await loadConfig(run.configCwd || run.cwd)).config.language : 'en';
const startedAt = Date.now();
const script = !shell && /\.[cm]?js$/.test(run.piBin);
await atomicJson(join(dir, 'activity.json'), { task: 'running', process: 'running', at: new Date().toISOString() });
const grouped = shell && process.platform !== 'win32';
const child = spawn(shell ? (run.shell || '/bin/sh') : script ? process.execPath : run.piBin,
  shell ? ['-c', run.task] : [...(script ? [run.piBin] : []), ...piArgs(run, extension)], {
  cwd: run.cwd, stdio: shell ? ['ignore', 'pipe', 'pipe'] : 'inherit', detached: grouped,
  env: { ...process.env,
    ...(shell && process.env.PYTHONUNBUFFERED === undefined ? { PYTHONUNBUFFERED: '1' } : {}),
    PATH: run.path || process.env.PATH, PI_REX_RUN_DIR: dir },
});
let outputTail = '', outputError, escalation;
const outputAbort = new AbortController();
const log = shell ? createWriteStream(join(dir, 'output.log'), { mode: 0o600 }) : undefined;
function kill(signal) {
  try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
  catch (error) { if (error.code !== 'ESRCH') outputError ||= error.message; }
}
function terminate(signal) {
  kill(signal);
  if (!escalation) { escalation = setTimeout(() => { kill('SIGKILL'); outputAbort.abort(); }, 2000); escalation.unref(); }
}
function failedOutput(error) {
  if (outputError) return;
  outputError = `Output write failed: ${error.message}`;
  outputAbort.abort(); terminate('SIGTERM');
  child.stdout?.destroy(); child.stderr?.destroy();
  log?.destroy();
}
async function write(sink, text) {
  if (sink.destroyed) throw new Error('Output stream closed');
  if (!sink.write(text)) await once(sink, 'drain', { signal: outputAbort.signal });
}
const pumps = [];
if (shell) {
  log.on('error', failedOutput);
  process.stdout.on('error', failedOutput); process.stderr.on('error', failedOutput);
  const header = display ? write(process.stdout, shellStart(run, language)).catch(failedOutput) : Promise.resolve();
  for (const [stream, terminal] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8');
    pumps.push((async () => {
      try {
        await header;
        for await (const text of stream) {
          outputTail = (outputTail + text).slice(-16000);
          // Await both sinks before consuming more data; bound buffering even if
          // the terminal or disk is slow. Full logs remain on disk by design.
          await Promise.all([write(log, text), write(terminal, text)]);
        }
      } catch (error) { failedOutput(error); }
    })());
  }
}
let recorded = false;
async function finish(code, error, signal) {
  if (recorded) return;
  recorded = true;
  await Promise.all(pumps);
  if (log && !log.destroyed) {
    const flushed = finished(log);
    log.end();
    try { await flushed; } catch (error) { failedOutput(error); }
  }
  if (outputError) { error = [error, outputError].filter(Boolean).join('; '); code = code || 1; }
  if (display && !outputError) {
    try { await write(process.stdout, shellEnd(run, { code, error, signal,
      elapsedMs: Date.now() - startedAt, hasOutput: Boolean(outputTail) }, language)); }
    catch (displayError) { failedOutput(displayError); error = [error, outputError].filter(Boolean).join('; '); code = code || 1; }
  }
  clearTimeout(escalation);
  if (shell) await atomicJson(join(dir, 'result.json'), {
    text: outputTail || '(no output)', status: code === 0 ? 'completed' : 'failed', createdAt: new Date().toISOString(),
  });
  await atomicJson(join(dir, 'exit.json'), { code, error, at: new Date().toISOString() });
  process.exitCode = code ?? 1;
}
child.on('error', error => { void finish(1, error.message); });
child.on('close', (code, signal) => { void finish(code, signal ? `Terminated by ${signal}` : undefined, signal); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => terminate(signal));
