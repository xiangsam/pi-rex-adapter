import { join } from 'node:path';
import { atomicJson, readJson, runStatus, withLayoutLock } from './core.mjs';

export const directRun = run => run.runtime === 'direct-pi' && run.block && !run.closed;
export const missingBlock = (error, run) => error.code === 'REX_BLOCK_NOT_FOUND' &&
  error.block === run.block && error.rexSession === run.rexSession;

export function rexExit(value) {
  if (!value || !Number.isInteger(value.exit_code)) return undefined;
  return { code: value.exit_code < 0 ? null : value.exit_code, error: value.error,
    source: 'rex', at: new Date().toISOString() };
}

// Caller holds the parent's layout lock, shared with launch and explicit close.
export async function recordLifecycle(run, observation, signal) {
  const [latest, previousExit, result, activity] = await Promise.all(['run', 'exit', 'result', 'activity']
    .map(name => readJson(join(run.dir, `${name}.json`))));
  signal?.throwIfAborted();
  if (!latest || latest.runtime !== 'direct-pi' || latest.id !== run.id ||
      latest.block !== run.block || latest.rexSession !== run.rexSession) return;
  let exit = previousExit;
  if (observation.exit && (!exit || exit.unknown)) exit = observation.exit;
  if (observation.closed) {
    if (!latest.closed) {
      latest.completedBeforeClose = true;
      // A closed idle Pi may have a valid handoff even if Rex no longer retains
      // its exit code. Keep the task result distinct from the process outcome.
      if (activity?.process === 'idle' && result) latest.taskCompletedBeforeClose = true;
    }
    latest.closed = true;
    latest.resolvedAt = new Date().toISOString();
    latest.resolution = 'Rex confirmed the block was removed.';
    exit ||= { code: null, unknown: true, source: 'rex', at: latest.resolvedAt,
      error: 'Block removed; process exit status is unavailable.' };
  }
  if (exit && exit !== previousExit) {
    if (activity?.task === 'running') exit = { ...exit, taskIncomplete: true };
    await atomicJson(join(run.dir, 'exit.json'), exit);
  }
  latest.status = runStatus(latest, exit, result);
  await atomicJson(join(run.dir, 'run.json'), latest);
  return latest;
}

// One stream per Rex session, only while direct Pi panes exist. Recovery probes
// run on subscription/reconnection and launch, never at model boundaries or on
// a periodic per-task polling loop. Filesystem notifications still deliver turns.
export function observeLifecycles({ client, root, signal, onChange, onError = () => {}, retryMs = 1000 }) {
  const runs = new Map(), sessions = new Map(), work = new Set();
  let stopped = false;
  const valid = () => !stopped && !signal.aborted;
  function background(fn) {
    const task = Promise.resolve().then(fn).catch(error => { if (valid()) onError(error); });
    work.add(task); void task.finally(() => work.delete(task));
    return task;
  }
  async function save(run, observation) {
    if (!valid()) return;
    await withLayoutLock(root, async () => {
      if (!valid()) return;
      await recordLifecycle(run, observation, signal);
    });
    if (valid()) onChange();
  }
  async function probe(run, state) {
    if (!valid() || !runs.has(run.id) || !state.ready || sessions.get(state.session) !== state) return;
    try {
      const process = await client.process(run, signal);
      state.delay = retryMs;
      const exit = rexExit(process.last_exit);
      if (exit) await save(run, { exit });
    } catch (error) {
      if (!valid()) return;
      if (missingBlock(error, run)) await save(run, { closed: true });
      else { reconnect(state, error); }
    }
  }
  function queueProbe(run, state) {
    const previous = state.probing;
    state.probing = background(async () => { await previous; await probe(run, state); });
  }
  function reconnect(state, error) {
    if (!valid() || sessions.get(state.session) !== state || state.retry) return;
    state.ready = false; state.stop?.(); state.stop = undefined;
    onError(error);
    state.retry = setTimeout(() => { state.retry = undefined; connect(state); }, state.delay);
    state.retry.unref?.(); state.delay = Math.min(state.delay * 2, 30000);
  }
  function connect(state) {
    if (!valid() || sessions.get(state.session) !== state) return;
    try {
      state.stop = client.events(state.session, {
        onReady() {
          if (!valid() || sessions.get(state.session) !== state) return;
          state.ready = true;
          for (const run of runs.values()) if (run.rexSession === state.session) queueProbe(run, state);
        },
        onEvent(event) {
          if (!valid() || sessions.get(state.session) !== state) return;
          const payload = event?.payload;
          const closed = event?.type === 'block_closed';
          const exit = event?.type === 'block_event' && payload?.creator_name === 'com.superlogical.terminal' &&
            payload.name === 'child_exited' ? rexExit(payload.payload) : undefined;
          if (!closed && !exit) return;
          const run = [...runs.values()].find(run => run.rexSession === state.session && run.block === payload?.block_id);
          if (run) background(() => save(run, { closed, exit }));
        },
        onDisconnect: error => reconnect(state, error),
      });
    } catch (error) { reconnect(state, error); }
  }
  function update(items) {
    if (!valid()) return;
    const previous = new Set(runs.keys());
    runs.clear();
    for (const run of items.filter(directRun)) runs.set(run.id, run);
    const wanted = new Set([...runs.values()].map(run => run.rexSession));
    for (const [session, state] of sessions) if (!wanted.has(session)) {
      sessions.delete(session); clearTimeout(state.retry); state.stop?.();
    }
    for (const session of wanted) {
      let state = sessions.get(session);
      if (!state) {
        state = { session, ready: false, delay: retryMs };
        sessions.set(session, state); connect(state);
      } else if (state.ready) {
        for (const run of runs.values()) if (run.rexSession === session && !previous.has(run.id)) queueProbe(run, state);
      }
    }
  }
  function stop() {
    stopped = true;
    for (const state of sessions.values()) { clearTimeout(state.retry); state.stop?.(); }
    sessions.clear(); runs.clear(); signal.removeEventListener('abort', stop);
  }
  signal.addEventListener('abort', stop, { once: true });
  return { update, stop, drained: () => Promise.all([...work]) };
}
