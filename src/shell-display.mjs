import { stripVTControlCharacters } from 'node:util';
import { t } from './i18n.mjs';

// Keep command newlines/indentation, but never interpret its terminal controls.
const clean = value => stripVTControlCharacters(String(value ?? ''))
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
function line(value, bytes = 180) {
  let output = '';
  for (const ch of clean(value).replace(/\s+/g, ' ').trim()) {
    if (Buffer.byteLength(output + ch) > bytes) break;
    output += ch;
  }
  return output;
}
const blue = text => `\x1b[38;2;126;152;173m${text}\x1b[0m`;
function report(run, state, message) {
  const title = Buffer.from(line(run.name || 'Shell')).toString('base64');
  const msg = Buffer.from(line(message, 1800)).toString('base64');
  return `\x1b]7501;id=rex-shell:state=${state}:app=shell:title=${title}:msg=${msg}\x1b\\`;
}
export function shellStart(run, language = 'en') {
  const title = `Shell · ${line(run.name || run.task)}`;
  const command = clean(run.task).split('\n').map((text, i) => `${i ? '> ' : '$ '}${text}`).join('\n');
  return `\x1b]2;${title}\x1b\\${report(run, 'working', run.task)}` +
    `${blue(title)}\n${t(language, 'cwd', { value: line(run.cwd, 4096) })}\n${command}\n${blue(t(language, 'shellRunning'))}\n\n`;
}
export function shellEnd(run, { code, error, signal, elapsedMs, hasOutput }, language = 'en') {
  const state = signal ? 'idle' : code === 0 ? 'done' : 'error';
  const outcome = t(language, signal ? 'interrupted' : code === 0 ? 'completed' : 'failed');
  const summary = `${outcome} · exit=${code ?? signal ?? 'unknown'} · ${(elapsedMs / 1000).toFixed(1)}s`;
  return `\n${!hasOutput ? `${t(language, 'shellNoOutput')}\n` : ''}` +
    `${error ? `${line(error, 1800)}\n` : ''}${blue(summary)}\n${report(run, state, summary)}`;
}
