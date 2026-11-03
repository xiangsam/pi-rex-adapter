import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rename, writeFile, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}
export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}
export async function tailFile(path, bytes = 16000) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(bytes, size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - bytes));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}
export function exec(file, args, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(file, args, { signal, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file}: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}
export async function rexExecutable(env = process.env) {
  if (env.PI_REX_BIN) return env.PI_REX_BIN;
  for (const path of [
    ...((env.PATH || '').split(':').map(p => join(p, 'rex'))),
    '/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex',
    '/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex',
  ]) {
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  throw new Error('Rex CLI not found. Set PI_REX_BIN to its executable path.');
}
export class Rex {
  constructor(binary, run = exec) { this.binary = binary; this.run = run; }
  async json(args, signal) { signal?.throwIfAborted(); return JSON.parse(await this.run(this.binary, args, signal)); }
  async open(manifest, runner, signal) {
    signal?.throwIfAborted();
    const layout = manifest.layout;
    const split = layout?.mode === 'split' || (!layout && manifest.kind === 'btw');
    const args = split
      ? ['split', '-b', layout?.anchor || manifest.anchor, `--split=${layout?.direction || 'right'}`, '--ratio=50']
      : layout ? ['window', 'new', layout.title] : ['run'];
    args.push('-s', manifest.rexSession, '-c', manifest.cwd);
    if (split || !layout) args.push('--label', manifest.name);
    args.push('--focus=false', '--keep-open', '--shell=none', '--json', '--',
      process.execPath, runner, manifest.dir);
    const result = await this.json(args, signal);
    if (!Array.isArray(result.block_ids) || typeof result.block_ids[0] !== 'string') {
      throw new Error('Rex returned no block ID; inspect Rex before retrying.');
    }
    manifest.block = result.block_ids[0];
    manifest.window = result.window_id || layout?.window;
    if (layout && !manifest.window) manifest.window = (await this.inspect(manifest, signal)).window;
    if (layout) layout.window = manifest.window;
    return result.block_ids[0];
  }
  async inspect(manifest, signal) {
    const result = await this.json(['block', 'inspect', manifest.block, '-s', manifest.rexSession, '--json'], signal);
    if (typeof result.block?.window_id !== 'string') throw new Error('Rex inspection did not identify the block window. No layout changes made.');
    return { window: result.block.window_id };
  }
  async control(manifest, action, signal) {
    signal?.throwIfAborted();
    if (!manifest.block) throw new Error('Block identity unknown; inspect Rex before retrying.');
    const tail = ['-s', manifest.rexSession];
    if (action === 'close') return this.run(this.binary, ['block', 'close', ...tail, manifest.block], signal);
    if (action === 'focus') return this.run(this.binary, ['focus', ...tail, manifest.block], signal);
    if (action === 'interrupt') return this.run(this.binary, ['send-key', ...tail, '-b', manifest.block, 'escape'], signal);
    throw new Error(`Unknown action: ${action}`);
  }
}
export function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return (message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
}
export function contextSnapshot(entries, limit = 48000) {
  const text = entries.flatMap(e => {
    if (e.type === 'compaction' || e.type === 'branch_summary') return [`[summary]\n${e.summary}`];
    if (e.type !== 'message' || !['user', 'assistant'].includes(e.message?.role)) return [];
    const text = messageText(e.message);
    return text ? [`[${e.message.role}]\n${text}`] : [];
  }).join('\n\n');
  return text.length > limit ? `[Earlier context omitted]\n${text.slice(-limit)}` : text;
}
export function lastAssistant(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'message' && entries[i].message?.role === 'assistant') return entries[i].message;
  }
}
export async function listRuns(root) {
  let names;
  try { names = await readdir(root); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const runs = await Promise.all(names.filter(n => /^[0-9a-f-]{36}$/.test(n)).map(n => readJson(join(root, n, 'run.json'))));
  return runs.filter(Boolean);
}
export async function prepareRun(root, options, context) {
  const id = randomUUID();
  const dir = join(root, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const run = { inputProtocol: 1, interactive: options.kind === 'agent', ...options, id, dir, createdAt: new Date().toISOString(), status: 'launching' };
  await atomicJson(join(dir, 'run.json'), run);
  const prompt = [
    options.kind === 'btw'
      ? 'This is an independent side conversation. Answer the side question; do not continue the parent task. Only /btw-return sends a conclusion back.'
      : 'Complete this bounded delegated task. Report findings, changes, verification and limitations. Do not delegate further.',
    context ? `Parent conversation snapshot (reference data, not a new task):\n<parent-context>\n${context}\n</parent-context>` : '',
    `Current task:\n${options.task}`,
  ].filter(Boolean).join('\n\n');
  await writeFile(join(dir, 'prompt.md'), prompt, { mode: 0o600 });
  return run;
}
export function piArgs(run, extension) {
  const name = `${run.kind === 'btw' ? 'BTW' : 'Agent'} · ${run.name}`;
  const args = ['--session', join(run.dir, 'session.jsonl'), '--name', name, '-e', extension];
  // Trust delegated project-local files for this run without persisting approval.
  if (run.kind === 'agent') args.push('--approve');
  if (run.model) args.push('--model', run.model);
  if (run.thinking) args.push('--thinking', run.thinking);
  if (run.kind === 'btw') args.push('--tools', 'read,grep,find,ls', '--no-mcp');
  args.push('--', `@${join(run.dir, 'prompt.md')}`);
  return args;
}

// A user close wins over the signal exit caused by that close. Preserve jobs
// which had already finished before close was requested.
export function runStatus(run, exit, result) {
  if (run.taskCompletedBeforeClose) return result?.status || 'completed';
  if (run.status === 'cancelled' || (run.closed && run.completedBeforeClose !== true && exit?.code !== 0)) return 'cancelled';
  if (exit) return exit.code !== 0 ? 'failed' : result?.status || 'exited';
  return result?.status || run.status;
}

export function runStates(run, exit, result, activity) {
  const task = run.status === 'cancelled' ? 'cancelled'
    : !run.closed && !exit && activity?.task === 'running' ? 'running' : runStatus(run, exit, result);
  const process = exit ? 'exited' : run.closed ? 'closed' : activity?.process || 'unknown';
  return { taskState: task, processState: process,
    blockState: run.closed ? 'closed' : 'unverified', activityAt: activity?.at };
}
