import { stripVTControlCharacters } from 'node:util';
import { runStates } from './core.mjs';
import { t } from './i18n.mjs';

export function plain(value) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Conservative display width: non-ASCII graphemes reserve two columns. No
// terminal escapes are accepted from task names/output; narrow panes stay safe.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function fit(text, width) {
  if (width <= 0) return '';
  const parts = [...segmenter.segment(plain(text))].map(x => x.segment);
  const size = s => /^[\x20-\x7e]+$/.test(s) ? s.length : 2;
  if (parts.reduce((n, s) => n + size(s), 0) <= width) return parts.join('');
  let output = '', used = 0;
  for (const part of parts) {
    if (used + size(part) > width - 1) break;
    output += part; used += size(part);
  }
  return output + '…';
}
export function taskRow(run, exit, result, activity, language = 'en') {
  return { id: run.id, block: run.block, name: run.name, kind: run.kind, task: run.task,
    cwd: run.cwd, createdAt: run.createdAt, artifacts: run.dir,
    ...runStates(run, exit, result, activity), closed: Boolean(run.closed),
    summary: result?.text || (exit ? t(language, 'noSummary') : undefined), resultAvailable: Boolean(result), error: exit?.error || run.error, exitCode: exit?.code };
}
const kinds = { agent: 'Agent', shell: 'Shell', btw: 'BTW' };
export function rowLabel(row, language = 'en') {
  const process = row.closed ? t(language, 'closed') : row.processState === 'idle' ? t(language, 'idle')
    : row.processState === 'exited' ? t(language, 'processExited') : row.processState === 'unknown' ? t(language, 'processUnknown') : '';
  const delivery = row.kind === 'agent' && row.taskState === 'completed' && !row.closed && row.deliveryState
    ? t(language, `delivery_${row.deliveryState}`) : undefined;
  return `[${kinds[row.kind] || row.kind}] ${delivery ? fit(row.name, 28) : plain(row.name)} · ${delivery || `${t(language, row.taskState)}${process ? ` / ${process}` : ''}`}${row.cleanupError ? ` · ${t(language, 'cleanupFailed')}` : ''}`;
}
function rank(row) {
  if (row.closed) return 3;
  if (['running', 'launching', 'uncertain'].includes(row.taskState)) return 0;
  return row.taskState === 'failed' ? 1 : 2;
}
export function orderRows(rows) {
  return [...rows].sort((a, b) => rank(a) - rank(b) || String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
}
export function activeOverviewRows(rows) {
  return orderRows(rows.filter(row => row.kind !== 'btw' && !row.closed &&
    ['running', 'launching', 'uncertain'].includes(row.taskState)));
}
// Desaturated slate blue (#7e98ad); Theme.style handles truecolor/256-color.
export function softBlue(theme, text) {
  return theme?.style ? theme.style(text, { fg: { kind: 'rgb', r: 126, g: 152, b: 173 } })
    : theme?.fg ? theme.fg('muted', text) : text;
}
export function overviewLines(rows, width, theme, language = 'en') {
  const active = activeOverviewRows(rows);
  if (!active.length || width <= 0) return [];
  const color = (token, text) => theme?.fg ? theme.fg(token, text) : text;
  const rule = softBlue(theme, '─'.repeat(width));
  const title = fit(`${t(language, 'title')} · ${active.length}  /rex-tasks`, width);
  const lines = [rule, softBlue(theme, title)];
  for (const row of active.slice(0, 6)) {
    const status = t(language, row.taskState);
    const summary = plain(row.task);
    const line = fit(`- ${kinds[row.kind] || row.kind} · ${plain(row.name)} · ${status}${summary ? ` — ${summary}` : ''}`, width);
    lines.push(color('muted', line));
  }
  if (active.length > 6) lines.push(color('dim', fit(t(language, 'more', { count: active.length - 6 }), width)));
  lines.push(rule);
  return lines;
}
export function showOverview(ctx, rows, enabled, language = 'en') {
  if (!ctx?.hasUI) return;
  ctx.ui.setWidget('rex-tasks', enabled && activeOverviewRows(rows).length ? (_tui, theme) => ({
    render: width => overviewLines(rows, width, theme, language), invalidate() {},
  }) : undefined, { placement: 'aboveEditor' });
}
