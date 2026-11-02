import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import adapter from '../src/index.mjs';
import { prepareRun, atomicJson, readJson } from '../src/core.mjs';
import { overviewLines, fit, orderRows, activeOverviewRows } from '../src/overview.mjs';

async function fixture(t, control) {
  const dir = await mkdtemp(join(tmpdir(), 'rex-overview-'));
  const events = {}, commands = {}, tools = {}, entries = [], widgets = [], messages = [], calls = [];
  const ctx = { cwd: dir, hasUI: true, isIdle: () => false,
    sessionManager: { getSessionDir: () => dir, getSessionId: () => 'parent', getEntries: () => entries },
    ui: { setWidget: (...args) => widgets.push(args), setStatus() {}, notify() {} },
  };
  adapter({ on: (name, handler) => { events[name] = handler; }, registerCommand: (name, command) => { commands[name] = command; },
    registerTool: tool => { tools[tool.name] = tool; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendMessage: message => { messages.push(message); entries.push({ type: 'custom_message', ...message }); },
  }, { cleanupRetryMs: 100, rex: { control: async (...args) => { calls.push(args); return control?.(...args); }, inspect: async () => ({ window: 'window' }) } });
  const root = join(dir, 'rex-adapter', 'parent');
  const boundary = () => events.turn_end({ entries: [], context: { canContinue: true }, outcome: 'completed' }, ctx);
  t.after(async () => { events.session_shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { dir, root, events, commands, tools, entries, widgets, messages, calls, ctx, boundary };
}
async function until(predicate) {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('Timed out');
}
function driveOverlays(ctx, scripts) {
  ctx.ui.custom = async (factory, options) => {
    assert.equal(options.overlay, true);
    let result;
    const component = factory({ terminal: { rows: 24 }, requestRender() {} }, {},
      { matches: (data, key) => data === key }, value => { result = value; });
    component.render(100);
    const script = scripts.shift() || ['cancel'];
    if (typeof script === 'function') script(component);
    else for (const key of script) component.handleInput(`tui.select.${key}`);
    return result;
  };
}
async function task(root, kind, status = 'completed') {
  const run = await prepareRun(root, { kind, name: `${kind}-test`, task: `${kind} delegated task`, cwd: root, block: `${kind}-block` }, '');
  await atomicJson(join(run.dir, 'result.json'), { text: 'result text', status });
  if (kind === 'shell') await atomicJson(join(run.dir, 'exit.json'), { code: status === 'completed' ? 0 : 7 });
  else await atomicJson(join(run.dir, 'activity.json'), { task: status, process: status === 'running' ? 'running' : 'idle' });
  return run;
}

test('main-page widget shows active agents and shell tasks only; can hide and restore across reload', async t => {
  const h = await fixture(t);
  for (const kind of ['agent', 'shell', 'btw']) {
    const run = await task(h.root, kind, 'running');
    if (kind === 'shell') {
      await rm(join(run.dir, 'exit.json'));
      await atomicJson(join(run.dir, 'activity.json'), { task: 'running', process: 'running' });
    }
  }
  await h.events.session_start({}, h.ctx); await h.boundary();
  const widget = h.widgets.at(-1);
  assert.equal(widget[2].placement, 'aboveEditor');
  const lines = widget[1]().render(120).join('\n');
  for (const kind of ['agent', 'shell']) assert.match(lines, new RegExp(`${kind} delegated task`));
  assert.doesNotMatch(lines, /BTW|btw delegated|Pi idle|Closed/);
  assert.equal(widget[1]().render(120).length, 5);
  driveOverlays(h.ctx, [['confirm'], ['cancel']]);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.equal(h.widgets.at(-1)?.[1], undefined);
  await h.events.session_start({}, h.ctx); await h.boundary();
  assert.equal(h.widgets.at(-1)?.[1], undefined);
  driveOverlays(h.ctx, [['confirm'], ['cancel']]);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.equal(typeof h.widgets.at(-1)[1], 'function');
  h.events.session_shutdown(); assert.equal(h.widgets.at(-1)?.[1], undefined);
});

for (const status of ['completed', 'failed']) test(`shell ${status}: close only after its result is persisted, retain outcome and records`, async t => {
  const h = await fixture(t), run = await task(h.root, 'shell', status);
  await h.events.session_start({}, h.ctx);
  const batch = await h.boundary();
  assert.equal(h.calls.length, 0);
  h.entries.push(...batch.entries);
  await h.boundary();
  await until(async () => (await readJson(join(run.dir, 'run.json')))?.closed);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][1], 'close');
  assert.equal((await readJson(join(run.dir, 'run.json'))).closed, true);
  assert.equal((await readJson(join(run.dir, 'result.json'))).status, status);
  await h.boundary(); assert.equal(h.calls.length, 1);
});

test('agent remains open after delivery; main agent can finish only when completed and idle', async t => {
  const h = await fixture(t), run = await task(h.root, 'agent');
  await atomicJson(join(run.dir, 'turn-1.json'), { text: 'done', status: 'completed' });
  await h.events.session_start({}, h.ctx);
  const batch = await h.boundary();
  assert.match(batch.entries[0].content, /rex_finish/);
  h.entries.push(...batch.entries); await h.boundary();
  assert.equal(h.calls.length, 0);
  const finish = () => h.tools.rex_finish.execute('x', { id: run.id }, undefined, undefined, h.ctx);
  await atomicJson(join(run.dir, 'activity.json'), { task: 'running', process: 'running' });
  assert.equal((await finish()).isError, true); assert.equal(h.calls.length, 0);
  await atomicJson(join(run.dir, 'activity.json'), { task: 'completed', process: 'idle' });
  assert.equal((await finish()).isError, undefined); assert.equal(h.calls.length, 1);
  await finish(); assert.equal(h.calls.length, 1);
  const row = (await h.tools.rex_tasks.execute('x', {}, undefined, undefined, h.ctx)).details[0];
  assert.equal(row.taskState, 'completed'); assert.equal(row.blockState, 'closed');
});

test('finish rejects BTW and failed subagents', async t => {
  const h = await fixture(t);
  const btw = await task(h.root, 'btw'), failed = await task(h.root, 'agent', 'failed');
  await h.events.session_start({}, h.ctx);
  for (const run of [btw, failed]) {
    const result = await h.tools.rex_finish.execute('x', { id: run.id }, undefined, undefined, h.ctx);
    assert.equal(result.isError, true);
  }
  assert.equal(h.calls.length, 0);
});

test('automatic shell close failure keeps the terminal and result; subsequent reconciliation retries', async t => {
  let attempts = 0;
  const h = await fixture(t, () => { if (++attempts === 1) throw new Error('Rex unavailable'); });
  const run = await task(h.root, 'shell');
  await h.events.session_start({}, h.ctx);
  const batch = await h.boundary(); h.entries.push(...batch.entries);
  await h.boundary();
  await until(() => attempts === 1);
  assert.equal((await readJson(join(run.dir, 'run.json'))).closed, undefined);
  assert.equal(h.widgets.at(-1)?.[1], undefined); // Completed tasks live in the panel/history only.
  await until(async () => { await h.boundary(); return (await readJson(join(run.dir, 'run.json')))?.closed; });
  assert.equal(attempts, 2);
});

test('overview is bounded, prioritizes active tasks, and sanitizes terminal control input', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: `id-${i}`, name: `name-${i}`, kind: 'agent',
    task: '\x1b[31m中文任务\nnext\x1b]0;title\x07', closed: false, taskState: 'running',
    processState: i === 8 ? 'running' : 'exited', createdAt: '2026-01-01T00:00:00Z' }));
  assert.equal(orderRows(rows).length, 9);
  const lines = overviewLines(rows, 30);
  assert.equal(lines.length, 10);
  assert.ok(lines.every(line => !/[\x00-\x1f\x7f]/.test(line)));
  assert.match(lines.at(-2), /3 more/);
  assert.equal(fit('中文中文', 5), '中文…');
  assert.equal(fit('abc', 0), '');
});

test('panel maps selected task to owned full ID and rejects actions after session switch', async t => {
  const h = await fixture(t); await task(h.root, 'agent');
  await h.events.session_start({}, h.ctx); await h.boundary();
  driveOverlays(h.ctx, [['down', 'confirm'], component => {
    h.events.session_shutdown(); component.handleInput('tui.select.confirm');
  }]);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.equal(h.calls.length, 0);
});


test('completed, failed, interrupted, cancelled, closed and BTW tasks are hidden; history is unchanged', () => {
  const rows = ['completed', 'failed', 'interrupted', 'cancelled', 'exited'].map((taskState, i) => ({
    id: `${i}`, kind: 'agent', taskState, closed: false,
  }));
  rows.push({ id: 'btw', kind: 'btw', taskState: 'running' }, { id: 'closed', kind: 'shell', taskState: 'running', closed: true });
  assert.deepEqual(activeOverviewRows(rows), []);
  assert.deepEqual(overviewLines(rows, 80), []);
  assert.equal(rows.length, 7);
});

test('widget disappears as the last running task completes without deleting panel history', async t => {
  const h = await fixture(t), run = await task(h.root, 'agent', 'running');
  await h.events.session_start({}, h.ctx); await h.boundary();
  assert.equal(typeof h.widgets.at(-1)[1], 'function');
  await atomicJson(join(run.dir, 'result.json'), { text: 'done', status: 'completed' });
  await atomicJson(join(run.dir, 'activity.json'), { task: 'completed', process: 'idle' });
  await h.boundary();
  await until(() => h.widgets.at(-1)[1] === undefined);
  const history = await h.tools.rex_tasks.execute('x', {}, undefined, undefined, h.ctx);
  assert.equal(history.details.length, 1);
  assert.equal(history.details[0].taskState, 'completed');
});

test('compact theme uses desaturated blue title/rules and muted one-line task text', () => {
  const tokens = [];
  const theme = { fg: (token, text) => { tokens.push(token); return text; }, style: (text, options) => { tokens.push(options.fg); return text; } };
  const rows = [{ id: 'a', kind: 'agent', taskState: 'running', name: 'review', task: 'Review the change' }];
  const lines = overviewLines(rows, 80, theme);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '─'.repeat(80));
  assert.equal(lines.at(-1), lines[0]);
  assert.match(lines[2], /review.*Review the change/);
  assert.ok(tokens.some(token => token?.kind === 'rgb' && token.r === 126 && token.g === 152 && token.b === 173));
  assert.ok(!tokens.includes('warning')); assert.ok(tokens.includes('muted'));
});

test('task list and details stay in overlays, with no notification or transcript dump', async t => {
  const h = await fixture(t); await task(h.root, 'agent');
  await h.events.session_start({}, h.ctx); await h.boundary();
  let notices = 0;
  h.ctx.ui.notify = () => { notices++; };
  driveOverlays(h.ctx, [['down', 'confirm'], ['confirm'], ['cancel'], ['cancel']]);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.equal(notices, 0); assert.equal(h.messages.length, 0);
  assert.deepEqual(Object.keys(h.commands).sort(), ['bg', 'btw', 'rex-agent', 'rex-tasks']);
});
