'use strict';
/** Turns a saved chat into Markdown, plain text or JSON. Shared by the browser (download) and the tests. */
const strip = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && p.text) || '').join('') : '');
const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');

function fileNote(m) {
  const f = Array.isArray(m.files) ? m.files : [];
  return f.length ? `(attached: ${f.map((x) => `${x.name}${x.size ? ' · ' + Math.max(1, Math.round(x.size / 1024)) + ' KB' : ''}`).join(', ')}. Files are not included in this export.)` : '';
}

/** Never includes system prompts, API keys, connector settings or the reasoning blocks of a reply. */
function toMarkdown(chat, only) {
  const msgs = (chat.messages || []).filter((m, i) => !only || only.includes(i)).filter((m) => m.role === 'user' || m.role === 'assistant');
  const out = [`# ${String(chat.title || 'Chat').replace(/\n/g, ' ')}`, ''];
  const meta = [chat.mode && `Mode: ${chat.mode}`, chat.model && `Model: ${chat.model}`, chat.created && `Started: ${when(chat.created)}`].filter(Boolean);
  if (meta.length) out.push(meta.join(' · '), '');
  for (const m of msgs) {
    const who = m.role === 'user' ? 'You' : (m.meta && m.meta.model) || 'Assistant';
    out.push(`## ${who}`, '');
    const note = fileNote(m);
    if (note) out.push(note, '');
    out.push(strip(m.content).replace(/\s+$/, ''), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function toText(chat, only) {
  const msgs = (chat.messages || []).filter((m, i) => !only || only.includes(i)).filter((m) => m.role === 'user' || m.role === 'assistant');
  const out = [String(chat.title || 'Chat'), '='.repeat(Math.min(60, String(chat.title || 'Chat').length)), ''];
  for (const m of msgs) {
    out.push(`${m.role === 'user' ? 'You' : (m.meta && m.meta.model) || 'Assistant'}:`);
    const note = fileNote(m);
    if (note) out.push(note);
    out.push(strip(m.content).replace(/\s+$/, ''), '');
  }
  return out.join('\n').trimEnd() + '\n';
}

function toJson(chat) {
  return JSON.stringify({
    format: 'omnistudio-chat', version: 1, title: chat.title, mode: chat.mode, model: chat.model, created: chat.created,
    messages: (chat.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: strip(m.content), files: (m.files || []).map((f) => ({ name: f.name, kind: f.kind, size: f.size })), model: m.meta && m.meta.model, saved: !!m.saved })),
  }, null, 2);
}

const fileName = (chat, ext) => (String(chat.title || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'chat') + '.' + ext;

const exportApi = { toMarkdown, toText, toJson, fileName };
if (typeof module !== 'undefined' && module.exports) module.exports = exportApi;
else if (typeof window !== 'undefined') window.ChatExport = exportApi;
