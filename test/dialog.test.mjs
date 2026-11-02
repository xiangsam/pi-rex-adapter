import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogComponent, createDialogs, wrapText } from '../src/dialog.mjs';

function component(config) {
  const results = [];
  const tui = { terminal: { rows: 16 }, requestRender() {} };
  return { tui, results, component: dialogComponent({ tui, theme: {},
    keys: { matches: (data, key) => data === key }, done: value => results.push(value), ...config }) };
}

test('floating menu scrolls, follows selection after resize, and returns stable task IDs', () => {
  const h = component({ title: 'Rex Tasks', choices: Array.from({ length: 40 }, (_, i) => ({ label: `Task ${i}`, value: `uuid-${i}` })) });
  h.component.render(50);
  for (let i = 0; i < 12; i++) h.component.handleInput('tui.select.down');
  h.tui.terminal.rows = 10;
  const lines = h.component.render(35);
  assert.ok(lines.length <= 8);
  assert.match(lines.join('\n'), /› Task 12/);
  h.component.handleInput('tui.select.confirm');
  assert.deepEqual(h.results, ['uuid-12']);
});

test('detail viewer wraps long lines, preserves indentation and scrolls without altering content', () => {
  const text = Array.from({ length: 60 }, (_, i) => `  line ${i}: ${'中文'.repeat(20)}`).join('\n');
  assert.ok(wrapText(text, 40)[0].startsWith('  line 0'));
  const h = component({ title: 'Logs', text });
  const initial = h.component.render(40).join('\n');
  assert.match(initial, /line 0/);
  h.component.handleInput('tui.select.pageDown');
  const scrolled = h.component.render(40).join('\n');
  assert.notEqual(scrolled, initial);
  assert.doesNotMatch(scrolled, /line 0:/);
  h.component.handleInput('tui.select.pageUp');
  assert.equal(h.component.render(40).join('\n'), initial);
  h.component.handleInput('tui.select.cancel');
  assert.deepEqual(h.results, [undefined]);
});

test('viewer strips injected terminal commands and fits a narrow terminal', () => {
  const h = component({ title: 'Details', text: '\x1b]0;evil\x07\x1b[31m中文\n  log\x00' });
  for (const width of [1, 8, 20]) {
    const lines = h.component.render(width);
    assert.ok(lines.every(line => !/[\x00-\x1f\x7f]/.test(line)));
    assert.ok(lines.every(line => [...line].reduce((n, ch) => n + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0) <= width));
  }
});

test('session shutdown dismisses active overlays and resolves their promises', async () => {
  const dialogs = createDialogs();
  let overlay;
  const ctx = { hasUI: true, ui: { custom: (factory, options) => new Promise(resolve => {
    assert.equal(options.overlay, true); assert.equal(options.overlayOptions.anchor, 'center'); assert.equal(options.overlayOptions.width, 84);
    overlay = factory({ terminal: { rows: 24 }, requestRender() {} }, {}, { matches() { return false; } }, resolve);
  }) } };
  const pending = dialogs.view(ctx, 'Task details', 'body');
  assert.match(overlay.render(60).join('\n'), /body/);
  dialogs.closeAll();
  assert.equal(await pending, undefined);
  dialogs.closeAll();
});

test('empty task panel has a bounded opaque frame, padding and a separate selected row', () => {
  const styles = [];
  const theme = { style: (text, options) => { styles.push(options); return text; } };
  const h = component({ title: 'Rex Tasks', theme, description: '暂无任务\n使用 /bg 或 /rex-agent 启动任务。',
    choices: [{ label: '隐藏主页面概览', value: 'toggle' }] });
  h.tui.terminal.rows = 30;
  const lines = h.component.render(84);
  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines.at(-1), /^╰─+╯$/);
  assert.match(lines.join('\n'), /│  Rex Tasks/);
  assert.match(lines.join('\n'), /暂无任务/);
  assert.match(lines.join('\n'), /使用 \/bg 或 \/rex-agent/);
  assert.ok(lines.slice(1, -1).every(line => line.startsWith('│') && line.endsWith('│')));
  assert.ok(styles.every(style => style.bg?.kind === 'rgb'));
  assert.ok(styles.some(style => style.bg.r === 40 && style.bg.g === 60 && style.bg.b === 79));
  assert.ok(styles.some(style => style.bold));
});

test('large task lists remain scrollable inside the frame without overflowing the height budget', () => {
  const h = component({ title: 'Rex Tasks', description: '80 项任务',
    choices: Array.from({ length: 80 }, (_, i) => ({ label: `Task ${i}`, value: `${i}` })) });
  for (const rows of [10, 16, 30]) {
    h.tui.terminal.rows = rows;
    const lines = h.component.render(50);
    assert.ok(lines.length <= Math.floor(rows * 0.8));
    assert.match(lines.at(-1), /^╰/);
  }
});

test('reopening a menu restores selected ID and scroll offset after viewing details', () => {
  const state = {};
  const config = { title: 'Tasks', state, choices: Array.from({ length: 40 }, (_, i) => ({ label: `Task ${i}`, value: `id-${i}` })) };
  const first = component(config);
  first.component.render(60);
  for (let i = 0; i < 19; i++) first.component.handleInput('tui.select.down');
  const expected = first.component.render(60);
  first.component.handleInput('tui.select.confirm');
  assert.equal(state.value, 'id-19'); assert.ok(state.offset > 0);
  const reopened = component(config);
  assert.deepEqual(reopened.component.render(60), expected);
  reopened.component.handleInput('tui.select.confirm');
  assert.deepEqual(reopened.results, ['id-19']);
});
