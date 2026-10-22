'use strict';
/**
 * Personas: the faces and voices of your combos. A persona has a name, a colour, a sign (its emblem, shown at the voice box),
 * a face (parameters for the 3D hologram), a model or combo it speaks with, and a voice. Five come built in; you can edit
 * them, add your own, and any combo without a persona still gets a generated face in the browser.
 * Stored in data/personas.json.
 */
const path = require('path');
const config = require('./config');

const FILE = path.join(config.DATA_DIR, 'personas.json');
const MAX_PERSONAS = 24;

const SIGNS = ['target', 'split', 'eye', 'star', 'aperture', 'hex', 'triad', 'wave', 'crescent'];
const HORNS = ['none', 'sweep', 'twin', 'single', 'ridge', 'crown'];
const HAIR = ['none', 'swept', 'long', 'spiky', 'side', 'crop'];
const EYES = ['sharp', 'calm', 'wide'];
const EXTRAS = ['headphones', 'scar', 'gem'];
const ROLES = ['chat', 'reasoning', 'coding', 'video'];
const RANGES = { headW: [0.7, 0.9], jaw: [0.12, 0.34], cheek: [0, 0.16], brow: [0, 0.12], nose: [0.08, 0.3], lips: [0.03, 0.11], smile: [-0.5, 1] };

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const ROLE_PROMPT = {
  chat: 'You are warm, direct and capable. You help with anything the user brings.',
  reasoning: 'You are a careful analytical thinker. You work out problems step by step and say which part you are least sure about.',
  coding: 'You are a senior software engineer. You are precise and practical, and you prefer the simplest thing that works.',
  video: 'You are a film director and editor. You think in shots, pacing and story, and you help turn ideas into video prompts and plans.',
};

const face = (o) => ({ seed: 1, headW: 0.8, jaw: 0.22, cheek: 0.08, brow: 0.06, nose: 0.2, lips: 0.07, smile: 0, eyes: 'sharp', horns: 'sweep', hair: 'none', extras: [], ...o });

const DEFAULTS = [
  {
    id: 'thegod', name: 'theGOd', tagline: 'Leads · Builds · Inspires', color: '#f2c14e', sign: 'target', role: 'chat', aliases: ['the god'],
    face: face({ seed: 11, headW: 0.82, jaw: 0.24, brow: 0.08, horns: 'sweep', hair: 'swept', extras: ['gem'] }),
    voice: { pitch: 0.8, rate: 0.95, volume: 1, browserVoice: '', omniVoice: 'onyx' },
  },
  {
    id: 'clutch', name: 'Clutch', tagline: 'Fast · Focused · Gets it done', color: '#a66bff', sign: 'split', role: 'chat', aliases: ['klutch'],
    face: face({ seed: 23, headW: 0.78, jaw: 0.2, brow: 0.05, eyes: 'calm', horns: 'twin', hair: 'long', extras: ['gem'] }),
    voice: { pitch: 1.15, rate: 1.12, volume: 1, browserVoice: '', omniVoice: 'nova' },
  },
  {
    id: 'sage', name: 'Sage', tagline: 'Analyzes · Solves · Guides', color: '#3ef0b4', sign: 'eye', role: 'reasoning', aliases: [],
    face: face({ seed: 37, headW: 0.8, jaw: 0.22, brow: 0.06, eyes: 'calm', horns: 'ridge', hair: 'spiky', extras: ['gem'] }),
    voice: { pitch: 1, rate: 0.92, volume: 1, browserVoice: '', omniVoice: 'shimmer' },
  },
  {
    id: 'codex', name: 'CODEX', tagline: 'Codes · Creates · Evolves', color: '#3da0ff', sign: 'star', role: 'coding', aliases: ['kodex', 'codecs'],
    face: face({ seed: 41, headW: 0.8, jaw: 0.21, eyes: 'sharp', horns: 'single', hair: 'side', extras: ['scar'] }),
    voice: { pitch: 0.9, rate: 1.05, volume: 1, browserVoice: '', omniVoice: 'echo' },
  },
  {
    id: 'turner', name: 'TURNER', tagline: 'Shoots · Edits · Brings ideas to life', color: '#ff3b4a', sign: 'aperture', role: 'video', aliases: [],
    face: face({ seed: 53, headW: 0.8, jaw: 0.22, eyes: 'sharp', horns: 'ridge', hair: 'crop', smile: 0.6, extras: ['headphones', 'scar'] }),
    voice: { pitch: 1.05, rate: 1, volume: 1, browserVoice: '', omniVoice: 'fable' },
  },
].map((p) => ({ ...p, builtin: true, model: '', system: '' }));

const clone = (o) => JSON.parse(JSON.stringify(o));
const num = (v, [lo, hi], fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback; };
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);

function cleanFace(b, base) {
  const f = { ...face({}), ...(base || {}) };
  if (!b || typeof b !== 'object') return f;
  if (b.seed !== undefined) f.seed = Math.max(0, Math.min(2147483647, Math.round(Number(b.seed)) || 0));
  for (const [k, r] of Object.entries(RANGES)) if (b[k] !== undefined) f[k] = num(b[k], r, f[k]);
  if (b.eyes !== undefined) f.eyes = pick(b.eyes, EYES, f.eyes);
  if (b.horns !== undefined) f.horns = pick(b.horns, HORNS, f.horns);
  if (b.hair !== undefined) f.hair = pick(b.hair, HAIR, f.hair);
  if (Array.isArray(b.extras)) f.extras = [...new Set(b.extras.filter((x) => EXTRAS.includes(x)))];
  return f;
}

function cleanVoice(b, base) {
  const v = { pitch: 1, rate: 1, volume: 1, browserVoice: '', omniVoice: 'alloy', ...(base || {}) };
  if (!b || typeof b !== 'object') return v;
  if (b.pitch !== undefined) v.pitch = num(b.pitch, [0.5, 2], v.pitch);
  if (b.rate !== undefined) v.rate = num(b.rate, [0.5, 2], v.rate);
  if (b.volume !== undefined) v.volume = num(b.volume, [0, 1], v.volume);
  if (typeof b.browserVoice === 'string') v.browserVoice = b.browserVoice.trim().slice(0, 200);
  if (typeof b.omniVoice === 'string') v.omniVoice = b.omniVoice.trim().slice(0, 100) || 'alloy';
  return v;
}

/** Validate a create or update body. `base` is the persona being changed (or null when creating). */
function clean(b, base) {
  const out = {};
  if (b.name !== undefined || !base) {
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!name) throw httpError(400, 'Give the persona a name.');
    out.name = name;
  }
  if (b.tagline !== undefined) out.tagline = String(b.tagline || '').trim().slice(0, 60);
  if (b.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(String(b.color))) throw httpError(400, 'Colour must look like #3da0ff.');
    out.color = String(b.color).toLowerCase();
  }
  if (b.sign !== undefined) out.sign = pick(b.sign, SIGNS, base ? base.sign : 'target');
  if (b.role !== undefined) out.role = pick(b.role, ROLES, base ? base.role : 'chat');
  if (b.model !== undefined) out.model = String(b.model || '').trim().slice(0, 200);
  if (b.system !== undefined) out.system = String(b.system || '').slice(0, 2000);
  if (b.aliases !== undefined) out.aliases = (Array.isArray(b.aliases) ? b.aliases : String(b.aliases).split(',')).map((a) => String(a).trim().slice(0, 24)).filter(Boolean).slice(0, 5);
  if (b.face !== undefined) out.face = cleanFace(b.face, base && base.face);
  if (b.voice !== undefined) out.voice = cleanVoice(b.voice, base && base.voice);
  return out;
}

function slugify(name) {
  return String(name || 'persona').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'persona';
}

/** Saved personas, with every built-in present and any field added in a later version filled in. */
function readAll() {
  const saved = config.readJson(FILE, null);
  const list = saved && Array.isArray(saved.personas) ? saved.personas : [];
  const byId = new Map(list.filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
  const out = [];
  for (const d of DEFAULTS) {
    const s = byId.get(d.id);
    byId.delete(d.id);
    out.push(s ? { ...clone(d), ...s, face: { ...d.face, ...(s.face || {}) }, voice: { ...d.voice, ...(s.voice || {}) }, builtin: true } : clone(d));
  }
  for (const p of byId.values()) out.push({ aliases: [], model: '', system: '', role: 'chat', ...p, face: cleanFace(p.face), voice: cleanVoice(p.voice), builtin: false });
  return out;
}

function writeAll(list) {
  config.writeJsonAtomic(FILE, { personas: list });
}

const list = () => readAll();

function get(id) {
  const p = readAll().find((x) => x.id === id);
  if (!p) throw httpError(404, 'Persona not found');
  return p;
}

function create(b) {
  const all = readAll();
  if (all.length >= MAX_PERSONAS) throw httpError(400, `You can keep up to ${MAX_PERSONAS} personas. Remove one first.`);
  const c = clean({ role: 'chat', color: '#58e6c1', sign: 'target', ...b }, null);
  let id = slugify(c.name);
  let n = 1;
  while (all.some((x) => x.id === id)) id = slugify(c.name).slice(0, 26) + '-' + ++n;
  const p = {
    id, builtin: false, tagline: '', aliases: [], model: '', system: '', ...c,
    face: cleanFace(b.face), voice: cleanVoice(b.voice),
  };
  all.push(p);
  writeAll(all);
  return p;
}

function update(id, b) {
  const all = readAll();
  const i = all.findIndex((x) => x.id === id);
  if (i < 0) throw httpError(404, 'Persona not found');
  all[i] = { ...all[i], ...clean(b, all[i]) };
  writeAll(all);
  return all[i];
}

function remove(id) {
  const all = readAll();
  const p = all.find((x) => x.id === id);
  if (!p) throw httpError(404, 'Persona not found');
  if (p.builtin) throw httpError(400, 'The five built-in personas cannot be deleted. You can edit them, or press Reset to restore the original.');
  writeAll(all.filter((x) => x.id !== id));
}

function reset(id) {
  const d = DEFAULTS.find((x) => x.id === id);
  if (!d) throw httpError(400, 'Only the built-in personas can be reset.');
  const all = readAll().map((p) => (p.id === id ? clone(d) : p));
  writeAll(all);
  return clone(d);
}

module.exports = { list, get, create, update, remove, reset, DEFAULTS, SIGNS, HORNS, HAIR, EYES, EXTRAS, ROLES, ROLE_PROMPT, FILE };
