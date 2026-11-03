import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { shellStart, shellEnd } from '../src/shell-display.mjs';

test('shell display shows the complete multiline command and native working status', () => {
  const task = `printf start\n${'echo long-command; '.repeat(2000)}\nprintf done`;
  const output = shellStart({ name: 'Build', cwd: '/tmp/a b', task });
  const visible = stripVTControlCharacters(output);
  assert.match(visible, /Shell · Build\nWorking directory: \/tmp\/a b/);
  assert.ok(visible.includes(task.split('\n').map((s, i) => `${i ? '> ' : '$ '}${s}`).join('\n')));
  assert.match(output, /\x1b\]2;Shell · Build\x1b\\/);
  assert.match(output, /7501;id=rex-shell:state=working/);
  const status = output.match(/\x1b\]7501;[^\x1b]+\x1b\\/)[0];
  assert.ok(Buffer.byteLength(status) < 4096);
});

test('shell metadata cannot inject terminal controls and protocol fields stay valid', () => {
  const output = shellStart({ name: '\x1b]52;c;BAD\x07中文'.repeat(100), cwd: '/tmp/\x1b[2Jdir', task: 'echo \x1b[2Jhello\u202e' });
  assert.doesNotMatch(output, /\x1b\]52|\x1b\[2J|\u202e/);
  const title = output.match(/:title=([^:]+):msg=/)[1];
  assert.ok(Buffer.byteLength(Buffer.from(title, 'base64')) <= 192);
  assert.doesNotMatch(Buffer.from(title, 'base64').toString('utf8'), /\ufffd/);
});

test('shell endings expose completion, error, interruption and silence in the selected language', () => {
  const run = { name: 'Build' };
  const done = shellEnd(run, { code: 0, elapsedMs: 1234, hasOutput: false });
  assert.match(stripVTControlCharacters(done), /no output.*\nCompleted · exit=0 · 1.2s/);
  assert.match(done, /state=done/);
  const failed = shellEnd(run, { code: 7, error: 'command failed', elapsedMs: 2500, hasOutput: true }, 'zh');
  assert.match(stripVTControlCharacters(failed), /command failed\n失败 · exit=7 · 2.5s/);
  assert.match(failed, /state=error/);
  const cancelled = shellEnd(run, { code: null, signal: 'SIGTERM', elapsedMs: 100, hasOutput: true });
  assert.match(cancelled, /state=idle/);
  assert.match(stripVTControlCharacters(cancelled), /Interrupted · exit=SIGTERM/);
});
