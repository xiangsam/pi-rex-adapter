import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { atomicJson, readJson, piArgs } from './core.mjs';

// This wrapper runs in the Rex block, not in the parent Pi process.
const dir = process.argv[2];
const run = await readJson(join(dir, 'run.json'));
const extension = fileURLToPath(new URL('./index.mjs', import.meta.url));
const shell = run.kind === 'shell';
const script = !shell && /\.[cm]?js$/.test(run.piBin);
await atomicJson(join(dir, 'activity.json'), { task: 'running', process: 'running', at: new Date().toISOString() });
const grouped = shell && process.platform !== 'win32';
const child = spawn(shell ? (run.shell || '/bin/sh') : script ? process.execPath : run.piBin,
  shell ? ['-c', run.task] : [...(script ? [run.piBin] : []), ...piArgs(run, extension)], {
  cwd: run.cwd, stdio: shell ? ['ignore', 'pipe', 'pipe'] : 'inherit', detached: grouped,
  env: { ...process.env, PATH: run.path || process.env.PATH, PI_REX_RUN_DIR: dir },
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
  for (const [stream, terminal] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8');
    pumps.push((async () => {
      try {
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
async function finish(code, error) {
  if (recorded) return;
  recorded = true;
  await Promise.all(pumps);
  if (log && !log.destroyed) {
    const flushed = finished(log);
    log.end();
    try { await flushed; } catch (error) { failedOutput(error); }
  }
  clearTimeout(escalation);
  if (outputError) { error = [error, outputError].filter(Boolean).join('; '); code = code || 1; }
  if (shell) await atomicJson(join(dir, 'result.json'), {
    text: outputTail || '(no output)', status: code === 0 ? 'completed' : 'failed', createdAt: new Date().toISOString(),
  });
  await atomicJson(join(dir, 'exit.json'), { code, error, at: new Date().toISOString() });
  process.exitCode = code ?? 1;
}
child.on('error', error => { void finish(1, error.message); });
child.on('close', (code, signal) => { void finish(code, signal ? `Terminated by ${signal}` : undefined); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => terminate(signal));
