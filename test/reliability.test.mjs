import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import adapter from '../src/index.mjs';
import { registerChild } from '../src/child.mjs';
import { prepareRun, atomicJson, readJson, exec, listRuns } from '../src/core.mjs';
import { withLayoutLock } from '../src/layout.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await delay(10); }
  assert.fail('Timed out waiting for condition');
}
async function fixture(t, rex = {}, activeTools) {
  const dir = await mkdtemp(join(tmpdir(), 'rex-reliability-'));
  const root = join(dir, 'rex-adapter', 'parent');
  const events = {}, tools = {}, commands = {}, entries = [], updates = [], messages = [];
  const ctx = { cwd: dir, hasUI: true, isIdle: () => false, sessionManager: {
    getSessionDir: () => dir, getSessionId: () => 'parent', getEntries: () => entries, getBranch: () => entries,
  }, ui: { setWidget: (...a) => updates.push(a), setStatus: (...a) => updates.push(a), notify: (...a) => updates.push(a) } };
  const pi = { on: (n, f) => { events[n] = f; }, registerTool: tool => { tools[tool.name] = tool; },
    registerCommand: (n, c) => { commands[n] = c; }, getThinkingLevel: () => 'off',
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendMessage: m => { messages.push(m); entries.push({ type: 'custom_message', ...m }); },
  };
  if (activeTools) pi.getActiveTools = () => activeTools;
  adapter(pi, { rex });
  t.after(async () => { events.session_shutdown(); await delay(20); await rm(dir, { recursive: true, force: true }); });
  const call = (name, params, signal) => tools[name].execute('call', params, signal, undefined, ctx);
  const boundary = () => events.turn_end({ entries: [], context: { canContinue: true }, outcome: 'completed' }, ctx);
  return { dir, root, events, tools, commands, entries, updates, messages, ctx, call, boundary };
}
function inRex(t) {
  const previous = [process.env.REX_SESSION, process.env.REX_BLOCK];
  process.env.REX_SESSION = 'rex'; process.env.REX_BLOCK = 'parent';
  t.after(() => {
    for (const [i, key] of ['REX_SESSION', 'REX_BLOCK'].entries()) {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }
  });
}
function overlays(h, scripts, screens = []) {
  h.ctx.ui.custom = async (factory) => {
    let result;
    const component = factory({ terminal: { rows: 24 }, requestRender() {} }, {},
      { matches: (data, key) => data === key }, value => { result = value; });
    screens.push(component.render(84).join('\n'));
    const script = scripts.shift() || ['cancel'];
    for (const key of script) component.handleInput(`tui.select.${key}`);
    return result;
  };
}

test('unused session has no task directory, watcher, timer-driven UI or direct tools outside Rex', async t => {
  const previous = [process.env.REX_SESSION, process.env.REX_BLOCK];
  delete process.env.REX_SESSION; delete process.env.REX_BLOCK;
  t.after(() => {
    for (const [i, key] of ['REX_SESSION', 'REX_BLOCK'].entries()) if (previous[i] !== undefined) process.env[key] = previous[i];
  });
  const before = process.getActiveResourcesInfo().filter(x => x === 'FSEventWrap').length;
  const h = await fixture(t);
  await h.events.session_start({}, h.ctx);
  const updates = h.updates.length;
  for (let i = 0; i < 20; i++) assert.equal(h.boundary(), undefined);
  await delay(120);
  await assert.rejects(stat(h.root), { code: 'ENOENT' });
  assert.equal(h.updates.length, updates);
  assert.equal(process.getActiveResourcesInfo().filter(x => x === 'FSEventWrap').length, before);
  assert.ok(Object.values(h.tools).every(tool => tool.exposure === 'deferred' && !tool.promptGuidelines));
});

test('Rex exposes only launch and finish tools directly; low-frequency controls remain discoverable', async t => {
  inRex(t); const h = await fixture(t);
  assert.deepEqual(Object.values(h.tools).filter(tool => tool.exposure === 'direct').map(tool => tool.name).sort(),
    ['bg_run', 'btw', 'rex_finish', 'subagent']);
});

test('without tool discovery, controls become direct only while owned tasks need attention', async t => {
  inRex(t);
  const h = await fixture(t, {}, ['read', 'bash']);
  assert.equal(h.tools.rex_control.exposure, 'deferred');
  const run = await prepareRun(h.root, { kind: 'agent', name: 'review', task: 'review' }, '');
  await h.events.session_start({}, h.ctx);
  assert.equal(h.tools.rex_control.exposure, 'direct');
  await atomicJson(join(run.dir, 'run.json'), { ...run, closed: true, taskCompletedBeforeClose: true });
  h.boundary();
  await until(() => h.tools.rex_control.exposure === 'deferred');
});

test('already cancelled or lock-queued launch never opens a block', async t => {
  inRex(t); let opens = 0;
  const h = await fixture(t, { open: async () => { opens++; return 'block'; } });
  await h.events.session_start({}, h.ctx);
  const aborted = AbortSignal.abort();
  assert.equal((await h.call('bg_run', { command: 'true' }, aborted)).isError, true);
  let release, locked;
  const held = withLayoutLock(h.root, () => new Promise(resolve => { release = resolve; locked = true; }));
  await until(() => locked);
  const controller = new AbortController();
  const queued = h.call('bg_run', { command: 'true' }, controller.signal);
  controller.abort(); release(); await held;
  assert.equal((await queued).isError, true);
  assert.equal(opens, 0);
  assert.deepEqual(await listRuns(h.root), []);
});

test('cancellation after dispatch preserves uncertain creation and never retries', async t => {
  inRex(t); let opens = 0; const controller = new AbortController();
  const h = await fixture(t, { open: async (_run, _runner, signal) => {
    opens++; controller.abort(); signal.throwIfAborted();
  } });
  await h.events.session_start({}, h.ctx);
  const result = await h.call('bg_run', { command: 'printf hello' }, controller.signal);
  assert.equal(result.details.status, 'uncertain'); assert.equal(opens, 1);
  const [run] = await listRuns(h.root);
  assert.equal(run.name, 'printf hello'); assert.equal(run.closed, undefined);
});

test('CLI execution propagates abort to the subprocess', async () => {
  const controller = new AbortController();
  const pending = exec(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], controller.signal);
  controller.abort();
  await assert.rejects(pending, /abort/i);
});

test('slow shell cleanup does not block boundaries or delivery from another task', async t => {
  let release, started = false;
  const h = await fixture(t, { control: () => new Promise(resolve => { release = resolve; started = true; }) });
  const shell = await prepareRun(h.root, { kind: 'shell', name: 'done', task: 'true', block: 'shell' }, '');
  await atomicJson(join(shell.dir, 'exit.json'), { code: 0 });
  await atomicJson(join(shell.dir, 'result.json'), { status: 'completed', text: 'done' });
  const agent = await prepareRun(h.root, { kind: 'agent', name: 'review', task: 'review' }, '');
  h.entries.push({ type: 'custom_message', customType: 'rex_result', details: { receipts: [`${shell.id}/result.json`] } });
  await h.events.session_start({}, h.ctx);
  await until(() => started);
  t.after(() => release?.());
  assert.equal(h.boundary(), undefined); // A synchronous return while Rex close remains unresolved.
  await atomicJson(join(agent.dir, 'turn-z.json'), { text: 'independent result', status: 'completed', sequence: 1 });
  let batch;
  await until(() => Boolean(batch = h.boundary()));
  assert.match(batch.entries[0].content, /independent result/);
  assert.equal((await readJson(join(shell.dir, 'run.json'))).closed, undefined);
  release();
  await until(async () => (await readJson(join(shell.dir, 'run.json')))?.closed);
});

test('delivered closed history leaves the hot path and does not redraw on boundaries', async t => {
  const h = await fixture(t);
  const runs = await Promise.all(Array.from({ length: 60 }, (_, i) => prepareRun(h.root,
    { kind: 'shell', task: 'true', name: `old-${i}`, closed: true, completedBeforeClose: true }, '')));
  for (const run of runs) {
    await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
    await atomicJson(join(run.dir, 'result.json'), { status: 'completed', text: 'x'.repeat(16000) });
  }
  h.entries.push({ type: 'custom_message', customType: 'rex_result', details: { receipts: runs.map(r => `${r.id}/result.json`) } });
  await h.events.session_start({}, h.ctx);
  const count = h.updates.length;
  // If cold records are reread, this corruption would surface a scan error/UI update.
  await writeFile(join(runs[0].dir, 'result.json'), '{');
  for (let i = 0; i < 10; i++) assert.equal(h.boundary(), undefined);
  await delay(150);
  assert.equal(h.updates.length, count);
});

test('restored multi-turn results follow report order, not random filenames', async t => {
  const h = await fixture(t);
  const run = await prepareRun(h.root, { kind: 'agent', name: 'review', task: 'review' }, '');
  await atomicJson(join(run.dir, 'turn-a.json'), { sequence: 200, status: 'completed', text: 'SECOND' });
  await atomicJson(join(run.dir, 'turn-z.json'), { sequence: 100, status: 'completed', text: 'FIRST' });
  await h.events.session_start({}, h.ctx);
  const message = h.boundary().entries[0];
  assert.ok(message.content.indexOf('FIRST') < message.content.indexOf('SECOND'));
  assert.deepEqual(message.details.results.map(r => r.order), [100, 200]);
});

test('BTW async rejection is not acknowledged, retries on reload, and persisted receipt prevents replay', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rex-input-'));
  const events = {}, entries = [], sent = [];
  let accept = false;
  const ctx = { isIdle: () => true, hasUI: false,
    sessionManager: { getEntries: () => entries, getBranch: () => [{ type: 'message' }] } };
  registerChild({ on: (n, f) => { events[n] = f; }, registerCommand() {},
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendUserMessage: text => {
      sent.push(text);
      // Pi's void API can return with no message persisted. Mimic that failure.
      if (accept) setImmediate(() => {
        entries.push({ type: 'message', message: { role: 'user', content: text } });
        events.message_end({ message: { role: 'user', content: text } });
      });
    },
  }, dir);
  t.after(async () => { events.session_shutdown(); await rm(dir, { recursive: true, force: true }); });
  await events.session_start({}, ctx);
  await atomicJson(join(dir, 'input-one.json'), { id: 'one', text: 'literal /question', createdAt: '1' });
  await until(() => sent.length === 1);
  await delay(1100); // Slow/ambiguous calls are not blindly sent twice.
  assert.equal(sent.length, 1);
  assert.equal(entries.filter(e => e.customType === 'rex_input').length, 0);
  accept = true;
  await events.session_start({}, ctx);
  await until(() => entries.some(e => e.customType === 'rex_input'));
  assert.equal(sent.length, 2);
  await events.session_start({}, ctx); await delay(1100);
  assert.equal(sent.length, 2);
});

test('unknown task exposes recovery instead of impossible controls; only explicit confirmation retires it', async t => {
  inRex(t); let opens = 0;
  const h = await fixture(t, { open: async run => { opens++; run.window = 'new'; return 'new-block'; } });
  const run = await prepareRun(h.root, { kind: 'agent', name: 'unknown', task: 'review', rexSession: 'rex',
    layout: { role: 'agents', page: 1 }, status: 'uncertain' }, '');
  await h.events.session_start({}, h.ctx);
  const screens = [];
  overlays(h, [['down', 'confirm'], ['down', 'confirm'], ['cancel'], ['cancel'], ['cancel']], screens);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.doesNotMatch(screens[1], /Focus task|Close task/);
  assert.match(screens[1], /Confirm resource removed/);
  assert.equal((await readJson(join(run.dir, 'run.json'))).closed, undefined);
  overlays(h, [['down', 'confirm'], ['down', 'confirm'], ['down', 'confirm'], ['cancel']]);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.equal((await readJson(join(run.dir, 'run.json'))).closed, true);
  const result = await h.call('subagent', { task: 'new review' });
  assert.equal(result.isError, undefined); assert.equal(opens, 1);
});

test('details and operation errors return to the selected task menu and list position', async t => {
  const h = await fixture(t, { control: async () => { throw new Error('offline'); } });
  const run = await prepareRun(h.root, { kind: 'agent', name: 'review', task: 'task', block: 'block' }, '');
  await atomicJson(join(run.dir, 'activity.json'), { task: 'completed', process: 'idle' });
  await h.events.session_start({}, h.ctx);
  const screens = [];
  overlays(h, [['down', 'confirm'], ['confirm'], ['cancel'], ['down', 'confirm'], ['cancel'], ['cancel'], ['cancel']], screens);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.match(screens[3], /› View task and result/);
  assert.match(screens[4], /offline/);
  assert.match(screens[5], /› Focus task/);
  assert.match(screens[6], /› \[Agent\] review/);
});

test('close reports and persists the derived outcome, including repeat closes of older records', async t => {
  let closes = 0;
  const h = await fixture(t, { control: async run => {
    closes++;
    await atomicJson(join(run.dir, 'exit.json'), { code: null, error: 'SIGTERM' });
  } });
  await h.events.session_start({}, h.ctx);
  for (const outcome of ['completed', 'failed', 'interrupted']) {
    const run = await prepareRun(h.root, { kind: 'agent', name: outcome, block: 'block' }, '');
    await atomicJson(join(run.dir, 'run.json'), { ...run, status: 'running' });
    await atomicJson(join(run.dir, 'activity.json'), { task: outcome, process: 'idle' });
    await atomicJson(join(run.dir, 'result.json'), { status: outcome, text: outcome });
    const closed = await h.call('rex_control', { id: run.id, action: 'close' });
    assert.equal(closed.details.status, outcome);
    assert.equal(closed.details.taskState, outcome);
    assert.equal(closed.details.blockState, 'closed');
    assert.equal((await readJson(join(run.dir, 'run.json'))).status, outcome);
    // Older manifests can still have a stale status; a repeat close repairs it.
    const saved = await readJson(join(run.dir, 'run.json'));
    await atomicJson(join(run.dir, 'run.json'), { ...saved, status: 'running' });
    const repeated = await h.call('rex_control', { id: run.id, action: 'close' });
    const row = (await h.call('rex_tasks', {})).details.find(row => row.id === run.id);
    assert.equal(repeated.details.status, row.status);
    assert.equal((await readJson(join(run.dir, 'run.json'))).status, outcome);
  }
  assert.equal(closes, 3);
});

test('missing logs are a normal result; empty logs and real filesystem errors stay distinct', async t => {
  const h = await fixture(t);
  await h.events.session_start({}, h.ctx);
  for (const kind of ['agent', 'btw', 'shell']) {
    const run = await prepareRun(h.root, { kind, name: kind }, '');
    const missing = await h.call('bg_logs', { id: run.id });
    assert.equal(missing.isError, undefined);
    assert.equal(missing.details.logAvailable, false);
    assert.equal(missing.details.output, '');
    assert.match(missing.details.note, /No output log/);
    assert.doesNotMatch(missing.details.note, /ENOENT/);
    await writeFile(join(run.dir, 'output.log'), '');
    assert.deepEqual((await h.call('bg_logs', { id: run.id })).details, { output: '', logAvailable: true });
    await rm(join(run.dir, 'output.log'));
    await mkdir(join(run.dir, 'output.log'));
    assert.equal((await h.call('bg_logs', { id: run.id })).isError, true);
  }
});

test('task queries accept an optional owned ID and inspect only that task', async t => {
  const inspected = [];
  const h = await fixture(t, { inspect: async run => { inspected.push(run.id); return { window: 'window' }; } });
  await h.events.session_start({}, h.ctx);
  const one = await prepareRun(h.root, { kind: 'agent', name: 'one', block: 'one' }, '');
  await prepareRun(h.root, { kind: 'agent', name: 'two', block: 'two' }, '');
  assert.equal(h.tools.rex_tasks.parameters.properties.id.type, 'string');
  assert.deepEqual(h.tools.rex_tasks.parameters.required, []);
  const selected = await h.call('rex_tasks', { id: one.id });
  assert.deepEqual(selected.details.map(row => row.id), [one.id]);
  assert.deepEqual(inspected, [one.id]);
  assert.equal((await h.call('rex_tasks', { id: '../other' })).isError, true);
  assert.equal((await h.call('rex_tasks', { id: '00000000-0000-0000-0000-000000000000' })).isError, true);
  assert.equal((await h.call('rex_tasks', {})).details.length, 2);
});

test('finish explains failed and interrupted outcomes without silently closing them', async t => {
  let closes = 0;
  const h = await fixture(t, { control: async () => { closes++; } });
  await h.events.session_start({}, h.ctx);
  for (const outcome of ['failed', 'interrupted']) {
    const run = await prepareRun(h.root, { kind: 'agent', name: outcome, block: 'block' }, '');
    await atomicJson(join(run.dir, 'activity.json'), { task: outcome, process: 'idle' });
    await atomicJson(join(run.dir, 'result.json'), { status: outcome });
    const response = await h.call('rex_finish', { id: run.id });
    assert.equal(response.isError, true);
    assert.match(response.details.error, new RegExp(`task=${outcome}`));
    assert.match(response.details.error, /process=idle/);
    assert.match(response.details.error, /rex_control.*close/);
    assert.equal((await readJson(join(run.dir, 'run.json'))).closed, undefined);
  }
  assert.equal(closes, 0);
});

test('repeated task-manager commands share one panel and a later invocation can reopen it', async t => {
  const h = await fixture(t);
  await h.events.session_start({}, h.ctx);
  const overlays = [];
  h.ctx.ui.custom = factory => new Promise(resolve => {
    overlays.push(factory({ terminal: { rows: 24 }, requestRender() {} }, {},
      { matches: (data, key) => data === key }, resolve));
  });
  const first = h.commands['rex-tasks'].handler('', h.ctx);
  const repeated = h.commands['rex-tasks'].handler('', h.ctx);
  await until(() => overlays.length > 0);
  await delay(20);
  const opened = overlays.length;
  // Always settle all panels, including the duplicate created by the old code.
  for (const overlay of overlays) overlay.handleInput('tui.select.cancel');
  await Promise.all([first, repeated]);
  assert.equal(opened, 1);
  const reopened = h.commands['rex-tasks'].handler('', h.ctx);
  await until(() => overlays.length === 2);
  overlays[1].handleInput('tui.select.cancel');
  await reopened;
});

async function runnerFixture(t, task) {
  const dir = await mkdtemp(join(tmpdir(), 'rex-runner-'));
  const run = await prepareRun(dir, { kind: 'shell', task, cwd: dir }, '');
  const child = spawn(process.execPath, [resolve('src/runner.mjs'), run.dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed; await rm(dir, { recursive: true, force: true }); });
  return { dir, run, child, closed };
}

test('shell tee applies backpressure from a paused terminal without losing the full log', { timeout: 8000 }, async t => {
  const h = await runnerFixture(t, `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(4194304))'`);
  await until(async () => (await stat(join(h.run.dir, 'output.log')).catch(() => undefined))?.size > 0);
  await delay(120);
  const stalled = (await stat(join(h.run.dir, 'output.log'))).size;
  assert.ok(stalled < 4194304, `Expected bounded writes while terminal is paused, got ${stalled}`);
  h.child.stdout.resume();
  const [code] = await h.closed;
  assert.equal(code, 0);
  assert.equal((await stat(join(h.run.dir, 'output.log'))).size, 4194304);
});

test('log open failure terminates shell and records the write error', { timeout: 8000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rex-log-error-'));
  const run = await prepareRun(dir, { kind: 'shell', task: 'printf start; sleep 30', cwd: dir }, '');
  await mkdir(join(run.dir, 'output.log'));
  const child = spawn(process.execPath, [resolve('src/runner.mjs'), run.dir], { stdio: 'ignore' });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed; await rm(dir, { recursive: true, force: true }); });
  await closed;
  const exit = await readJson(join(run.dir, 'exit.json'));
  assert.notEqual(exit.code, 0); assert.match(exit.error, /Output write failed.*EISDIR/);
});

test('runner termination reaches shell descendants in its isolated process group', { timeout: 8000 }, async t => {
  const h = await runnerFixture(t, 'sleep 30 & echo $! > descendant.pid; wait');
  h.child.stdout.resume();
  await until(async () => Boolean(await readFile(join(h.dir, 'descendant.pid'), 'utf8').catch(() => '')));
  const pid = Number(await readFile(join(h.dir, 'descendant.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  h.child.kill('SIGTERM'); await h.closed;
  await until(async () => {
    try { process.kill(pid, 0); } catch (e) { return e.code === 'ESRCH'; }
    if (process.platform !== 'linux') return false;
    // A terminated orphan can remain as a zombie until the host reaps it.
    // kill(pid, 0) succeeds in that state; it does not mean sleep is still running.
    try { return /^State:\s+Z\b/m.test(await readFile(`/proc/${pid}/status`, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  });
  assert.match((await readJson(join(h.run.dir, 'exit.json'))).error, /SIGTERM/);
});
