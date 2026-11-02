import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.mjs';
import { overviewLines, rowLabel } from '../src/overview.mjs';
import { dialogComponent } from '../src/dialog.mjs';
import { prepareRun, atomicJson } from '../src/core.mjs';
import { registerChild } from '../src/child.mjs';
import adapter from '../src/index.mjs';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rex-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function settings(dir, value) {
  await mkdir(join(dir, '.pi'), { recursive: true });
  await writeFile(join(dir, '.pi', 'rex.json'), JSON.stringify(value));
}
function envFor(t, dir) {
  const previous = Object.fromEntries(['PI_CODING_AGENT_DIR', 'REX_SESSION', 'REX_BLOCK'].map(k => [k, process.env[k]]));
  process.env.PI_CODING_AGENT_DIR = join(dir, 'global');
  process.env.REX_SESSION = 'rex'; process.env.REX_BLOCK = 'parent';
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}

test('missing configuration defaults to English and two panes without creating files', async t => {
  const dir = await temp(t);
  assert.deepEqual(await loadConfig(dir, { env: {}, home: dir }), { config: DEFAULT_CONFIG, errors: [] });
});

test('project overrides only its fields and respects a custom Pi agent directory', async t => {
  const dir = await temp(t), global = join(dir, 'custom-agent');
  await mkdir(global); await writeFile(join(global, 'rex.json'), JSON.stringify({ language: 'zh', panesPerTab: 4 }));
  await settings(dir, { panesPerTab: 1 });
  const loaded = await loadConfig(dir, { env: { PI_CODING_AGENT_DIR: '~/custom-agent' }, home: dir });
  assert.deepEqual(loaded, { config: { language: 'zh', panesPerTab: 1 }, errors: [] });
});

test('bad fields retain valid inherited values and malformed JSON is reported without crashing', async t => {
  const dir = await temp(t), global = join(dir, '.pi', 'agent');
  await mkdir(global, { recursive: true });
  await writeFile(join(global, 'rex.json'), JSON.stringify({ language: 'zh', panesPerTab: 3 }));
  for (const panesPerTab of [0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
    await settings(dir, { language: 'xx', panesPerTab, extra: true });
    const loaded = await loadConfig(dir, { env: {}, home: dir });
    assert.deepEqual(loaded.config, { language: 'zh', panesPerTab: 3 });
    assert.equal(loaded.errors.length, 3);
    assert.ok(loaded.errors.every(error => error.includes(join(dir, '.pi', 'rex.json'))));
  }
  for (const content of ['{', 'null', '[]']) {
    await writeFile(join(dir, '.pi', 'rex.json'), content);
    const loaded = await loadConfig(dir, { env: {}, home: dir });
    assert.equal(loaded.errors.length, 1);
    assert.deepEqual(loaded.config, { language: 'zh', panesPerTab: 3 });
  }
});

function harness(dir, t) {
  const events = {}, commands = {}, tools = {}, widgets = [], statuses = [], entries = [];
  const blocks = new Map([['parent', 'main']]);
  const layouts = []; let serial = 0;
  const client = {
    inspect: async r => { assert.ok(blocks.has(r.block)); return { window: blocks.get(r.block) }; },
    open: async run => {
      const block = `b-${++serial}`;
      run.window = run.layout.window || `w-${serial}`; run.layout.window = run.window;
      blocks.set(block, run.window); layouts.push({ ...run.layout }); return block;
    },
  };
  const ctx = { cwd: dir, hasUI: true, isIdle: () => false,
    sessionManager: { getSessionDir: () => dir, getSessionId: () => 'parent', getEntries: () => entries, getBranch: () => entries },
    ui: { setWidget: (_id, widget) => widgets.push(widget), setStatus: (_id, status) => statuses.push(status), notify() {} },
  };
  adapter({ on: (n, f) => { events[n] = f; }, registerCommand: (n, c) => { commands[n] = c; }, registerTool: tool => { tools[tool.name] = tool; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }), getThinkingLevel: () => 'off',
  }, { rex: client });
  t.after(() => events.session_shutdown());
  return { ctx, events, tools, commands, widgets, statuses, layouts, blocks,
    launch: (kind, task) => tools[kind].execute('call', kind === 'bg_run' ? { command: task } : { task }, undefined, undefined, ctx) };
}

test('configured cap applies to agent and shell tabs, reload respects existing panes, BTW stays beside parent', async t => {
  const dir = await temp(t); envFor(t, dir); await settings(dir, { panesPerTab: 3 });
  const h = harness(dir, t); await h.events.session_start({}, h.ctx);
  for (const kind of ['subagent', 'bg_run']) {
    const start = h.layouts.length;
    for (let i = 0; i < 4; i++) assert.equal((await h.launch(kind, `task ${i}`)).isError, undefined);
    const group = h.layouts.slice(start);
    assert.deepEqual(group.map(x => x.mode), ['window', 'split', 'split', 'window']);
    assert.ok(group.slice(1, 3).every(x => x.direction === 'right' && x.window === group[0].window));
    assert.equal(group[3].page, 2);
  }
  const before = [...h.blocks];
  await settings(dir, { panesPerTab: 1 }); await h.events.session_start({}, h.ctx);
  assert.deepEqual([...h.blocks], before); // No existing layout is moved or resized.
  assert.equal((await h.launch('subagent', 'after reduction')).isError, undefined);
  assert.equal(h.layouts.at(-1).mode, 'window');
  assert.equal(h.layouts.at(-1).page, 3);
  assert.equal((await h.launch('btw', 'side question')).isError, undefined);
  assert.equal(h.layouts.at(-1).mode, 'split'); assert.equal(h.layouts.at(-1).anchor, 'parent');
});

test('main-agent overview, footer and task manager switch language on reload; English is the default', async t => {
  const dir = await temp(t); envFor(t, dir);
  const run = await prepareRun(join(dir, 'rex-adapter', 'parent'), { kind: 'agent', name: 'review', task: 'Review code' }, '');
  await atomicJson(join(run.dir, 'activity.json'), { task: 'running', process: 'running' });
  const h = harness(dir, t);
  for (const language of ['en', 'zh', 'en']) {
    if (language === 'zh' || h.widgets.length) await settings(dir, { language });
    await h.events.session_start({}, h.ctx);
    const widget = h.widgets.at(-1)().render(100).join('\n');
    assert.match(widget, language === 'en' ? /Rex Tasks[\s\S]*Running/ : /Rex 任务[\s\S]*运行中/);
    assert.ok(h.statuses.includes(language === 'en' ? 'Rex: 1 active' : 'Rex：1 项活跃任务'));
    let screen;
    h.ctx.ui.custom = async factory => {
      const component = factory({ terminal: { rows: 24 }, requestRender() {} }, {}, { matches: () => false }, () => {});
      screen = component.render(84).join('\n'); return undefined;
    };
    await h.commands['rex-tasks'].handler('', h.ctx);
    assert.match(screen, language === 'en' ? /Hide main-page overview/ : /隐藏主页面概览/);
    assert.match(screen, language === 'en' ? /Esc Back/ : /Esc 返回/);
    if (language === 'en') assert.doesNotMatch(screen + widget, /\p{Script=Han}/u);
  }
});

test('all visible states translate; language never rewrites task text or machine states', () => {
  const states = ['running', 'completed', 'failed', 'interrupted', 'cancelled', 'launching', 'uncertain', 'exited'];
  for (const taskState of states) {
    const row = { kind: 'agent', name: 'review', taskState, processState: 'idle' };
    assert.doesNotMatch(rowLabel(row), /\p{Script=Han}/u);
    assert.match(rowLabel(row, 'zh'), /\p{Script=Han}/u);
    assert.equal(row.taskState, taskState);
  }
  const lines = overviewLines([{ id: 'a', kind: 'agent', name: 'review', taskState: 'running', task: '保留用户原文' }], 120);
  assert.match(lines.join('\n'), /Running.*保留用户原文/);
  for (const language of ['en', 'zh']) {
    const viewer = dialogComponent({ tui: { terminal: { rows: 24 } }, theme: {}, keys: {}, done() {}, title: 'Logs', text: 'output', language });
    assert.match(viewer.render(84).join('\n'), language === 'en' ? /Scroll.*Esc Back/ : /滚动.*Esc 返回/);
  }
});

test('child UI uses the parent configuration directory even when delegated cwd differs', async t => {
  const dir = await temp(t); envFor(t, dir);
  const childCwd = join(dir, 'checkout'); await settings(childCwd, { language: 'en' });
  await settings(dir, { language: 'zh' });
  const run = await prepareRun(join(dir, 'runs'), { kind: 'btw', name: 'side', task: 'question', cwd: childCwd, configCwd: dir }, '');
  const events = {}, commands = {}, notices = [];
  const ctx = { cwd: childCwd, hasUI: true, isIdle: () => false,
    sessionManager: { getEntries: () => [], getBranch: () => [] }, ui: { notify: text => notices.push(text), setStatus() {} } };
  registerChild({ on: (n, f) => { events[n] = f; }, registerCommand: (n, c) => { commands[n] = c; } }, run.dir);
  t.after(() => events.session_shutdown());
  await events.session_start({}, ctx);
  await commands['btw-return'].handler('answer', ctx);
  assert.equal(notices.at(-1), '结论已排入主会话接收队列');
  await settings(dir, { language: 'en' }); await events.session_start({}, ctx);
  await commands['btw-return'].handler('answer', ctx);
  assert.equal(notices.at(-1), 'Conclusion queued for the parent session');
});
