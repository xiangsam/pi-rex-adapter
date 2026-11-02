import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, listRuns, readJson } from './core.mjs';
import { DEFAULT_CONFIG } from './config.mjs';

// Survives extension reload in the same Pi process. Only layout mutations for
// the same parent are serialized; the launched processes remain independent.
const locks = globalThis[Symbol.for('pi-rex-adapter.layout-locks')] ??= new Map();
export async function withLayoutLock(root, work) {
  const previous = locks.get(root) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  locks.set(root, next);
  try { return await next; } finally { if (locks.get(root) === next) locks.delete(root); }
}

export async function existingBtw(root, client, options) {
  const { signal } = options;
  signal?.throwIfAborted();
  const candidates = (await listRuns(root)).filter(r => r.kind === 'btw' && !r.closed && r.rexSession === options.rexSession);
  for (const run of candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const exit = await readJson(join(run.dir, 'exit.json'));
    if (!run.block) throw new Error(`BTW launch ${run.id} is unresolved; inspect Rex before retrying.`);
    // Never interpret a connection/inspection failure as permission to duplicate.
    const actual = await client.inspect(run, signal);
    signal?.throwIfAborted();
    run.window = actual.window;
    if (exit && options.task) {
      await client.control(run, 'close', signal);
      run.closed = true; run.completedBeforeClose = true;
      await atomicJson(join(run.dir, 'run.json'), run);
      continue;
    }
    if (options.task) {
      if (run.inputProtocol !== 1) throw new Error('Reload this existing BTW Pi to enable question delivery, or close it and start a new BTW.');
      if ((options.cwd && options.cwd !== run.cwd) || (options.model && options.model !== run.model)) {
        throw new Error('Existing BTW uses another cwd/model. Close it before starting a new conversation.');
      }
      const request = randomUUID();
      signal?.throwIfAborted();
      await atomicJson(join(run.dir, `input-${request}.json`), { id: request, text: options.task, createdAt: new Date().toISOString() });
      return { id: run.id, block: run.block, window: run.window, reused: true, request, status: 'queued', artifacts: run.dir };
    }
    await client.control(run, 'focus', signal);
    return { id: run.id, block: run.block, window: run.window, reused: true, status: 'focused', artifacts: run.dir };
  }
}

export async function choosePlacement(root, client, run, signal, panesPerTab = DEFAULT_CONFIG.panesPerTab) {
  signal?.throwIfAborted();
  if (run.kind === 'btw') {
    const parent = await client.inspect({ rexSession: run.rexSession, block: run.anchor }, signal);
    return { role: 'btw', mode: 'split', anchor: run.anchor, direction: 'right', window: parent.window };
  }
  const role = run.kind === 'agent' ? 'agents' : 'jobs';
  const members = (await listRuns(root)).filter(r => r.id !== run.id && r.layout?.role === role && r.rexSession === run.rexSession);
  const groups = new Map();
  const occupancy = new Map();
  let maxPage = 0;
  for (const member of members) {
    if (member.closed) continue;
    maxPage = Math.max(maxPage, member.layout.page || 1);
    if (!member.block) throw new Error(`Layout acquisition ${member.id} is unresolved; inspect Rex before launching more ${role}.`);
    const actual = await client.inspect(member, signal);
    signal?.throwIfAborted();
    occupancy.set(actual.window, (occupancy.get(actual.window) || 0) + 1);
    // The user owns subsequent layout changes. Never move a block back or add
    // companions beside it after it has left its original managed window.
    if (actual.window !== member.layout.window) continue;
    const group = groups.get(actual.window) || { page: member.layout.page, members: [] };
    group.members.push(member);
    groups.set(actual.window, group);
  }
  for (const [window, group] of [...groups].sort((a, b) => a[1].page - b[1].page)) {
    if (occupancy.get(window) < panesPerTab) return { role, mode: 'split', window, page: group.page,
      anchor: group.members[0].block, direction: 'right' };
  }
  const page = maxPage + 1;
  const title = `${role === 'agents' ? 'Agents' : 'Jobs'}${page > 1 ? ` ${page}` : ''} · ${run.owner.slice(0, 8)}`;
  return { role, mode: 'window', page, title };
}
