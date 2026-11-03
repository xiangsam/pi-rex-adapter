import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRun, piArgs } from '../src/core.mjs';
import { registerChild } from '../src/child.mjs';

async function fixture(t, kind = 'agent', language = 'en', hasUI = true) {
  const root = await mkdtemp(join(tmpdir(), 'rex-child-ui-'));
  await mkdir(join(root, '.pi'));
  await writeFile(join(root, '.pi', 'rex.json'), JSON.stringify({ language }));
  const run = await prepareRun(root, { kind, name: 'Review', task: '\x1b[31mInspect the diff\ncarefully', cwd: root }, '');
  const events = {}, commands = {}, statuses = [], widgets = [], entries = [], notices = [];
  const ctx = { hasUI, cwd: root, isIdle: () => true,
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    ui: { setStatus: (...args) => statuses.push(args), setWidget: (...args) => widgets.push(args),
      notify: (...args) => notices.push(args),
      setTitle() { assert.fail('Pi owns the terminal title'); },
      setHeader() { assert.fail('Do not replace the Pi header'); },
    },
  };
  registerChild({ on: (name, handler) => { events[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command; } }, run.dir);
  t.after(async () => { events.session_shutdown(); await rm(root, { recursive: true, force: true }); });
  await events.session_start({}, ctx);
  const state = () => statuses.filter(([key]) => key === 'rex-child').at(-1)?.[1];
  const answer = (stopReason = 'stop') => {
    entries.push({ type: 'message', message: { role: 'assistant', content: 'Answer', stopReason } });
  };
  return { run, events, commands, ctx, statuses, widgets, notices, state, answer };
}

test('agent displays one bounded assignment line and reports queued results without claiming delivery', async t => {
  const h = await fixture(t);
  assert.equal(h.state(), 'Agent · Starting');
  const widget = h.widgets.find(([key, value]) => key === 'rex-assignment' && value)[1]({}, {});
  assert.deepEqual(widget.render(0), []);
  assert.equal(widget.render(24).length, 1);
  assert.ok(widget.render(24)[0].length <= 24);
  assert.doesNotMatch(widget.render(100)[0], /\x1b|\n/);
  assert.match(widget.render(100)[0], /Assigned task: Inspect the diff carefully/);
  await h.events.agent_start();
  assert.equal(h.state(), 'Agent · Running');
  const count = h.statuses.length;
  await h.events.agent_start();
  assert.equal(h.statuses.length, count);
  h.answer(); await h.events.agent_settled({ aborted: false }, h.ctx);
  assert.equal(h.state(), 'Agent · Result queued · awaiting parent review');
  assert.equal((await readdir(h.run.dir)).filter(f => f.startsWith('turn-')).length, 1);
  await h.events.session_start({}, h.ctx);
  assert.equal(h.state(), 'Agent · Result queued · awaiting parent review');
  h.events.session_shutdown();
  assert.equal(h.state(), undefined);
  assert.equal(h.widgets.at(-1)[1], undefined);
});

test('BTW return remains optional in English and Chinese; ordinary answers create no return file', async t => {
  for (const language of ['en', 'zh']) {
    const h = await fixture(t, 'btw', language);
    const widget = h.widgets.find(([key, value]) => key === 'rex-assignment' && value)[1]({}, {});
    assert.match(widget.render(100)[0], language === 'en' ? /Side topic:/ : /侧聊主题：/);
    h.answer(); await h.events.agent_settled({ aborted: false }, h.ctx);
    assert.equal(h.state(), language === 'en'
      ? 'BTW · Answer ready · optionally share with /btw-return'
      : 'BTW · 答案已就绪 · 可用 /btw-return 回传');
    assert.equal((await readdir(h.run.dir)).filter(f => /^(turn|return)-/.test(f)).length, 0);
    assert.equal(h.notices.length, 0);
    await h.commands['btw-return'].handler('Share this', h.ctx);
    assert.equal((await readdir(h.run.dir)).filter(f => f.startsWith('return-')).length, 1);
    assert.equal(h.state(), language === 'en'
      ? 'BTW · Conclusion queued · ready to continue' : 'BTW · 结论已排队 · 可继续侧聊');
    await h.events.agent_start();
    assert.equal(h.state(), language === 'en' ? 'BTW · Running' : 'BTW · 运行中');
  }
});

test('failed and interrupted turns remain distinguishable, and headless children add no UI', async t => {
  const h = await fixture(t, 'agent', 'zh');
  h.answer('error'); await h.events.agent_settled({ aborted: false }, h.ctx);
  assert.equal(h.state(), 'Agent · 失败');
  await h.events.agent_settled({ aborted: true }, h.ctx);
  assert.equal(h.state(), 'Agent · 已中断');
  const headless = await fixture(t, 'agent', 'en', false);
  await headless.events.agent_start();
  headless.answer(); await headless.events.agent_settled({ aborted: false }, headless.ctx);
  assert.deepEqual(headless.statuses, []); assert.deepEqual(headless.widgets, []);
});

test('child session names identify their role while agent-only approval remains scoped', () => {
  for (const kind of ['agent', 'btw']) {
    const args = piArgs({ kind, name: 'Review', dir: '/tmp/task' }, '/tmp/extension.mjs');
    assert.equal(args[args.indexOf('--name') + 1], `${kind === 'agent' ? 'Agent' : 'BTW'} · Review`);
    assert.equal(args.includes('--approve'), kind === 'agent');
    assert.equal(args.includes('--print'), false);
  }
});
