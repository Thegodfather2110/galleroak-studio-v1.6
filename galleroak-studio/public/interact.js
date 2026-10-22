'use strict';
/**
 * Chat and interaction extras (GallerOak Studio, since 1.4):
 *   S.ui                       per-browser preferences (faces, animation, motion, density, font size, speech rate, auto-read)
 *   S.attachments(opts)        attach button, drag-and-drop, paste, previews, validation
 *   S.readAloud(msg, persona)  Read aloud / Pause / Resume / Stop controls for one reply
 *   S.promptChips(opts)        quick prompts + your saved prompts
 *   S.exportChat(chat, fmt)    download a chat as Markdown, text or JSON
 *   S.shortcuts(...)           keyboard shortcuts and their help dialog
 */
(function () {
  const { el } = S;
  const AR = window.AttachRules;

  /* ------------------------------------------------------------------ preferences ------------------------------------------------------------------ */
  const DEFAULTS = { faces: true, animate: true, motion: 'system', density: 'normal', fontSize: 100, autoRead: false, speechRate: 1, voiceName: '' };
  const CLEAN = {
    faces: (v) => v !== false, animate: (v) => v !== false, motion: (v) => (v === 'reduced' ? 'reduced' : 'system'), density: (v) => (['compact', 'normal', 'roomy'].includes(v) ? v : 'normal'),
    fontSize: (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(85, Math.min(135, n)) : 100; },
    autoRead: (v) => v === true, speechRate: (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0.5, Math.min(2, n)) : 1; },
    voiceName: (v) => (typeof v === 'string' ? v.slice(0, 200) : ''),
  };
  S.ui = {
    DEFAULTS,
    get(k) { return CLEAN[k](S.pref.get('ui.' + k, DEFAULTS[k])); }, // stored values can be stale or malformed, so they are always re-validated
    set(k, v) { S.pref.set('ui.' + k, CLEAN[k](v)); S.ui.apply(); },
    apply() {
      const root = document.documentElement;
      root.dataset.density = S.ui.get('density');
      root.dataset.faces = S.ui.get('faces') ? 'on' : 'off';
      root.dataset.motion = S.ui.get('motion');   // 'system' follows the OS; 'reduced' forces calm UI
      document.body.style.fontSize = (14 * S.ui.get('fontSize')) / 100 + 'px';
      if (window.Holo) window.Holo.still = S.ui.get('animate') && S.ui.get('motion') !== 'reduced' ? undefined : true;
    },
  };
  S.ui.apply();

  /* ------------------------------------------------------------------ attachments ------------------------------------------------------------------ */
  const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,' + [...AR.TEXT_EXT].map((e) => '.' + e).join(',');
  const readAsB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error(`Could not read ${file.name}.`)); r.readAsDataURL(file); });
  const readAsText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error(`Could not read ${file.name}.`)); r.readAsText(file); });

  S.attachments = (opts = {}) => {
    const items = [];
    let seq = 0, noted = false;
    const limits = () => ({ ...AR.DEFAULT_LIMITS, ...((S.config && S.config.uploads) || {}) });
    const input = el('input', { type: 'file', multiple: true, hidden: true, accept: ACCEPT, 'aria-hidden': 'true', tabindex: '-1' });
    const btn = el('button', { class: 'btn sm iconbtn', type: 'button', 'aria-label': 'Attach images or files', title: 'Attach images or text and code files. You can also drop them on the box or paste an image.', onclick: () => input.click() }, S.iconEl('clip'));
    const tray = el('div', { class: 'attach-tray', role: 'list', 'aria-label': 'Attached files' });
    const live = el('div', { class: 'sr-only', 'aria-live': 'polite' });
    const ctl = { node: tray, btn, input, live, items };

    function render() {
      tray.replaceChildren();
      items.forEach((it) => {
        const thumb = it.kind === 'image' ? el('img', { class: 'att-thumb', src: it.url, alt: '' }) : el('span', { class: 'att-ico', 'aria-hidden': 'true' }, S.iconEl('file'));
        tray.append(el('div', { class: 'att-chip', role: 'listitem', title: `${it.name} · ${AR.fmtSize(it.size)}` }, thumb, el('span', { class: 'att-name' }, it.name), el('small', {}, AR.fmtSize(it.size)),
          el('button', { class: 'att-x', type: 'button', 'aria-label': `Remove ${it.name}`, onclick: () => { remove(it.id); } }, '✕')));
      });
      if (items.length > 1) tray.append(el('button', { class: 'btn sm ghost', type: 'button', onclick: () => ctl.clear() }, 'Clear all'));
      tray.classList.toggle('has', items.length > 0);
      live.textContent = items.length ? `${items.length} file${items.length === 1 ? '' : 's'} attached` : '';
      opts.onChange && opts.onChange(items.length);
    }
    function remove(id) {
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) return;
      if (items[i].url) URL.revokeObjectURL(items[i].url);
      items.splice(i, 1); render();
    }
    ctl.add = (fileList) => {
      const L = limits();
      for (const file of Array.from(fileList || [])) {
        if (items.length >= L.maxFiles) { S.toast(`You can attach up to ${L.maxFiles} files to one message.`, true); break; }
        const name = file.name || `pasted-image.${(file.type || 'image/png').split('/')[1] || 'png'}`;
        const c = AR.checkFile({ name, type: file.type, size: file.size }, L);
        if (!c.ok) { S.toast(c.error, true); continue; }
        if (items.some((x) => x.name === name && x.size === file.size)) continue;
        items.push({ id: ++seq, file, name, size: file.size, kind: c.kind, mime: c.mime, url: c.kind === 'image' ? URL.createObjectURL(file) : '' });
      }
      if (items.some((x) => x.kind === 'image') && !noted) { noted = true; S.toast('Images are sent to the selected model. If it cannot read images it may ignore them or return an error, so pick a vision-capable model or combo.'); }
      render();
    };
    ctl.clear = () => { items.forEach((x) => x.url && URL.revokeObjectURL(x.url)); items.length = 0; render(); };
    ctl.count = () => items.length;
    /** What the server receives, plus what the conversation shows. The files are read only now, when the user presses send. */
    ctl.serialize = async () => {
      const attachments = [], files = [];
      for (const it of items) {
        if (it.kind === 'image') attachments.push({ name: it.name, mime: it.mime, data: await readAsB64(it.file) });
        else attachments.push({ name: it.name, text: await readAsText(it.file) });
        files.push({ name: it.name, kind: it.kind, size: it.size, thumb: it.kind === 'image' ? it.url : '' });
      }
      return { attachments, files };
    };
    /** After a successful send the previews live on in the message, so the object URLs are not revoked. */
    ctl.release = () => { items.length = 0; render(); };

    input.addEventListener('change', () => { ctl.add(input.files); input.value = ''; });

    const offs = [];
    ctl.bindDrop = (zone) => {
      let depth = 0;
      const stop = (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); };
      const on = (t, ev, fn) => { t.addEventListener(ev, fn); offs.push(() => t.removeEventListener(ev, fn)); };
      on(zone, 'dragenter', (e) => { if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return; e.preventDefault(); depth++; zone.classList.add('dropping'); });
      on(zone, 'dragover', stop);
      on(zone, 'dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('dropping'); });
      on(zone, 'drop', (e) => { if (!e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); depth = 0; zone.classList.remove('dropping'); ctl.add(e.dataTransfer.files); });
      // a file dropped anywhere else must not make the browser leave the app
      on(window, 'dragover', stop); on(window, 'drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) e.preventDefault(); });
    };
    ctl.bindPaste = (ta) => {
      const fn = (e) => {
        const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return; // ordinary text paste is left alone
        e.preventDefault(); ctl.add(files);
      };
      ta.addEventListener('paste', fn); offs.push(() => ta.removeEventListener('paste', fn));
    };
    ctl.destroy = () => { offs.forEach((f) => f()); items.forEach((x) => x.url && URL.revokeObjectURL(x.url)); };
    render();
    return ctl;
  };

  /** Chips shown inside a sent message (thumbnails live only for this session; the saved chat keeps names and sizes). */
  S.fileChips = (files) => el('div', { class: 'msg-files' }, (files || []).map((f) => el('span', { class: 'att-chip static', title: `${f.name} · ${AR.fmtSize(f.size || 0)}` },
    f.thumb ? el('img', { class: 'att-thumb', src: f.thumb, alt: '' }) : el('span', { class: 'att-ico', 'aria-hidden': 'true' }, S.iconEl(f.kind === 'image' ? 'image' : 'file')), el('span', { class: 'att-name' }, f.name))));

  /* ------------------------------------------------------------------ read aloud ------------------------------------------------------------------ */
  let reading = null; // only one reply is read at a time
  S.stopReading = () => { if (reading) { reading.stop(); } };
  S.readAloud = (getText, persona) => {
    const play = el('button', { class: 'btn sm ghost', type: 'button', title: 'Read this reply aloud', onclick: () => start() }, '🔊 Read aloud');
    const pause = el('button', { class: 'btn sm ghost', type: 'button', style: 'display:none', onclick: () => togglePause() }, '⏸ Pause');
    const stop = el('button', { class: 'btn sm ghost', type: 'button', style: 'display:none', onclick: () => ctl.stop() }, '⏹ Stop');
    const root = el('span', { class: 'read-ctl' }, play, pause, stop);
    let mouth = null, dock = null;
    const ttsBrowser = ((S.config.voice || {}).tts || {}).engine !== 'omniroute';
    if (ttsBrowser && !window.speechSynthesis) { play.disabled = true; play.title = 'This browser cannot read aloud. In Settings → Chat & Interaction you can switch Voices to OmniRoute.'; }
    function show(on) { play.style.display = on ? 'none' : ''; pause.style.display = on ? '' : 'none'; stop.style.display = on ? '' : 'none'; }
    function togglePause() { if (!mouth) return; if (mouth.paused) { mouth.resume(); pause.textContent = '⏸ Pause'; } else { mouth.pause(); pause.textContent = '▶ Resume'; } }
    const ctl = { stop() { if (mouth) mouth.stop(); cleanup(); } };
    function cleanup() { if (dock) { dock.close(); dock = null; } mouth = null; if (reading === ctl) reading = null; pause.textContent = '⏸ Pause'; show(false); }
    function start() {
      const text = String(getText() || '').trim();
      if (!text) return S.toast('There is nothing to read in this reply.', true);
      S.stopReading();
      reading = ctl;
      mouth = S.mouth.create(persona, { onStart: () => { if (!dock && mouth) dock = S.speakDock(persona, mouth); }, onEnd: () => cleanup(), onError: (m) => { S.toast(m, true); cleanup(); } });
      show(true);
      mouth.feed(text, true);
    }
    root.start = start; root.stop = () => ctl.stop();
    return root;
  };

  /* ------------------------------------------------------------------ export ------------------------------------------------------------------ */
  S.download = (name, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  S.exportChat = (chat, fmt, only) => {
    const CE = window.ChatExport;
    const ext = fmt === 'json' ? 'json' : fmt === 'txt' ? 'txt' : 'md';
    const body = fmt === 'json' ? CE.toJson(chat) : fmt === 'txt' ? CE.toText(chat, only) : CE.toMarkdown(chat, only);
    S.download(CE.fileName(chat, ext), body, fmt === 'json' ? 'application/json' : 'text/plain');
    S.toast(`Exported ${CE.fileName(chat, ext)}. Attached files are not included.`);
  };

  /* ------------------------------------------------------------------ prompt chips ------------------------------------------------------------------ */
  const DEFAULT_CHIPS = {
    chat: [['Summarize a file', 'Summarize the attached file in 5 bullet points, then list any open questions.'], ['Draft an email', 'Draft a short, friendly email about: '], ['Research this topic', 'Research this topic and give me the key facts, the main viewpoints and what is still uncertain: '], ['Plan an implementation', 'Make a step-by-step plan to implement: ']],
    reasoning: [['Break it down', 'Break this problem into parts and solve each one: '], ['Pros and cons', 'Give the pros and cons of each option, then recommend one and say what would change your mind: '], ['Check my logic', 'Check this reasoning for mistakes and unstated assumptions: '], ['Decision framework', 'Build a simple decision framework (criteria, weights, scoring) for: ']],
    coding: [['Explain this code', 'Explain what this code does, step by step:\n\n'], ['Debug an error', 'Find the root cause of this error and show the fix:\n\n'], ['Write tests', 'Write tests for this code, covering edge cases:\n\n'], ['Review this', 'Review this code for bugs, security problems and simplifications:\n\n']],
  };
  S.promptChips = ({ mode, input }) => {
    let saved = [];
    const row = el('div', { class: 'chips-bar', role: 'group', 'aria-label': 'Quick prompts' });
    const fill = (text) => {
      const cur = input.value.trim();
      input.value = cur ? cur + '\n\n' + text : text; // never sends by itself
      input.dispatchEvent(new Event('input')); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    };
    function draw() {
      row.replaceChildren(
        ...(DEFAULT_CHIPS[mode] || DEFAULT_CHIPS.chat).map(([t, p]) => el('button', { class: 'chip-btn', type: 'button', title: p, onclick: () => fill(p) }, t)),
        ...saved.map((p) => el('button', { class: 'chip-btn mine', type: 'button', title: (p.category ? p.category + ': ' : '') + p.text, onclick: () => fill(p.text) }, p.title)),
        el('button', { class: 'chip-btn ghost', type: 'button', title: 'Save what is in the message box as a reusable prompt', onclick: saveCurrent }, '＋ Save prompt'),
        ...(saved.length ? [el('button', { class: 'chip-btn ghost', type: 'button', title: 'Rename or delete your saved prompts', onclick: manage }, 'Manage')] : []));
    }
    async function load() { try { saved = (await S.api('GET', '/api/prompts')).prompts || []; } catch { saved = []; } draw(); }
    async function saveCurrent() {
      const text = input.value.trim();
      if (!text) return S.toast('Type the prompt in the message box first, then press Save prompt.', true);
      const title = el('input', { type: 'text', maxlength: '40', placeholder: 'Short name, e.g. Weekly standup' }), cat = el('input', { type: 'text', maxlength: '30', placeholder: 'Optional group, e.g. Work' });
      const r = await S.dialog('Save this prompt', [el('label', { class: 'field' }, el('span', {}, 'Name'), title), el('label', { class: 'field' }, el('span', {}, 'Group'), cat), el('p', { class: 'hint' }, text.slice(0, 160) + (text.length > 160 ? '…' : ''))], [{ label: 'Cancel', value: false }, { label: 'Save', cls: 'primary', value: true }]);
      if (!r) return;
      try { await S.api('POST', '/api/prompts', { title: title.value, text, category: cat.value }); await load(); S.toast('Prompt saved'); } catch (e) { S.toast(e.message, true); }
    }
    async function manage() {
      const list = el('div', { class: 'stack' });
      const redraw = () => list.replaceChildren(...saved.map((p) => el('div', { class: 'row', style: 'justify-content:space-between;gap:8px' },
        el('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis' }, el('b', {}, p.title), p.category ? el('small', { style: 'color:var(--muted)' }, ' · ' + p.category) : null),
        el('span', { class: 'row' },
          el('button', { class: 'btn sm', onclick: async () => { const n = prompt('New name', p.title); if (n && n.trim()) { try { await S.api('PATCH', '/api/prompts/' + p.id, { title: n }); p.title = n.trim().slice(0, 40); redraw(); } catch (e) { S.toast(e.message, true); } } } }, 'Rename'),
          el('button', { class: 'btn sm danger', onclick: async () => { try { await S.api('DELETE', '/api/prompts/' + p.id); saved = saved.filter((x) => x.id !== p.id); redraw(); } catch (e) { S.toast(e.message, true); } } }, 'Delete')))));
      redraw();
      await S.dialog('Your saved prompts', [list], [{ label: 'Done', cls: 'primary', value: true }]);
      draw();
    }
    draw(); load();
    return row;
  };

  /* ------------------------------------------------------------------ keyboard shortcuts ------------------------------------------------------------------ */
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const KEY = mac ? '⌘' : 'Ctrl';
  S.SHORTCUTS = [
    [`${KEY} K`, 'Search your chats'], [`${KEY} Shift O`, 'New chat'], [`${KEY} Shift E`, 'Export this chat as Markdown'], [`${KEY} Shift M`, 'Dictate with the microphone'],
    ['Esc', 'Stop the reply or the reading aloud'], ['Enter / Shift Enter', 'Send / new line'], [`${KEY} /`, 'Show this list'],
  ];
  S.shortcutsDialog = () => S.dialog('Keyboard shortcuts', [el('dl', { class: 'kv' }, S.SHORTCUTS.flatMap(([k, d]) => [el('dt', {}, el('kbd', {}, k)), el('dd', {}, d)]))], [{ label: 'Close', cls: 'primary', value: true }]);
  /** handlers: { search, newChat, exportMd, dictate, stop } — returns a function that removes the listener */
  S.bindShortcuts = (h) => {
    const fn = (e) => {
      if (S.$('#dialog').open) return;
      const mod = mac ? e.metaKey : e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && !e.shiftKey && k === 'k') { e.preventDefault(); h.search && h.search(); }
      else if (mod && e.shiftKey && k === 'o') { e.preventDefault(); h.newChat && h.newChat(); }
      else if (mod && e.shiftKey && k === 'e') { e.preventDefault(); h.exportMd && h.exportMd(); }
      else if (mod && e.shiftKey && k === 'm') { e.preventDefault(); h.dictate && h.dictate(); }
      else if (mod && k === '/') { e.preventDefault(); S.shortcutsDialog(); }
      else if (e.key === 'Escape') { if (h.stop && h.stop()) e.preventDefault(); }
    };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  };

  /** A microphone button for the multi-line boxes in other tabs: it dictates into the box and never sends by itself. */
  S.micField = (ta) => {
    const mic = S.dictate(ta);
    const wrap = el('div', { class: 'mic-field' }, ta, mic);
    wrap.destroy = () => mic.destroy();
    return wrap;
  };
})();
