import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { choosePlacement, existingBtw, withLayoutLock } from '../src/layout.mjs';
import { Rex, prepareRun, atomicJson, readJson, runStates, listRuns } from '../src/core.mjs';
import { registerChild } from '../src/child.mjs';
import adapter from '../src/index.mjs';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-rex-layout-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
function fakeRex() {
  const blocks = new Map([['parent', 'main']]);
  const calls = [];
  let count = 0, windows = 0;
  return { blocks, calls,
    async inspect(run) { if (!blocks.has(run.block)) throw new Error('Block unavailable'); return { window: blocks.get(run.block) }; },
    async open(run) {
      calls.push(structuredClone(run.layout));
      const id = `block-${++count}`;
      run.window = run.layout.mode === 'window' ? `window-${++windows}` : run.layout.window;
      run.layout.window = run.window;
      blocks.set(id, run.window); return id;
    },
    async control(run, action) { calls.push({ action, block: run.block }); if (action === 'close') blocks.delete(run.block); },
  };
}
function missingBlock(run) {
  return Object.assign(new Error(`block ${run.block} not found`), {
    code: 'REX_BLOCK_NOT_FOUND', block: run.block, rexSession: run.rexSession,
  });
}
async function create(root, client, kind = 'agent', owner = 'owner-123456') {
  return withLayoutLock(root, async () => {
    const options = { owner, kind, name: kind, task: 'task', cwd: root, rexSession: 'rex', anchor: 'parent' };
    options.layout = await choosePlacement(root, client, options);
    const run = await prepareRun(root, options, '');
    run.block = await client.open(run); run.status = 'running';
    await atomicJson(join(run.dir, 'run.json'), run); return run;
  });
}

test('concurrent agents fill two-pane groups; jobs and parent sessions have separate groups', async t => {
  const root = await temp(t), client = fakeRex();
  const agents = await Promise.all([create(root, client), create(root, client), create(root, client)]);
  assert.equal(agents[0].layout.title, 'Agents · owner-12');
  assert.equal(agents[1].layout.mode, 'split');
  assert.equal(agents[1].layout.direction, 'right');
  assert.equal(agents[1].window, agents[0].window);
  assert.equal(agents[2].layout.title, 'Agents 2 · owner-12');
  const job = await create(root, client, 'shell');
  assert.equal(job.layout.title, 'Jobs · owner-12');
  assert.notEqual(job.window, agents[0].window);
  const other = await create(join(root, 'other-parent'), client, 'agent', 'different');
  assert.equal(other.layout.mode, 'window');
  assert.equal(other.layout.title, 'Agents · differen');
});

test('layout reconstructs from manifests and ignores manually moved blocks', async t => {
  const root = await temp(t), client = fakeRex();
  const first = await create(root, client);
  client.blocks.set(first.block, 'user-tab');
  const next = await create(root, client);
  assert.equal(next.layout.mode, 'window');
  assert.equal(client.blocks.get(first.block), 'user-tab');
  const third = await create(root, client);
  assert.equal(third.layout.anchor, next.block);
  assert.equal(third.window, next.window);
});

test('closed group member frees its position; exited retained logs still occupy a pane', async t => {
  const root = await temp(t), client = fakeRex();
  const a = await create(root, client, 'shell'), b = await create(root, client, 'shell');
  await atomicJson(join(a.dir, 'exit.json'), { code: 0 });
  const c = await create(root, client, 'shell');
  assert.equal(c.layout.page, 2);
  b.closed = true; client.blocks.delete(b.block);
  await atomicJson(join(b.dir, 'run.json'), b);
  const d = await create(root, client, 'shell');
  assert.equal(d.layout.anchor, a.block);
});

test('unknown creation or failed inspection never silently creates more panes', async t => {
  const root = await temp(t), client = fakeRex();
  const run = await prepareRun(root, { kind: 'agent', name: 'lost', task: 'task', rexSession: 'rex', layout: { role: 'agents', page: 1 } }, '');
  await assert.rejects(create(root, client), /unresolved/);
  assert.equal(client.calls.length, 0);
  run.closed = true; await atomicJson(join(run.dir, 'run.json'), run);
  const first = await create(root, client);
  client.blocks.delete(first.block);
  await assert.rejects(create(root, client), /unavailable/);
  assert.equal(client.calls.length, 1);
});

test('only the exact Rex missing-block response is classified for recovery', async () => {
  const run = { block: 'block:missing', rexSession: 'session:owner' };
  for (const message of [
    '/usr/local/bin/rex: Error: block target "block:missing" not found\n',
    '/usr/local/bin/rex: Error: block target "block:other" not found\n',
    '/usr/local/bin/rex: Error: session target "session:owner" not found\n',
    '/usr/local/bin/rex: connection timed out',
    '/usr/local/bin/rex: ENOENT executable not found',
  ]) {
    const client = new Rex('/usr/local/bin/rex', async () => { throw new Error(message); });
    await assert.rejects(client.inspect(run), error => {
      const missing = message.includes('block target "block:missing"');
      assert.equal(error.code, missing ? 'REX_BLOCK_NOT_FOUND' : undefined);
      if (missing) { assert.equal(error.block, run.block); assert.equal(error.rexSession, run.rexSession); }
      return true;
    });
  }
});

for (const kind of ['agent', 'shell', 'btw']) test(`${kind}: absent exited panes retire automatically and no longer block creation`, async t => {
  const root = await temp(t), client = fakeRex();
  const run = await create(root, client, kind);
  const result = { status: 'completed', text: 'retained result' }, exit = { code: 0 };
  await atomicJson(join(run.dir, 'result.json'), result);
  await atomicJson(join(run.dir, 'exit.json'), exit);
  client.blocks.delete(run.block);
  const inspect = client.inspect;
  client.inspect = async r => { if (!client.blocks.has(r.block)) throw missingBlock(r); return inspect(r); };
  if (kind === 'btw') {
    assert.equal(await withLayoutLock(root, () => existingBtw(root, client, { rexSession: 'rex', task: 'new question' })), undefined);
    assert.equal((await readdir(run.dir)).some(f => f.startsWith('input-')), false);
  }
  const replacement = await create(root, client, kind);
  const retired = await readJson(join(run.dir, 'run.json'));
  assert.equal(retired.closed, true); assert.equal(retired.status, 'completed');
  assert.equal(retired.completedBeforeClose, true); assert.ok(retired.resolvedAt);
  assert.deepEqual(await readJson(join(run.dir, 'result.json')), result);
  assert.deepEqual(await readJson(join(run.dir, 'exit.json')), exit);
  assert.equal(client.calls.some(c => c.action === 'close'), false);
  if (kind === 'btw') assert.equal(replacement.layout.anchor, 'parent');
  else { assert.equal(replacement.layout.mode, 'window'); assert.equal(replacement.layout.page, 1); }
});

for (const kind of ['agent', 'btw']) test(`${kind}: ambiguous failures and missing exit evidence remain blocking`, async t => {
  const root = await temp(t), client = fakeRex(), run = await create(root, client, kind);
  const launch = () => kind === 'btw'
    ? withLayoutLock(root, () => existingBtw(root, client, { rexSession: 'rex', task: 'next' })) : create(root, client);
  const original = await readJson(join(run.dir, 'run.json'));
  client.inspect = async r => { throw missingBlock(r); };
  await assert.rejects(launch(), /not found/); // No exit.json, even if activity says idle.
  await atomicJson(join(run.dir, 'activity.json'), { process: 'idle' });
  await atomicJson(join(run.dir, 'exit.json'), {});
  await assert.rejects(launch(), /not found/);
  await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  client.inspect = async () => { throw new Error('connection timed out'); };
  await assert.rejects(launch(), /timed out/);
  client.inspect = async r => { throw { ...missingBlock(r), rexSession: 'another session' }; };
  await assert.rejects(launch());
  assert.deepEqual(await readJson(join(run.dir, 'run.json')), original);
  assert.equal(client.calls.length, 1);
  assert.equal((await readdir(run.dir)).some(f => f.startsWith('input-')), false);
});

test('retiring stale agent groups preserves failed/exited outcomes and concurrent placement', async t => {
  const root = await temp(t), client = fakeRex(), runs = [];
  for (let i = 0; i < 3; i++) runs.push(await create(root, client));
  for (let i = 0; i < runs.length; i++) {
    await atomicJson(join(runs[i].dir, 'exit.json'), { code: [0, 7, null][i] });
    client.blocks.delete(runs[i].block);
  }
  const inspect = client.inspect;
  client.inspect = async r => { if (!client.blocks.has(r.block)) throw missingBlock(r); return inspect(r); };
  const [a, b] = await Promise.all([create(root, client), create(root, client)]);
  assert.equal(a.layout.page, 1); assert.equal(a.layout.mode, 'window');
  assert.equal(b.layout.page, 1); assert.equal(b.layout.anchor, a.block);
  for (let i = 0; i < runs.length; i++) {
    const r = await readJson(join(runs[i].dir, 'run.json'));
    assert.equal(r.closed, true); assert.equal(r.status, i === 0 ? 'exited' : 'failed');
  }
});

test('BTW reuses the same session, queues literal questions, focuses on bare invocation and reopens after exit', async t => {
  const root = await temp(t), client = fakeRex();
  const run = await create(root, client, 'btw');
  assert.equal(run.layout.window, 'main');
  assert.equal(run.layout.direction, 'right');
  const reused = await existingBtw(root, client, { rexSession: 'rex', task: '/literal $(not a command)' });
  assert.equal(reused.id, run.id); assert.equal(reused.reused, true);
  const input = await readJson(join(run.dir, `input-${reused.request}.json`));
  assert.equal(input.text, '/literal $(not a command)');
  await existingBtw(root, client, { rexSession: 'rex' });
  assert.equal(client.calls.at(-1).action, 'focus');
  await assert.rejects(existingBtw(root, client, { rexSession: 'rex', task: 'different', cwd: '/different' }), /another cwd/);
  await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  assert.equal(await existingBtw(root, client, { rexSession: 'rex', task: 'restart' }), undefined);
  assert.equal(client.calls.at(-1).action, 'close');
  assert.equal((await readJson(join(run.dir, 'run.json'))).closed, true);
  const replacement = await create(root, client, 'btw');
  assert.notEqual(replacement.id, run.id);
  assert.equal(replacement.layout.anchor, 'parent');
});

test('window CLI has a group title, split targets exact owned block and preserves focus', async () => {
  const calls = [];
  const client = new Rex('rex', async (_bin, args) => { calls.push(args); return JSON.stringify({ block_ids: ['new'], window_id: 'w' }); });
  const run = { kind: 'agent', name: 'Review', cwd: '/tmp', rexSession: 'r', dir: '/tmp/job', layout: { mode: 'window', title: 'Agents · owner' } };
  await client.open(run, '/runner');
  assert.deepEqual(calls[0].slice(0, 3), ['window', 'new', 'Agents · owner']);
  assert.ok(!calls[0].includes('--label'));
  assert.ok(calls[0].includes('--focus=false'));
  run.layout = { mode: 'split', anchor: 'exact', window: 'w', direction: 'right' };
  await client.open(run, '/runner');
  assert.deepEqual(calls[1].slice(0, 5), ['split', '-b', 'exact', '--split=right', '--ratio=50']);
});

test('task completion, idle Pi, retained exited process and closed block remain distinct', () => {
  assert.equal(runStates({}, undefined, { status: 'completed' }, { task: 'completed', process: 'idle' }).processState, 'idle');
  assert.equal(runStates({}, undefined, { status: 'completed' }, { task: 'running', process: 'running' }).taskState, 'running');
  const done = runStates({}, { code: 0 }, { status: 'completed' });
  assert.equal(done.taskState, 'completed'); assert.equal(done.processState, 'exited'); assert.equal(done.blockState, 'unverified');
  const closed = runStates({ closed: true, taskCompletedBeforeClose: true }, { code: null }, { status: 'completed' });
  assert.equal(closed.taskState, 'completed'); assert.equal(closed.blockState, 'closed');
});

test('BTW input bridge defers while busy, batches input and does not replay after reload', async t => {
  const root = await temp(t), events = {}, entries = [], sent = [];
  let idle = false;
  const ctx = { isIdle: () => idle, hasUI: false, sessionManager: { getEntries: () => entries, getBranch: () => [{ type: 'message' }] } };
  registerChild({ on: (name, handler) => { events[name] = handler; }, registerCommand() {},
    sendUserMessage: (text, options) => { sent.push({ text, options }); entries.push({ type: 'message', message: { role: 'user', content: text } }); },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  }, root);
  t.after(() => events.session_shutdown());
  await events.session_start({}, ctx);
  for (let i = 0; i < 2; i++) await atomicJson(join(root, `input-${i}.json`), { id: `${i}`, text: `question ${i}`, createdAt: `${i}` });
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(sent.length, 0);
  idle = true;
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /question 0\n\nquestion 1/);
  assert.equal(sent[0].options.expandPromptTemplates, false);
  await events.session_start({}, ctx);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(sent.length, 1);
});

test('adapter serializes simultaneous BTW launches into one block and restores it after reload', async t => {
  const root = await temp(t), client = fakeRex(), events = {}, tools = {};
  const previous = { session: process.env.REX_SESSION, block: process.env.REX_BLOCK };
  process.env.REX_SESSION = 'rex'; process.env.REX_BLOCK = 'parent';
  t.after(() => {
    for (const [key, value] of [['REX_SESSION', previous.session], ['REX_BLOCK', previous.block]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  adapter({ on: (name, handler) => { events[name] = handler; }, registerCommand() {}, registerTool: tool => { tools[tool.name] = tool; },
    getThinkingLevel: () => 'off', sendMessage() {},
  }, { rex: client });
  const ctx = { cwd: root, hasUI: false, isIdle: () => false, sessionManager: {
    getSessionDir: () => root, getSessionId: () => 'owner', getEntries: () => [], getBranch: () => [],
  } };
  t.after(() => events.session_shutdown());
  await events.session_start({}, ctx);
  const launch = task => tools.btw.execute('call', { task }, undefined, undefined, ctx);
  const [a, b] = await Promise.all([launch('first'), launch('second')]);
  assert.equal(a.isError, undefined); assert.equal(b.isError, undefined);
  assert.equal(a.details.id, b.details.id); assert.equal(b.details.reused, true);
  assert.equal(client.calls.length, 1);
  await events.session_start({}, ctx);
  const c = await launch('third');
  assert.equal(c.details.id, a.details.id);
  assert.equal((await listRuns(join(root, 'rex-adapter', 'owner'))).length, 1);
  const files = await readdir(a.details.artifacts);
  assert.equal(files.filter(f => f.startsWith('input-')).length, 2);
});

test('new child does not let queued input overtake the initial CLI task', async t => {
  const root = await temp(t), events = {}, sent = [], entries = [];
  const ctx = { isIdle: () => true, hasUI: false, sessionManager: { getEntries: () => entries, getBranch: () => [] } };
  registerChild({ on: (name, handler) => { events[name] = handler; }, registerCommand() {},
    sendUserMessage: text => sent.push(text), appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  }, root);
  t.after(() => events.session_shutdown());
  await events.session_start({}, ctx);
  await atomicJson(join(root, 'input-1.json'), { id: '1', text: 'second task', createdAt: '1' });
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(sent.length, 0);
  await events.agent_settled({ aborted: false }, ctx);
  await new Promise(r => setTimeout(r, 1100));
  assert.deepEqual(sent, ['second task']);
});

test('closed Jobs pages do not advance the next page number', async t => {
  const root = await temp(t), client = fakeRex();
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await create(root, client, 'shell'));
  assert.equal(runs.at(-1).layout.page, 3);
  for (const run of runs.slice(2)) {
    run.closed = true; await atomicJson(join(run.dir, 'run.json'), run); client.blocks.delete(run.block);
  }
  const next = await create(root, client, 'shell');
  assert.equal(next.layout.page, 2);
  assert.equal(next.layout.title, 'Jobs 2 · owner-12');
});
