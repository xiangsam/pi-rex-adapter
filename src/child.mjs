import { watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, lastAssistant, messageText } from './core.mjs';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';

export function registerChild(pi, dir) {
  let context, watcher, timer, reading = false, ready = false, generation = 0, attempt, noticeTimer, lastSequence = 0;
  let language = 'en';
  const ui = (key, values) => t(language, key, values);
  const accepted = new Set();
  const activity = (task, process) => atomicJson(join(dir, 'activity.json'), { task, process, at: new Date().toISOString() });
  // sendUserMessage returns void. A call is only an attempt, never an acknowledgement.
  // Keep a non-model session marker so reload can correlate a persisted user message
  // even if the process stopped between message persistence and our receipt.
  function confirmInputs(ctx) {
    const entries = ctx.sessionManager.getEntries();
    for (const e of entries) if (e.type === 'custom' && e.customType === 'rex_input') {
      for (const id of e.data?.ids || []) accepted.add(id);
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.type !== 'custom' || e.customType !== 'rex_input_attempt' || e.data.ids.every(id => accepted.has(id))) continue;
      const nextAttempt = entries.findIndex((next, j) => j > i && next.type === 'custom' && next.customType === 'rex_input_attempt');
      const received = entries.slice(i + 1, nextAttempt < 0 ? undefined : nextAttempt)
        .some(next => next.type === 'message' && next.message?.role === 'user' && messageText(next.message) === e.data.text);
      if (!received) continue;
      pi.appendEntry('rex_input', { ids: e.data.ids });
      for (const id of e.data.ids) accepted.add(id);
    }
    if (attempt && attempt.ids.every(id => accepted.has(id))) {
      attempt = undefined; clearTimeout(noticeTimer);
      if (ctx.hasUI) ctx.ui.setStatus?.('rex-input', undefined);
    }
  }
  async function receive() {
    if (reading || !context) return;
    reading = true;
    const epoch = generation, ctx = context;
    try {
      if (attempt) confirmInputs(ctx);
      if (!ready || attempt || !ctx.isIdle()) return;
      const files = (await readdir(dir)).filter(f => /^input-.*\.json$/.test(f) && !accepted.has(f.slice(6, -5)));
      const requests = (await Promise.all(files.map(file => readJson(join(dir, file)))))
        .filter(r => r && !accepted.has(r.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (!requests.length || epoch !== generation || !ctx.isIdle()) return;
      attempt = { ids: requests.map(r => r.id), text: requests.map(r => r.text).join('\n\n') };
      pi.appendEntry('rex_input_attempt', attempt);
      // Do not blindly retry an ambiguous void call: slow auth/input hooks may still
      // be in flight. Unconfirmed requests remain on disk and retry on /reload.
      pi.sendUserMessage(attempt.text, { expandPromptTemplates: false });
      noticeTimer = setTimeout(() => {
        if (epoch !== generation) return;
        confirmInputs(ctx);
        if (attempt && ctx.hasUI) ctx.ui.setStatus?.('rex-input', ui('inputPending'));
      }, 10000);
      noticeTimer.unref();
    } catch (error) {
      if (epoch === generation && ctx.hasUI) ctx.ui.notify(`Rex input: ${error.message}`, 'error');
    } finally { reading = false; }
  }
  function stamp() {
    lastSequence = Math.max(Date.now(), lastSequence + 1);
    return { sequence: lastSequence, createdAt: new Date(lastSequence).toISOString() };
  }
  function stop() {
    generation++; if (context?.hasUI) context.ui.setStatus?.('rex-input', undefined);
    context = undefined; watcher?.close(); clearInterval(timer); clearTimeout(noticeTimer); accepted.clear(); attempt = undefined;
  }
  pi.on('session_start', async (_event, ctx) => {
    stop(); context = ctx; confirmInputs(ctx);
    ready = (ctx.sessionManager.getBranch?.() || []).some(entry => entry.type === 'message');
    const run = await readJson(join(dir, 'run.json'));
    const settings = await loadConfig(run?.configCwd || run?.cwd || ctx.cwd);
    language = settings.config.language;
    if (settings.errors.length && ctx.hasUI) ctx.ui.notify(ui('configWarning', { message: settings.errors.join('\n') }), 'warning');
    lastSequence = (await readJson(join(dir, 'result.json')))?.sequence || 0;
    if (run && run.inputProtocol !== 1) { run.inputProtocol = 1; await atomicJson(join(dir, 'run.json'), run); }
    // The initial CLI prompt owns startup. Check queued messages on a later tick.
    try { watcher = watch(dir, (_event, file) => { if (!file || String(file).startsWith('input-')) void receive(); }); watcher.on('error', () => watcher?.close()); } catch {}
    timer = setInterval(() => void receive(), 1000); timer.unref();
  });
  pi.on('session_shutdown', stop);
  pi.on('message_end', event => {
    if (event.message?.role === 'user') setTimeout(() => { if (context) confirmInputs(context); }, 0);
  });
  pi.on('agent_start', () => activity('running', 'running'));
  pi.on('agent_settled', async (event, ctx) => {
    const run = await readJson(join(dir, 'run.json'));
    const message = lastAssistant(ctx.sessionManager.getBranch());
    confirmInputs(ctx);
    const result = {
      ...stamp(),
      text: [messageText(message), message?.errorMessage].filter(Boolean).join('\n') || '(no assistant response)',
      status: event.aborted ? 'interrupted' : message?.stopReason === 'error' ? 'failed' : 'completed',
    };
    await atomicJson(join(dir, 'result.json'), result);
    await activity(result.status, 'idle');
    ready = true;
    if (run?.kind === 'agent' && run.interactive) await atomicJson(join(dir, `turn-${randomUUID()}.json`), result);
  });
  pi.registerCommand('btw-return', {
    description: 'Send this text (or the last answer) to the parent; keep side conversation open',
    handler: async (args, ctx) => {
      const run = await readJson(join(dir, 'run.json'));
      if (run?.kind !== 'btw') return ctx.ui.notify(ui('btwOnly'), 'warning');
      const text = args.trim() || messageText(lastAssistant(ctx.sessionManager.getBranch()));
      if (!text) return ctx.ui.notify(ui('noAnswer'), 'warning');
      await atomicJson(join(dir, `return-${randomUUID()}.json`), { text, status: 'returned', ...stamp() });
      ctx.ui.notify(ui('returned'), 'info');
    },
  });
}
