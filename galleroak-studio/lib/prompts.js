'use strict';
/** Your saved prompts (the chips above the chat box). Stored in data/prompts.json. */
const path = require('path');
const config = require('./config');

const FILE = path.join(config.DATA_DIR, 'prompts.json');
const MAX = 100;
const httpError = (status, message) => Object.assign(new Error(message), { status });

function readAll() {
  const j = config.readJson(FILE, { prompts: [] });
  return Array.isArray(j.prompts) ? j.prompts.filter((p) => p && typeof p.id === 'string') : [];
}
const writeAll = (list) => config.writeJsonAtomic(FILE, { prompts: list });

function clean(b, old) {
  const out = {};
  if (b.title !== undefined || !old) {
    const t = String(b.title || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!t) throw httpError(400, 'Give the prompt a short name.');
    out.title = t;
  }
  if (b.text !== undefined || !old) {
    const t = String(b.text || '').trim().slice(0, 4000);
    if (!t) throw httpError(400, 'The prompt text is empty.');
    out.text = t;
  }
  if (b.category !== undefined) out.category = String(b.category || '').trim().slice(0, 30);
  return out;
}

const list = () => readAll();

function create(b) {
  const all = readAll();
  if (all.length >= MAX) throw httpError(400, `You can keep up to ${MAX} saved prompts.`);
  const c = clean(b, null);
  const p = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), category: '', ...c };
  all.push(p);
  writeAll(all);
  return p;
}

function update(id, b) {
  const all = readAll();
  const i = all.findIndex((p) => p.id === id);
  if (i < 0) throw httpError(404, 'Prompt not found');
  all[i] = { ...all[i], ...clean(b, all[i]) };
  writeAll(all);
  return all[i];
}

function remove(id) {
  const all = readAll();
  if (!all.some((p) => p.id === id)) throw httpError(404, 'Prompt not found');
  writeAll(all.filter((p) => p.id !== id));
}

module.exports = { list, create, update, remove, FILE };
