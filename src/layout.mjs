import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, listRuns, readJson, runStatus } from './core.mjs';
import { DEFAULT_CONFIG } from './config.mjs';

export { withLayoutLock } from './core.mjs';
import { missingBlock, recordLifecycle } from './lifecycle.mjs';

// Called under the parent's layout lock, only while choosing/reusing a pane.
// Keep ambiguous failures blocking; an exited process plus an explicitly absent
// block is enough to retire the stale record without sending another close.
async function inspectOrRetire(client, run, signal) {
  try { return await client.inspect(run, signal); }
  catch (error) {
    signal?.throwIfAborted();
    if (error.code !== 'REX_BLOCK_NOT_FOUND' || error.block !== run.block || error.rexSession !== run.rexSession) throw error;
    if (run.runtime === 'direct-pi' && missingBlock(error, run)) {
      await recordLifecycle(run, { closed: true }, signal);
      return undefined;
    }
    const [latest, exit, result] = await Promise.all(['run', 'exit', 'result'].map(name => readJson(join(run.dir, `${name}.json`))));
    signal?.throwIfAborted();
    if (!latest || latest.id !== run.id || latest.block !== run.block || latest.rexSession !== run.rexSession ||
        !exit || !(exit.code === null || Number.isInteger(exit.code))) throw error;
    Object.assign(run, latest, { closed: true, completedBeforeClose: true,
      resolvedAt: new Date().toISOString(), resolution: 'Rex confirmed block absent; process exit record exists.' });
    run.status = runStatus(run, exit, result);
    await atomicJson(join(run.dir, 'run.json'), run);
    return undefined;
  }
}

export async function existingBtw(root, client, options) {
  const { signal } = options;
  signal?.throwIfAborted();
  const candidates = (await listRuns(root)).filter(r => r.kind === 'btw' && !r.closed && r.rexSession === options.rexSession);
  for (const run of candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const exit = await readJson(join(run.dir, 'exit.json'));
    if (!run.block) throw new Error(`BTW launch ${run.id} is unresolved; inspect Rex before retrying.`);
    const actual = await inspectOrRetire(client, run, signal);
    if (!actual) continue;
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
    if (!member.block) throw new Error(`Layout acquisition ${member.id} is unresolved; inspect Rex before launching more ${role}.`);
    const actual = await inspectOrRetire(client, member, signal);
    if (!actual) continue;
    signal?.throwIfAborted();
    maxPage = Math.max(maxPage, member.layout.page || 1);
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
