import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Rex, prepareRun, atomicJson, readJson, directPiCommand, runStates } from '../src/core.mjs';
import { observeLifecycles, recordLifecycle, rexExit } from '../src/lifecycle.mjs';
import { choosePlacement, withLayoutLock } from '../src/layout.mjs';
import adapter from '../src/index.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rex-lifecycle-'));
  const run = await prepareRun(root, { kind: 'agent', runtime: 'direct-pi', name: 'test', task: 'work',
    cwd: root, rexSession: 'session:ours', block: 'block:ours', owner: 'parent', ...options }, '');
  run.status = 'running';
  await atomicJson(join(run.dir, 'run.json'), run);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, run, get: name => readJson(join(run.dir, `${name}.json`)),
    put: (name, value) => atomicJson(join(run.dir, `${name}.json`), value) };
}
function event(run, exit = { exit_code: 7, error: 'exit status 7' }) {
  return { type: 'block_event', payload: { block_id: run.block, creator_name: 'com.superlogical.terminal',
    name: 'child_exited', payload: exit } };
}
function observer(t, f, process = async () => ({})) {
  const streams = [], probes = [], errors = [], changes = [];
  const controller = new AbortController();
  const client = { process: async run => { probes.push(run.id); return process(run); },
    events(session, handlers) {
      const stream = { session, ...handlers, stopped: false }; streams.push(stream);
      return () => { stream.stopped = true; };
    } };
  const monitor = observeLifecycles({ client, root: f.root, signal: controller.signal, retryMs: 10,
    onChange: () => changes.push(1), onError: error => errors.push(error) });
  t.after(() => controller.abort());
  return { monitor, client, streams, probes, errors, changes, controller };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('direct Pi uses exec-style env, literal paths and Pi flags; shell retains runner', async t => {
  const f = await fixture(t, { piBin: '/tmp/pi bundle.mjs', path: '/tmp/tools:$HOME', name: '$(touch BAD)' });
  const calls = [];
  const client = new Rex('rex', async (_file, args) => { calls.push(args); return '{"block_ids":["block:new"]}'; });
  for (const kind of ['agent', 'btw', 'shell']) {
    await client.open({ ...f.run, kind, runtime: kind === 'shell' ? 'shell-runner' : 'direct-pi', anchor: 'block:main' }, '/runner.mjs');
    const command = calls.at(-1).slice(calls.at(-1).indexOf('--') + 1);
    if (kind === 'shell') assert.deepEqual(command, [process.execPath, '/runner.mjs', f.run.dir]);
    else {
      assert.equal(command[0], '/usr/bin/env');
      assert.ok(command.includes(`PI_REX_RUN_DIR=${f.run.dir}`));
      assert.ok(command.includes('PATH=/tmp/tools:$HOME'));
      assert.ok(command.includes('/tmp/pi bundle.mjs'));
      assert.ok(!command.includes('/runner.mjs'));
      assert.ok(command.includes(`${kind === 'agent' ? 'Agent' : 'BTW'} · $(touch BAD)`));
      assert.equal(command.includes('--approve'), kind === 'agent');
      assert.equal(command.includes('--no-mcp'), kind === 'btw');
    }
  }
});

test('direct command launches a script without a resident supervisor or shell expansion', async t => {
  const f = await fixture(t);
  f.run.piBin = join(f.root, 'fake pi.mjs');
  await writeFile(f.run.piBin, `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.PI_REX_RUN_DIR+'/started.json', JSON.stringify({pid:process.pid,argv:process.argv,dir:process.env.PI_REX_RUN_DIR}));`);
  const [program, ...args] = directPiCommand(f.run);
  const child = spawn(program, args, { stdio: 'ignore' });
  assert.equal((await once(child, 'close'))[0], 0);
  const started = await f.get('started');
  assert.equal(started.pid, child.pid);
  assert.equal(started.dir, f.run.dir);
  assert.equal(started.argv.at(-1), `@${join(f.run.dir, 'prompt.md')}`);
});

test('one event stream per session, no idle resources or recurring process probes', async t => {
  const f = await fixture(t), h = observer(t, f);
  h.monitor.update([]); assert.equal(h.streams.length, 0);
  const second = { ...f.run, id: 'second', block: 'block:second' };
  h.monitor.update([f.run, second]); assert.equal(h.streams.length, 1);
  assert.equal(h.probes.length, 0);
  h.streams[0].onReady(); await h.monitor.drained();
  assert.equal(h.probes.length, 2);
  for (let i = 0; i < 10; i++) h.monitor.update([f.run, second]);
  await h.monitor.drained(); assert.equal(h.probes.length, 2);
  h.monitor.update([]); assert.ok(h.streams[0].stopped);
});

test('fast exit before subscription is recovered through last_exit', async t => {
  const f = await fixture(t), h = observer(t, f, async () => ({ last_exit: { exit_code: 127, error: 'Pi not found' } }));
  h.monitor.update([f.run]); h.streams[0].onReady(); await h.monitor.drained();
  assert.equal((await f.get('exit')).code, 127);
  assert.equal((await f.get('run')).status, 'failed');
});

test('native exit persists error, ignores unrelated events and does not overwrite an earlier exit', async t => {
  const f = await fixture(t), h = observer(t, f);
  h.monitor.update([f.run]); h.streams[0].onReady(); await h.monitor.drained();
  h.streams[0].onEvent(event({ ...f.run, block: 'block:foreign' }));
  h.streams[0].onEvent({ type: 'block_event', payload: { ...event(f.run).payload, creator_name: 'another.plugin' } });
  await h.monitor.drained(); assert.equal(await f.get('exit'), undefined);
  h.streams[0].onEvent(event(f.run)); await h.monitor.drained();
  const exit = await f.get('exit');
  assert.equal(exit.code, 7); assert.equal(exit.error, 'exit status 7');
  h.streams[0].onEvent(event(f.run)); await h.monitor.drained();
  assert.deepEqual(await f.get('exit'), exit);
});

test('reconnect reconciles missed exits and abort closes the stream', async t => {
  const f = await fixture(t); let ended = false;
  const h = observer(t, f, async () => ({ last_exit: ended ? { exit_code: 0 } : null }));
  h.monitor.update([f.run]); h.streams[0].onReady(); await h.monitor.drained();
  h.streams[0].onDisconnect(new Error('connection lost')); ended = true;
  await pause(25); assert.equal(h.streams.length, 2);
  h.streams[1].onReady(); await h.monitor.drained();
  assert.equal((await f.get('exit')).code, 0);
  assert.equal((await f.get('run')).status, 'exited');
  h.controller.abort(); assert.ok(h.streams[1].stopped);
});

for (const idle of [false, true]) test(`removed pane without exit preserves ${idle ? 'completed handoff' : 'unknown outcome'}`, async t => {
  const f = await fixture(t), h = observer(t, f);
  await f.put('activity', { task: idle ? 'completed' : 'running', process: idle ? 'idle' : 'running' });
  await f.put('result', { status: 'completed', text: idle ? 'latest answer' : 'earlier answer' });
  h.monitor.update([f.run]);
  h.streams[0].onEvent({ type: 'block_closed', payload: { block_id: f.run.block } });
  await h.monitor.drained();
  const run = await f.get('run'), exit = await f.get('exit');
  assert.equal(run.closed, true); assert.equal(run.status, idle ? 'completed' : 'exited');
  assert.equal(exit.unknown, true); assert.equal(exit.code, null);
  assert.match(exit.error, /unavailable/);
  assert.equal(runStates(run, exit, await f.get('result'), await f.get('activity')).blockState, 'closed');
  assert.ok(await f.get('result'));
});

test('known exit arriving after block removal upgrades unknown outcome', async t => {
  const f = await fixture(t);
  await recordLifecycle(f.run, { closed: true });
  await recordLifecycle(f.run, { exit: rexExit({ exit_code: 8, error: 'failure' }) });
  assert.equal((await f.get('exit')).unknown, undefined);
  assert.equal((await f.get('run')).status, 'failed');
});

test('an explicit close cancellation survives late lifecycle events and a stale answer', async t => {
  const f = await fixture(t);
  await f.put('run', { ...f.run, closed: true, status: 'cancelled', completedBeforeClose: false });
  await f.put('activity', { task: 'completed', process: 'idle' });
  await f.put('result', { text: 'late answer', status: 'completed' });
  await recordLifecycle(f.run, { closed: true, exit: rexExit({ exit_code: -1 }) });
  assert.equal((await f.get('run')).status, 'cancelled');
});

test('a new active turn cannot reuse a previous successful result after exit zero', async t => {
  const f = await fixture(t);
  await f.put('activity', { task: 'running', process: 'running' });
  await f.put('result', { text: 'previous answer', status: 'completed' });
  await recordLifecycle(f.run, { exit: rexExit({ exit_code: 0 }) });
  assert.equal((await f.get('run')).status, 'exited');
  assert.equal((await f.get('exit')).taskIncomplete, true);
});

test('missing block recovery requires exact identity; transport failure leaves task untouched', async t => {
  const f = await fixture(t);
  const h = observer(t, f, async () => { throw Object.assign(new Error('missing'),
    { code: 'REX_BLOCK_NOT_FOUND', block: f.run.block, rexSession: 'session:foreign' }); });
  h.monitor.update([f.run]); h.streams[0].onReady(); await h.monitor.drained();
  assert.equal(await f.get('exit'), undefined); assert.equal((await f.get('run')).closed, undefined);
  assert.equal(h.errors.length, 1);
});

test('layout retires a missing direct Pi without an exit file and can launch again', async t => {
  const f = await fixture(t, { layout: { role: 'agents', page: 1, window: 'window:old' } });
  const client = { inspect: async run => { throw Object.assign(new Error('missing'),
    { code: 'REX_BLOCK_NOT_FOUND', block: run.block, rexSession: run.rexSession }); } };
  const placement = await withLayoutLock(f.root, () => choosePlacement(f.root, client, { kind: 'agent', owner: 'parent', rexSession: f.run.rexSession }));
  assert.equal(placement.mode, 'window'); assert.equal(placement.page, 1);
  assert.equal((await f.get('exit')).unknown, true); assert.equal((await f.get('run')).closed, true);
});

test('parent delivers direct Pi startup exit once, with error, but does not return BTW exits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rex-parent-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runRoot = join(root, 'rex-adapter', 'parent');
  const runs = [];
  for (const kind of ['agent', 'btw']) {
    const run = await prepareRun(runRoot, { runtime: 'direct-pi', kind, name: kind, task: 'work', rexSession: 'session:ours', block: `block:${kind}` }, '');
    runs.push(run);
  }
  const events = {}, entries = [], messages = [], streams = [];
  const ctx = { cwd: root, hasUI: false, isIdle: () => true, sessionManager: {
    getSessionId: () => 'parent', getSessionDir: () => root, getEntries: () => entries,
  } };
  adapter({ on: (name, fn) => { events[name] = fn; }, registerTool() {}, registerCommand() {},
    sendMessage: message => { messages.push(message); entries.push({ type: 'custom_message', ...message }); },
  }, { rex: { process: async () => ({ last_exit: { exit_code: 127, error: 'Pi unavailable' } }),
    events: (_session, handlers) => { streams.push(handlers); return () => {}; } } });
  t.after(() => events.session_shutdown());
  await events.session_start({}, ctx);
  streams[0].onReady();
  const deadline = Date.now() + 2500;
  while (!messages.length && Date.now() < deadline) await pause(25);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /Pi unavailable/);
  assert.equal(messages[0].details.results.length, 1);
  assert.equal(messages[0].details.results[0].id, runs[0].id);
  await events.session_shutdown();
  await events.session_start({}, ctx); await pause(400);
  assert.equal(messages.length, 1);
});

test('Rex event transport decodes session envelopes and ignores foreign sessions', async t => {
  const f = await fixture(t);
  const binary = join(f.root, 'fake-rex');
  const lines = [
    { type: 'session_event', payload: { session_id: 'foreign', event: event(f.run) } },
    { type: 'session_event', payload: { session_id: f.run.rexSession, event: event(f.run) } },
    { type: 'session_event', payload: { session_id: f.run.rexSession, event: { type: 'block_closed', payload: { block_id: f.run.block } } } },
  ];
  await writeFile(binary, `#!${process.execPath}\nconsole.log('malformed');\n${lines.map(line => `console.log(${JSON.stringify(JSON.stringify(line))});`).join('\n')}\n`, { mode: 0o700 });
  const received = []; let ready = 0;
  await new Promise(resolve => new Rex(binary).events(f.run.rexSession, {
    onEvent: event => received.push(event), onReady: () => ready++, onDisconnect: resolve,
  }));
  assert.equal(ready, 1); assert.equal(received.length, 2);
  assert.equal(received[1].type, 'block_closed');
});
