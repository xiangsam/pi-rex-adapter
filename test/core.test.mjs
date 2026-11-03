import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Rex, prepareRun, readJson, atomicJson, piArgs, contextSnapshot, tailFile, runStatus } from '../src/core.mjs';
import adapter from '../src/index.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-rex-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('BTW placement anchors on the parent, preserves focus, and keeps arguments literal', async () => {
  let args;
  const rex = new Rex('rex', async (_file, argv) => { args = argv; return '{"block_ids":["new","parent"]}'; });
  assert.equal(await rex.open({ kind: 'btw', anchor: 'parent', rexSession: 'session', cwd: '/tmp/a b', name: '$(touch BAD)', dir: '/tmp/x y' }, '/path/runner.mjs'), 'new');
  assert.deepEqual(args.slice(0, 5), ['split', '-b', 'parent', '--split=right', '--ratio=50']);
  assert.ok(args.includes('--focus=false'));
  assert.ok(args.includes('--shell=none'));
  assert.ok(args.includes('$(touch BAD)'));
  assert.equal(args.at(-1), '/tmp/x y');
});
test('unknown creation result is not retried', async () => {
  let calls = 0;
  const rex = new Rex('rex', async () => { calls++; return '{}'; });
  await assert.rejects(rex.open({ kind: 'agent' }, 'runner'), /no block ID/);
  assert.equal(calls, 1);
});
test('context only includes current supplied branch text, omits tool payloads and thinking', () => {
  const context = contextSnapshot([
    { type: 'message', message: { role: 'user', content: 'question' } },
    { type: 'message', message: { role: 'toolResult', content: 'SECRET TOOL' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'answer' }] } },
  ]);
  assert.match(context, /question/); assert.match(context, /answer/); assert.doesNotMatch(context, /SECRET/);
  assert.match(contextSnapshot([{ type: 'compaction', summary: '123456789' }], 3), /omitted\]\n789$/);
});
test('fresh child session, literal prompt file and explicit extension; BTW has limited default tools', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'btw', task: '`touch BAD`', name: 'test' }, 'context');
  const args = piArgs(run, '/extension.mjs');
  assert.ok(args.includes('read,grep,find,ls'));
  assert.ok(args.includes('--no-mcp'));
  assert.ok(!args.includes('--print'));
  assert.equal(args.at(-2), '--');
  assert.equal((await readJson(join(run.dir, 'run.json'))).id, run.id);
  assert.match(await readFile(join(run.dir, 'prompt.md'), 'utf8'), /`touch BAD`/);
});
test('real shell runner captures stdout/stderr, nonzero exit and bounded result with full log', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'shell', task: 'printf hello; printf error >&2; exit 7', cwd: root }, '');
  const child = spawn(process.execPath, [resolve('src/runner.mjs'), run.dir], { stdio: 'ignore' });
  const [code] = await once(child, 'close');
  assert.equal(code, 7);
  assert.equal((await readJson(join(run.dir, 'exit.json'))).code, 7);
  const result = await readJson(join(run.dir, 'result.json'));
  assert.equal(result.status, 'failed'); assert.match(result.text, /hello/); assert.match(result.text, /error/);
  assert.equal((await tailFile(join(run.dir, 'output.log'), 3)).length, 3);
});
test('missing Pi executable produces an exit record instead of hanging', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'agent', task: 'test', name: 'x', cwd: root, piBin: '/missing/pi' }, '');
  const child = spawn(process.execPath, [resolve('src/runner.mjs'), run.dir], { stdio: 'ignore' });
  await once(child, 'close');
  assert.match((await readJson(join(run.dir, 'exit.json'))).error, /ENOENT/);
});
test('successful shell retains full log but bounds completion payload', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'shell', task: 'i=0; while [ "$i" -lt 3000 ]; do printf "1234567890"; i=$((i+1)); done', cwd: root }, '');
  const child = spawn(process.execPath, [resolve('src/runner.mjs'), run.dir], { stdio: 'ignore' });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const result = await readJson(join(run.dir, 'result.json'));
  assert.equal(result.status, 'completed'); assert.equal(result.text.length, 16000);
  assert.equal((await readFile(join(run.dir, 'output.log'), 'utf8')).length, 30000);
});

test('shell jobs default Python to unbuffered output and preserve an explicit setting', async t => {
  const root = await temporary(t);
  for (const configured of [undefined, '', '0']) {
    const env = { ...process.env };
    if (configured === undefined) delete env.PYTHONUNBUFFERED;
    else env.PYTHONUNBUFFERED = configured;
    const run = await prepareRun(root, { kind: 'shell', cwd: root,
      task: `${JSON.stringify(process.execPath)} -p 'process.env.PYTHONUNBUFFERED'` }, '');
    const child = spawn(process.execPath, [resolve('src/runner.mjs'), run.dir], { stdio: 'ignore', env });
    assert.equal((await once(child, 'close'))[0], 0);
    assert.equal((await readFile(join(run.dir, 'output.log'), 'utf8')).trim(), configured ?? '1');
  }
});

function harness(root, entries = [], dependencies = {}) {
  const events = {}, commands = {}, tools = {}, messages = [];
  const ctx = { cwd: root, hasUI: false, isIdle: () => true, sessionManager: {
    getSessionDir: () => root, getSessionId: () => 'parent', getEntries: () => entries, getBranch: () => entries,
  }, ui: { notify() {}, setStatus() {} } };
  adapter({ on: (n, f) => { events[n] = f; }, registerCommand: (n, f) => { commands[n] = f; },
    registerTool: t => { tools[t.name] = t; }, getThinkingLevel: () => 'off',
    sendMessage: (m, options) => { messages.push({ ...m, options }); entries.push({ type: 'custom_message', ...m }); },
  }, dependencies);
  return { ctx, events, commands, tools, messages, entries };
}
async function until(predicate) {
  for (let i = 0; i < 350; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('Timed out waiting for event');
}
test('completion pushes one follow-up, reload does not replay it, BTW returns only explicitly', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'shell', name: 'build', task: 'true' }, '');
  await atomicJson(join(run.dir, 'result.json'), { status: 'completed', text: 'PASS' });
  await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  const h = harness(dir); t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  await until(() => h.messages.length === 1);
  assert.equal(h.messages[0].options.triggerTurn, true);
  assert.equal(h.messages[0].options.deliverAs, undefined);
  await h.events.session_start({}, h.ctx);
  const side = await prepareRun(root, { kind: 'btw', name: 'aside', task: 'question' }, '');
  await atomicJson(join(side.dir, 'result.json'), { text: 'PRIVATE' });
  await atomicJson(join(side.dir, 'return-1.json'), { text: 'SHARED', status: 'returned' });
  await h.events.session_start({}, h.ctx); // Discover a fixture created outside the adapter launch path.
  await until(() => h.messages.length === 2);
  assert.match(h.messages[1].content, /SHARED/);
  assert.ok(h.messages.every(m => !m.content.includes('PRIVATE')));
  await h.events.session_start({}, h.ctx);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(h.messages.length, 2);
});
test('control rejects arbitrary IDs without contacting Rex', async t => {
  const dir = await temporary(t), h = harness(dir); t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const result = await h.tools.rex_control.execute('call', { id: '../someone-else', action: 'close' }, undefined, undefined, h.ctx);
  assert.equal(result.isError, true); assert.match(result.details.error, /Unknown task/);
});
test('switching sessions does not deliver an old session result into the new session', async t => {
  const dir = await temporary(t), h = harness(dir); t.after(() => h.events.session_shutdown());
  const run = await prepareRun(join(dir, 'rex-adapter', 'parent'), { kind: 'shell', name: 'old', task: 'true' }, '');
  await h.events.session_start({}, h.ctx);
  h.events.session_shutdown();
  const newCtx = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => 'new-parent' } };
  await h.events.session_start({}, newCtx);
  await atomicJson(join(run.dir, 'result.json'), { status: 'completed', text: 'OLD RESULT' });
  await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(h.messages.length, 0);
  await h.events.session_start({}, h.ctx);
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0].content, /OLD RESULT/);
});

test('delegated agents start a full interactive Pi, and own a retained tab', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'agent', name: 'review', task: 'review', cwd: root }, '');
  assert.equal(run.interactive, true);
  assert.ok(!piArgs(run, '/extension.mjs').includes('--print'));
  const rex = new Rex('rex', async (_bin, args) => {
    assert.equal(args[0], 'run');
    return JSON.stringify({ block_ids: ['child'], window_id: 'tab' });
  });
  assert.equal(await rex.open(run, '/runner.mjs'), 'child');
  assert.equal(run.window, 'tab');
});

test('busy parent consumes all ready results at one turn boundary without queuing follow-ups', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  for (const name of ['one', 'two', 'three']) {
    const run = await prepareRun(root, { kind: 'shell', name, task: 'true' }, '');
    await atomicJson(join(run.dir, 'result.json'), { status: 'completed', text: name });
    await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  }
  const h = harness(dir); h.ctx.isIdle = () => false;
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const event = { entries: [], context: { canContinue: true }, outcome: 'completed' };
  const batch = await h.events.turn_end(event, h.ctx);
  assert.equal(h.messages.length, 0);
  assert.equal(batch.continue, true);
  assert.equal(batch.entries.length, 1);
  assert.equal(batch.entries[0].details.receipts.length, 3);
  h.entries.push(...batch.entries);
  assert.equal(await h.events.agent_before_settle(event, h.ctx), undefined);
  await h.events.session_start({}, h.ctx);
  assert.equal(await h.events.turn_end(event, h.ctx), undefined);
});

test('idle parent wakes once for a batch; error detail survives an existing result', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  for (let i = 0; i < 3; i++) {
    const run = await prepareRun(root, { kind: 'shell', name: `job-${i}`, task: 'false' }, '');
    await atomicJson(join(run.dir, 'result.json'), { status: 'failed', text: 'partial stdout' });
    await atomicJson(join(run.dir, 'exit.json'), { code: 1, error: 'spawn ENOENT' });
  }
  const h = harness(dir); t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  await until(() => h.messages.length === 1);
  assert.equal(h.messages[0].details.receipts.length, 3);
  assert.match(h.messages[0].content, /partial stdout/);
  assert.match(h.messages[0].content, /Exit error: spawn ENOENT/);
});

test('close is idempotent, coalesces concurrent calls and cancellation wins the exit race', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'shell', name: 'long-job', task: 'sleep 30', status: 'running' }, '');
  let calls = 0;
  const h = harness(dir, [], { rex: { async control() {
    calls++;
    // The process exits while Rex is still acknowledging close.
    await atomicJson(join(run.dir, 'exit.json'), { code: null, error: 'Terminated by SIGTERM' });
    await atomicJson(join(run.dir, 'result.json'), { text: 'partial', status: 'failed' });
    await new Promise(r => setTimeout(r, 30));
  } } });
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const close = () => h.tools.bg_kill.execute('x', { id: run.id }, undefined, undefined, h.ctx);
  const results = await Promise.all([close(), close()]);
  results.push(await close());
  assert.equal(calls, 1);
  assert.ok(results.every(r => !r.isError && r.details.status === 'cancelled'));
  await until(() => h.messages.length === 1);
  assert.equal(h.messages[0].details.results[0].status, 'cancelled');
  assert.match(h.messages[0].content, /SIGTERM/);
});

test('closing a previously completed job preserves its outcome', () => {
  assert.equal(runStatus({ closed: true, completedBeforeClose: true }, { code: 7 }, { status: 'failed' }), 'failed');
  assert.equal(runStatus({ closed: true, completedBeforeClose: true }, { code: 0 }, { status: 'completed' }), 'completed');
  assert.equal(runStatus({ closed: true }, { code: null }, { status: 'failed' }), 'cancelled');
});

test('interactive agent turn reports arrive without process exit; future turns remain distinct', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'agent', name: 'review', task: 'review' }, '');
  await atomicJson(join(run.dir, 'turn-1.json'), { text: 'first answer', status: 'completed' });
  const h = harness(dir); h.ctx.isIdle = () => false; t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const event = { entries: [], context: { canContinue: true }, outcome: 'completed' };
  const first = await h.events.turn_end(event, h.ctx);
  assert.match(first.entries[0].content, /first answer/);
  h.entries.push(...first.entries);
  await atomicJson(join(run.dir, 'turn-2.json'), { text: 'next answer', status: 'completed' });
  let next;
  await until(() => Boolean(next = h.events.turn_end(event, h.ctx)));
  assert.equal(next.entries[0].details.receipts.length, 1);
  assert.match(next.entries[0].content, /next answer/);
});

test('aborted boundary does not force a continuation', async t => {
  const dir = await temporary(t), h = harness(dir); h.ctx.isIdle = () => false;
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  assert.equal(await h.events.turn_end({ entries: [], context: { canContinue: false }, outcome: 'aborted' }, h.ctx), undefined);
});

test('user abort suppresses an already scheduled idle wake; results survive for the next user turn', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'shell', name: 'test', task: 'true' }, '');
  await atomicJson(join(run.dir, 'result.json'), { text: 'saved result', status: 'completed' });
  await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  const h = harness(dir); t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  await h.events.agent_settled({ aborted: true });
  await new Promise(r => setTimeout(r, 450));
  assert.equal(h.messages.length, 0);
  h.ctx.isIdle = () => false;
  h.events.agent_start();
  const batch = await h.events.turn_end({ entries: [], context: { canContinue: true }, outcome: 'completed' }, h.ctx);
  assert.match(batch.entries[0].content, /saved result/);
});

test('failed close does not persist a cancellation and can be retried', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'shell', name: 'test', task: 'true' }, '');
  let calls = 0;
  const h = harness(dir, [], { rex: { async control() { if (++calls === 1) throw new Error('connection failed'); } } });
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const close = () => h.tools.bg_kill.execute('x', { id: run.id }, undefined, undefined, h.ctx);
  assert.equal((await close()).isError, true);
  assert.equal((await readJson(join(run.dir, 'run.json'))).closed, undefined);
  assert.equal((await close()).details.closed, true);
  assert.equal(calls, 2);
});

test('closing an idle interactive Pi preserves its completed task when close causes a signal exit', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'agent', name: 'review', task: 'review', rexSession: 'rex' }, '');
  await atomicJson(join(run.dir, 'result.json'), { text: 'done', status: 'completed' });
  await atomicJson(join(run.dir, 'activity.json'), { task: 'completed', process: 'idle' });
  const h = harness(dir, [], { rex: { async control() {
    await atomicJson(join(run.dir, 'exit.json'), { code: null, error: 'Terminated by SIGTERM' });
  } } });
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const result = await h.tools.rex_control.execute('x', { id: run.id, action: 'close' }, undefined, undefined, h.ctx);
  assert.equal(result.isError, undefined);
  const tasks = await h.tools.rex_tasks.execute('list', {}, undefined, undefined, h.ctx);
  assert.equal(tasks.details[0].taskState, 'completed');
  assert.equal(tasks.details[0].processState, 'exited');
  assert.equal(tasks.details[0].blockState, 'closed');
});

test('status close wins over an in-flight open inspection, and closed records never inspect again', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'agent', task: 'task', block: 'block' }, '');
  let inspections = 0;
  const h = harness(dir, [], { rex: { async inspect() {
    inspections++;
    await atomicJson(join(run.dir, 'run.json'), { ...run, closed: true, status: 'cancelled', blockState: 'open' });
    return { window: 'old-window' };
  } } });
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  for (let i = 0; i < 2; i++) {
    const result = await h.tools.rex_tasks.execute('x', {}, undefined, undefined, h.ctx);
    assert.equal(result.details[0].blockState, 'closed');
    assert.equal(result.details[0].closed, true);
  }
  assert.equal(inspections, 1);
});

test('failed block inspection reports unverified, never a stale open field', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  await prepareRun(root, { kind: 'agent', task: 'task', block: 'gone', blockState: 'open' }, '');
  const h = harness(dir, [], { rex: { async inspect() { throw new Error('block not found'); } } });
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const result = await h.tools.rex_tasks.execute('x', {}, undefined, undefined, h.ctx);
  assert.equal(result.details[0].blockState, 'unverified');
  assert.match(result.details[0].locationError, /not found/);
});

test('cancelled shell without result.json retains signal reason and reports resultAvailable=false', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'shell', task: 'sleep 30' }, '');
  await atomicJson(join(run.dir, 'run.json'), { ...run, closed: true, status: 'cancelled' });
  await atomicJson(join(run.dir, 'exit.json'), { code: null, error: 'Terminated by SIGHUP' });
  const h = harness(dir); t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0].content, /Cancelled by user/); assert.match(h.messages[0].content, /SIGHUP/);
  const result = await h.tools.rex_tasks.execute('x', {}, undefined, undefined, h.ctx);
  assert.equal(result.details[0].resultAvailable, false);
  assert.equal(result.details[0].taskState, 'cancelled');
});
