import { stripVTControlCharacters } from 'node:util';
import { fit, plain } from './overview.mjs';
import { t } from './i18n.mjs';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function wrapText(value, width) {
  const clean = stripVTControlCharacters(String(value ?? '')).replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
  const lines = [];
  for (const source of clean.split('\n')) {
    let line = '', used = 0;
    for (const { segment } of segments.segment(source)) {
      const size = /^[\x20-\x7e]+$/.test(segment) ? segment.length : 2;
      if (used + size > width && line) { lines.push(width >= 2 ? line : fit(line, width)); line = ''; used = 0; }
      line += segment; used += size;
    }
    lines.push(width >= 2 ? line : fit(line, width));
  }
  return lines;
}

// Terminal columns for padding the opaque rectangle, including CJK and emoji.
export function cellWidth(text) {
  let width = 0;
  for (const { segment } of segments.segment(stripVTControlCharacters(text))) {
    const c = segment.codePointAt(0);
    if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(segment)) continue;
    const wide = /\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20e3|\ufe0f/u.test(segment) ||
      c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
      c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f || c >= 0xac00 && c <= 0xd7a3 ||
      c >= 0xf900 && c <= 0xfaff || c >= 0xfe10 && c <= 0xfe19 || c >= 0xfe30 && c <= 0xfe6f ||
      c >= 0xff00 && c <= 0xff60 || c >= 0xffe0 && c <= 0xffe6 || c >= 0x20000 && c <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}
const rgb = (r, g, b) => ({ kind: 'rgb', r, g, b });
const palette = { background: rgb(21, 29, 38), border: rgb(79, 103, 125),
  title: rgb(177, 198, 216), text: rgb(205, 215, 225), hint: rgb(140, 157, 174),
  selected: rgb(40, 60, 79), selectedText: rgb(227, 237, 246) };

// One native Pi overlay for menus and scrollable text. Never appends messages
// or notifications to the transcript. Uses Pi's configured keybindings.
export function dialogComponent({ tui, theme, keys, done, title, choices, text, description = '', state = {}, language = 'en' }) {
  let selected = Math.max(0, choices?.findIndex(item => item.value === state.value) ?? 0);
  let offset = state.offset || 0, capacity = 10, lineCount = 0, closed = false;
  const remember = () => { state.value = choices?.[selected]?.value; state.offset = offset; };
  const finish = value => {
    if (closed) return;
    closed = true; remember(); done(value);
  };
  const paint = (value, color = 'text', selected = false, bold = false) => theme?.style
    ? theme.style(value, { fg: palette[color], bg: selected ? palette.selected : palette.background, bold }) : value;
  const match = (data, action) => keys.matches(data, `tui.select.${action}`);
  return {
    focused: true,
    render(width) {
      if (width <= 0) return [];
      const height = Math.max(5, Math.floor((tui.terminal?.rows || 24) * 0.8));
      const framed = width >= 6;
      const inner = framed ? width - 2 : width;
      const padding = width >= 32 ? 2 : framed ? 1 : 0;
      const contentWidth = Math.max(1, inner - padding * 2);
      const roomy = height >= 12 && width >= 32;
      const intro = description ? wrapText(description, contentWidth).slice(0, roomy ? 2 : 1) : [];
      capacity = Math.max(1, height - 4 - (roomy ? 3 : 0) - intro.length);
      const body = choices ? choices.map((item, i) => `${i === selected ? '›' : ' '} ${plain(item.label)}`)
        : wrapText(text, contentWidth);
      lineCount = body.length;
      if (choices) offset = Math.max(0, Math.min(offset, selected));
      if (choices && selected >= offset + capacity) offset = selected - capacity + 1;
      offset = Math.max(0, Math.min(offset, Math.max(0, lineCount - capacity)));
      remember();
      const row = (value = '', color = 'text', highlighted = false, bold = false) => {
        // Viewer lines are already wrapped; preserve their code/log indentation.
        const clipped = cellWidth(value) <= contentWidth ? value : fit(value, contentWidth);
        const padded = ' '.repeat(padding) + clipped + ' '.repeat(Math.max(0, inner - padding - cellWidth(clipped)));
        return (framed ? paint('│', 'border') : '') + paint(padded, color, highlighted, bold) + (framed ? paint('│', 'border') : '');
      };
      const edge = (left, right) => paint(framed ? left + '─'.repeat(inner) + right : '─'.repeat(width), 'border');
      const visible = body.slice(offset, offset + capacity).map((line, i) =>
        row(line, choices && offset + i === selected ? 'selectedText' : 'text', Boolean(choices && offset + i === selected)));
      const hint = choices ? t(language, 'selectHint')
        : `${t(language, 'scrollHint')}   ${Math.min(offset + 1, lineCount)}/${lineCount}`;
      return [edge('╭', '╮'), ...(roomy ? [row()] : []), row(plain(title), 'title', false, true),
        ...intro.map(line => row(line, 'hint')), ...(roomy ? [row()] : []), ...visible,
        ...(roomy ? [row()] : []), row(fit(hint, contentWidth), 'hint'), edge('╰', '╯')];
    },
    handleInput(data) {
      if (closed) return;
      if (match(data, 'cancel')) return finish(undefined);
      if (choices && match(data, 'confirm')) return finish(choices[selected]?.value);
      let delta = 0;
      if (match(data, 'up')) delta = -1;
      if (match(data, 'down')) delta = 1;
      if (match(data, 'pageUp')) delta = -capacity;
      if (match(data, 'pageDown')) delta = capacity;
      if (choices) selected = Math.max(0, Math.min(choices.length - 1, selected + delta));
      else offset = Math.max(0, Math.min(Math.max(0, lineCount - capacity), offset + delta));
      remember(); tui.requestRender();
    },
    close() { finish(undefined); },
    invalidate() {},
  };
}
export function createDialogs(getLanguage = () => 'en') {
  const dismissals = new Set();
  const show = async (ctx, config) => {
    if (!ctx.hasUI) return;
    let dismiss;
    try {
      return await ctx.ui.custom((tui, theme, keys, done) => {
        const component = dialogComponent({ tui, theme, keys, done, language: getLanguage(), ...config });
        dismiss = () => component.close(); dismissals.add(dismiss);
        return component;
      }, { overlay: true, overlayOptions: { width: 84, maxHeight: '80%', anchor: 'center', margin: 1 } });
    } finally { dismissals.delete(dismiss); }
  };
  return {
    select: (ctx, title, choices, options = {}) => show(ctx, { title, choices, ...options }),
    view: (ctx, title, text) => show(ctx, { title, text }),
    closeAll() { for (const dismiss of dismissals) dismiss(); dismissals.clear(); },
  };
}
