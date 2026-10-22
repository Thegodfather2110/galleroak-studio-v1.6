'use strict';
/**
 * ComfyUI integration. Zero dependencies (Node's built-in fetch / FormData / WebSocket when present).
 *
 * What it does, in plain words:
 *  1. DISCOVER  asks the running ComfyUI (GET /object_info) which nodes and models it has.
 *  2. BUILD     writes ready-to-run workflows for the model families it recognises (SD1.5 / SDXL checkpoints,
 *               Flux, Wan 2.1 text-to-video). Nothing for you to export or import.
 *  3. IMPORT    accepts your own workflow in ComfyUI's API format and finds the prompt, seed, size, frames, ... by itself.
 *  4. CHECK     validates a workflow against your real node list BEFORE sending it, so mistakes read as
 *               "model X is not installed, you have A, B, C" instead of a wall of ComfyUI JSON.
 *  5. RUN       queues it (POST /prompt), follows progress (WebSocket when available, polling otherwise), downloads the
 *               result (GET /view) into data/outputs/comfy and keeps a record so it shows up in the gallery.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');

const OUT_DIR = path.join(config.DATA_DIR, 'outputs', 'comfy');
const WF_DIR = path.join(config.DATA_DIR, 'comfy', 'workflows');
config.ensureDir(OUT_DIR);
config.ensureDir(WF_DIR);

const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VID_EXT = ['.mp4', '.webm', '.mov', '.m4v', '.mkv'];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska' };
const VIDEO_OUTPUT_CLASSES = /^(SaveVideo|SaveAnimatedWEBP|SaveAnimatedPNG|SaveWEBM|VHS_VideoCombine)$/;
const IMAGE_OUTPUT_CLASSES = /^(SaveImage|PreviewImage)$/;

/* ------------------------------------------------------------------ settings + HTTP */

function settings() {
  const c = config.load().comfy || {};
  return { url: c.url || 'http://127.0.0.1:8188', token: c.token || '', timeoutMin: Math.max(1, Number(c.timeoutMin) || 60) };
}

function baseUrl() {
  let u = String(settings().url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try { new URL(u); } catch { throw store.httpError(400, 'That is not a valid address. Example: http://127.0.0.1:8188'); }
  return u.replace(/\/+$/, '');
}

async function call(pathname, { method = 'GET', body, form, timeoutMs = 30000 } = {}) {
  const s = settings();
  const headers = {};
  if (s.token) headers.Authorization = 'Bearer ' + s.token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  try {
    return await fetch(baseUrl() + pathname, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e.status) throw e;
    const why = (e.cause && (e.cause.code || e.cause.message)) || e.message;
    throw store.httpError(502, `Cannot reach ComfyUI at ${baseUrl()} (${why}). Start ComfyUI first, then check the address.`);
  }
}

async function getJson(p, timeoutMs) {
  const r = await call(p, { timeoutMs });
  if (!r.ok) throw store.httpError(502, `ComfyUI answered HTTP ${r.status} for ${p}`);
  return r.json();
}

async function status() {
  const url = settings().url;
  try {
    const s = await getJson('/system_stats', 6000);
    const q = await getJson('/queue', 6000).catch(() => null);
    return {
      ok: true, url, version: (s.system && s.system.comfyui_version) || '',
      devices: (s.devices || []).map((d) => ({ name: d.name, type: d.type, vramTotal: d.vram_total, vramFree: d.vram_free })),
      queue: q ? { running: (q.queue_running || []).length, pending: (q.queue_pending || []).length } : null,
      hasToken: !!settings().token, timeoutMin: settings().timeoutMin,
    };
  } catch (e) {
    return { ok: false, url, error: e.message, hasToken: !!settings().token, timeoutMin: settings().timeoutMin };
  }
}

function saveSettings(b) {
  const patch = {};
  if (typeof b.url === 'string' && b.url.trim()) {
    let u = b.url.trim();
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    try { new URL(u); } catch { throw store.httpError(400, 'That is not a valid address. Example: http://127.0.0.1:8188'); }
    patch.url = u.replace(/\/+$/, '');
  }
  if (typeof b.token === 'string' && b.token.trim()) patch.token = b.token.trim();
  if (b.clearToken === true) patch.token = '';
  if (b.timeoutMin !== undefined) patch.timeoutMin = Math.max(1, Math.min(600, Number(b.timeoutMin) || 60));
  config.save({ comfy: patch });
  infoCache = { at: 0, data: null };
  return status();
}

/* ------------------------------------------------------------------ discovery */

let infoCache = { at: 0, data: null };
async function objectInfo(force) {
  if (!force && infoCache.data && Date.now() - infoCache.at < 60000) return infoCache.data;
  const d = await getJson('/object_info', 120000);
  infoCache = { at: Date.now(), data: d };
  return d;
}

const specOf = (info, cls, field) => {
  const n = info[cls];
  if (!n || !n.input) return null;
  return (n.input.required || {})[field] || (n.input.optional || {})[field] || null;
};
/** ComfyUI lists choices either as [[a, b, c], {...}] (older) or ['COMBO', {options: [a, b, c]}] (newer). */
function optionsOf(spec) {
  if (!spec) return null;
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === 'COMBO' && spec[1] && Array.isArray(spec[1].options)) return spec[1].options;
  return null;
}
const comboOptions = (info, cls, field) => optionsOf(specOf(info, cls, field));

const pick = (opts, ...want) => want.find((w) => !opts || opts.includes(w)) || (opts && opts[0]) || want[0];

function familyOf(name) {
  const n = String(name).toLowerCase();
  if (/flux/.test(n)) return 'flux';
  if (/wan/.test(n)) return 'wan';
  if (/sd3|sd_3/.test(n)) return 'sd3';
  if (/xl|pony|illustrious/.test(n)) return 'sdxl';
  return 'sd15';
}
const pretty = (f) => String(f).replace(/\.(safetensors|ckpt|pt|pth|gguf|bin)$/i, '');

function builder() {
  const g = {};
  let n = 0;
  return { g, add(cls, inputs) { const id = String(++n); g[id] = { class_type: cls, inputs }; return id; } };
}

function autoClassic(info, ck, fam) {
  const b = builder();
  const sam = comboOptions(info, 'KSampler', 'sampler_name');
  const sch = comboOptions(info, 'KSampler', 'scheduler');
  const m = b.add('CheckpointLoaderSimple', { ckpt_name: ck });
  let pos = b.add('CLIPTextEncode', { text: '', clip: [m, 1] });
  const neg = b.add('CLIPTextEncode', { text: fam === 'flux' ? '' : 'blurry, low quality, watermark, text', clip: [m, 1] });
  const size = fam === 'sd15' ? 512 : 1024;
  const newLatent = fam === 'flux' || fam === 'sd3';
  if (fam === 'flux' && info.FluxGuidance) pos = b.add('FluxGuidance', { conditioning: [pos, 0], guidance: 3.5 });
  const lat = b.add(newLatent && info.EmptySD3LatentImage ? 'EmptySD3LatentImage' : 'EmptyLatentImage', { width: size, height: size, batch_size: 1 });
  const ks = b.add('KSampler', {
    model: [m, 0], seed: 0, steps: fam === 'flux' ? 20 : fam === 'sd3' ? 28 : 25, cfg: fam === 'flux' ? 1 : fam === 'sd3' ? 4.5 : fam === 'sdxl' ? 6 : 7,
    sampler_name: fam === 'flux' ? pick(sam, 'euler') : pick(sam, 'dpmpp_2m', 'euler'),
    scheduler: fam === 'flux' ? pick(sch, 'simple', 'normal') : fam === 'sd3' ? pick(sch, 'sgm_uniform', 'normal') : pick(sch, 'karras', 'normal'),
    positive: [pos, 0], negative: [neg, 0], latent_image: [lat, 0], denoise: 1,
  });
  const dec = b.add('VAEDecode', { samples: [ks, 0], vae: [m, 2] });
  b.add('SaveImage', { images: [dec, 0], filename_prefix: 'OmniStudio' });
  return b.g;
}

function autoFlux(info, unet, clipT5, clipL, vae) {
  const b = builder();
  const sam = comboOptions(info, 'KSampler', 'sampler_name');
  const sch = comboOptions(info, 'KSampler', 'scheduler');
  const schnell = /schnell/i.test(unet);
  const u = b.add('UNETLoader', { unet_name: unet, weight_dtype: 'default' });
  const c = b.add('DualCLIPLoader', { clip_name1: clipT5, clip_name2: clipL, type: 'flux' });
  const v = b.add('VAELoader', { vae_name: vae });
  let pos = b.add('CLIPTextEncode', { text: '', clip: [c, 0] });
  if (info.FluxGuidance && !schnell) pos = b.add('FluxGuidance', { conditioning: [pos, 0], guidance: 3.5 });
  const neg = b.add('CLIPTextEncode', { text: '', clip: [c, 0] });
  const lat = b.add(info.EmptySD3LatentImage ? 'EmptySD3LatentImage' : 'EmptyLatentImage', { width: 1024, height: 1024, batch_size: 1 });
  const ks = b.add('KSampler', { model: [u, 0], seed: 0, steps: schnell ? 4 : 20, cfg: 1, sampler_name: pick(sam, 'euler'), scheduler: pick(sch, 'simple', 'normal'), positive: [pos, 0], negative: [neg, 0], latent_image: [lat, 0], denoise: 1 });
  const dec = b.add('VAEDecode', { samples: [ks, 0], vae: [v, 0] });
  b.add('SaveImage', { images: [dec, 0], filename_prefix: 'OmniStudio' });
  return b.g;
}

function autoWanT2V(info, unet, clip, vae) {
  const b = builder();
  const sam = comboOptions(info, 'KSampler', 'sampler_name');
  const sch = comboOptions(info, 'KSampler', 'scheduler');
  const u = b.add('UNETLoader', { unet_name: unet, weight_dtype: 'default' });
  const c = b.add('CLIPLoader', { clip_name: clip, type: 'wan' });
  const v = b.add('VAELoader', { vae_name: vae });
  const pos = b.add('CLIPTextEncode', { text: '', clip: [c, 0] });
  const neg = b.add('CLIPTextEncode', { text: 'blurry, low quality, static, worst quality, watermark', clip: [c, 0] });
  const lat = b.add('EmptyHunyuanLatentVideo', { width: 832, height: 480, length: 33, batch_size: 1 });
  const ms = b.add('ModelSamplingSD3', { model: [u, 0], shift: 8 });
  const ks = b.add('KSampler', { model: [ms, 0], seed: 0, steps: 30, cfg: 6, sampler_name: pick(sam, 'uni_pc', 'euler'), scheduler: pick(sch, 'simple', 'normal'), positive: [pos, 0], negative: [neg, 0], latent_image: [lat, 0], denoise: 1 });
  const dec = b.add('VAEDecode', { samples: [ks, 0], vae: [v, 0] });
  if (info.CreateVideo && info.SaveVideo) {
    const cv = b.add('CreateVideo', { images: [dec, 0], fps: 16 });
    b.add('SaveVideo', { video: [cv, 0], filename_prefix: 'video/OmniStudio', format: 'auto', codec: 'auto' });
  } else {
    b.add('SaveAnimatedWEBP', { images: [dec, 0], filename_prefix: 'OmniStudio', fps: 16, lossless: false, quality: 85, method: 'default' });
  }
  return b.g;
}

function buildAuto(info, models) {
  const list = [];
  const skipped = [];
  const add = (id, name, kind, graph, confidence, family) => {
    const a = analyze(graph);
    list.push({ id, name, kind, source: 'auto', confidence, family, graph, bindings: a.bindings, values: a.values, outputs: a.outputs, warnings: a.warnings });
  };
  if (info.CheckpointLoaderSimple && info.KSampler) {
    for (const ck of models.checkpoints.slice(0, 40)) {
      const fam = familyOf(ck);
      if (fam === 'wan') { skipped.push({ what: ck, why: 'looks like a video model; load it as a Wan workflow instead' }); continue; }
      add('auto:image:' + ck, pretty(ck), 'image', autoClassic(info, ck, fam), fam === 'sd15' || fam === 'sdxl' ? 'standard' : 'guess', fam);
    }
  }
  const fluxUnets = models.unets.filter((u) => /flux/i.test(u));
  if (fluxUnets.length) {
    const t5 = models.dualClips.find((c) => /t5/i.test(c));
    const cl = models.dualClips.find((c) => /clip[_-]?l/i.test(c));
    const ae = models.vaes.find((v) => /(^|[\\/_-])ae\b|flux/i.test(v));
    const flux = comboOptions(info, 'DualCLIPLoader', 'type');
    if (!info.UNETLoader || !info.DualCLIPLoader || !info.VAELoader) skipped.push({ what: 'Flux', why: 'UNETLoader / DualCLIPLoader / VAELoader nodes are missing' });
    else if (!t5 || !cl || !ae) skipped.push({ what: 'Flux', why: `needs a t5xxl text encoder, clip_l and the Flux "ae" VAE (missing: ${[!t5 && 't5xxl', !cl && 'clip_l', !ae && 'ae VAE'].filter(Boolean).join(', ')})` });
    else if (flux && !flux.includes('flux')) skipped.push({ what: 'Flux', why: 'this ComfyUI does not know the "flux" CLIP type; update ComfyUI' });
    else for (const u of fluxUnets.slice(0, 10)) add('auto:image:flux:' + u, pretty(u) + ' (Flux)', 'image', autoFlux(info, u, t5, cl, ae), 'guess', 'flux');
  }
  const wanUnets = models.unets.filter((u) => /wan/i.test(u) && /t2v|text/i.test(u) && !/i2v/i.test(u) && !/2[._]2/.test(u));
  if (wanUnets.length) {
    const clip = models.clips.find((c) => /umt5|t5/i.test(c));
    const vae = models.vaes.find((v) => /wan/i.test(v));
    const need = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'EmptyHunyuanLatentVideo', 'ModelSamplingSD3'].filter((c) => !info[c]);
    if (need.length) skipped.push({ what: 'Wan video', why: 'missing nodes: ' + need.join(', ') });
    else if (!info.SaveVideo && !info.SaveAnimatedWEBP) skipped.push({ what: 'Wan video', why: 'no video save node available' });
    else if (!clip || !vae) skipped.push({ what: 'Wan video', why: `needs the umt5 text encoder and the Wan VAE (missing: ${[!clip && 'umt5', !vae && 'wan vae'].filter(Boolean).join(', ')})` });
    else for (const u of wanUnets.slice(0, 6)) add('auto:video:wan:' + u, pretty(u) + ' (Wan 2.1)', 'video', autoWanT2V(info, u, clip, vae), 'guess', 'wan');
  }
  const wan22 = models.unets.filter((u) => /wan/i.test(u) && /2[._]2/.test(u));
  if (wan22.length) skipped.push({ what: 'Wan 2.2', why: 'uses two models per video; import a Wan 2.2 workflow (Export (API) in ComfyUI) and GallerOak Studio will wire it up' });
  return { list, skipped };
}

let discovery = null; // last result, so auto workflows can be looked up by id
async function discover(force) {
  const info = await objectInfo(force);
  const models = {
    checkpoints: comboOptions(info, 'CheckpointLoaderSimple', 'ckpt_name') || [],
    unets: comboOptions(info, 'UNETLoader', 'unet_name') || [],
    vaes: comboOptions(info, 'VAELoader', 'vae_name') || [],
    clips: comboOptions(info, 'CLIPLoader', 'clip_name') || [],
    dualClips: comboOptions(info, 'DualCLIPLoader', 'clip_name1') || [],
    loras: comboOptions(info, 'LoraLoader', 'lora_name') || [],
  };
  const built = buildAuto(info, models);
  discovery = { at: Date.now(), models, nodeCount: Object.keys(info).length, ...built };
  return discovery;
}

/* ------------------------------------------------------------------ analysing a workflow */

const isRef = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Walk upstream from a link until a node with one of the wanted string inputs is found (nearest first).
 * `prefer` ('positive' | 'negative') keeps the walk on the matching branch when a node (like Wan's image-to-video
 * node) passes both conditionings through, so the negative prompt does not end up bound to the positive one.
 */
function findUpstream(graph, ref, wanted, prefer) {
  const q = [ref];
  const seen = new Set();
  const other = prefer === 'positive' ? 'negative' : prefer === 'negative' ? 'positive' : null;
  while (q.length) {
    const r = q.shift();
    if (!isRef(r) || seen.has(r[0])) continue;
    seen.add(r[0]);
    const n = graph[r[0]];
    if (!n || !n.inputs) continue;
    for (const f of wanted) if (typeof n.inputs[f] === 'string') return { node: r[0], input: f };
    const links = Object.entries(n.inputs).filter(([k, v]) => isRef(v) && k !== other);
    links.sort((a, b) => (b[0] === prefer) - (a[0] === prefer));
    for (const [, v] of links) q.push(v);
  }
  return null;
}

function analyze(graph) {
  const nodes = Object.entries(graph).filter(([, n]) => n && typeof n === 'object' && n.class_type && n.inputs && typeof n.inputs === 'object');
  const B = {};
  const warnings = [];
  const TEXT = ['text', 'prompt', 'positive_prompt'];

  // prompts: follow the sampler's positive / negative links back to the text nodes
  const samplers = nodes.filter(([, n]) => /^KSampler|^SamplerCustom/.test(n.class_type));
  let posRef = null, negRef = null;
  for (const [, s] of samplers) {
    let p = s.inputs.positive, ng = s.inputs.negative;
    if (!isRef(p) && isRef(s.inputs.guider)) {
      const g = graph[s.inputs.guider[0]];
      if (g && g.inputs) { p = g.inputs.positive || g.inputs.conditioning; ng = g.inputs.negative; }
    }
    if (isRef(p) && !posRef) posRef = p;
    if (isRef(ng) && !negRef) negRef = ng;
  }
  let pos = posRef ? findUpstream(graph, posRef, TEXT, 'positive') : null;
  let neg = negRef ? findUpstream(graph, negRef, TEXT, 'negative') : null;
  if (pos && neg && pos.node === neg.node) neg = null; // negative that just zeroes the positive (Flux, Wan): nothing to type
  if (!pos) {
    const enc = nodes.filter(([, n]) => /^CLIPTextEncode$/.test(n.class_type) && typeof n.inputs.text === 'string');
    const titled = (n, w) => /negative|neg/i.test((n._meta && n._meta.title) || '') === w;
    const p = enc.find(([, n]) => titled(n, false));
    if (p) pos = { node: p[0], input: 'text' };
    const q = enc.find(([id, n]) => id !== (p && p[0]) && titled(n, true));
    if (q && !neg) neg = { node: q[0], input: 'text' };
  }
  if (pos) B.prompt = [pos];
  else warnings.push('No prompt text field found - the workflow will run exactly as saved.');
  if (neg) B.negative = [neg];

  // seeds, steps, cfg
  const seeds = [];
  for (const [id, n] of nodes) for (const k of ['seed', 'noise_seed']) if (isNum(n.inputs[k])) seeds.push({ node: id, input: k });
  if (seeds.length) B.seed = seeds;
  const single = (field, filter) => {
    const hits = nodes.filter(([, n]) => filter(n) && isNum(n.inputs[field]));
    return hits.length === 1 ? [{ node: hits[0][0], input: field }] : null;
  };
  const samplerish = (n) => /Sampler|Scheduler|Guider/.test(n.class_type);
  const st = single('steps', samplerish); if (st) B.steps = st;
  const cf = single('cfg', samplerish); if (cf) B.cfg = cf;

  // size, frames, fps
  const sizeNode = nodes.find(([, n]) => /^Empty.*Latent|ImageToVideo|ImgToVideo/.test(n.class_type) && isNum(n.inputs.width) && isNum(n.inputs.height))
    || nodes.find(([, n]) => !/^CLIPTextEncode/.test(n.class_type) && isNum(n.inputs.width) && isNum(n.inputs.height));
  if (sizeNode) { B.width = [{ node: sizeNode[0], input: 'width' }]; B.height = [{ node: sizeNode[0], input: 'height' }]; }
  const framesKeys = ['length', 'frames', 'video_frames', 'num_frames', 'frame_count'];
  for (const [id, n] of sizeNode ? [sizeNode, ...nodes] : nodes) {
    const k = framesKeys.find((x) => isNum(n.inputs[x]));
    if (k) { B.frames = [{ node: id, input: k }]; break; }
  }
  const fps = nodes.filter(([, n]) => isNum(n.inputs.fps) || isNum(n.inputs.frame_rate)).map(([id, n]) => ({ node: id, input: isNum(n.inputs.fps) ? 'fps' : 'frame_rate' }));
  if (fps.length) B.fps = fps;

  // start image (image-to-video) and the model name (shown, and switchable for plain checkpoint workflows)
  const load = nodes.find(([, n]) => n.class_type === 'LoadImage' && typeof n.inputs.image === 'string');
  if (load) B.image = [{ node: load[0], input: 'image' }];
  const ck = nodes.find(([, n]) => n.class_type === 'CheckpointLoaderSimple');
  if (ck) B.checkpoint = [{ node: ck[0], input: 'ckpt_name' }];

  const outputs = nodes.filter(([, n]) => VIDEO_OUTPUT_CLASSES.test(n.class_type) || IMAGE_OUTPUT_CLASSES.test(n.class_type)).map(([id]) => id);
  const hasVideoOut = nodes.some(([, n]) => VIDEO_OUTPUT_CLASSES.test(n.class_type));
  if (!outputs.length) warnings.push('No Save/Preview node found - ComfyUI will not produce a file.');
  const kind = hasVideoOut || (B.frames && !outputs.some((id) => IMAGE_OUTPUT_CLASSES.test(graph[id].class_type))) ? 'video' : 'image';

  const values = {};
  for (const [k, list] of Object.entries(B)) {
    const b = list[0];
    const v = graph[b.node] && graph[b.node].inputs[b.input];
    if (typeof v === 'string' || isNum(v)) values[k] = v;
  }
  return { kind, bindings: B, values, outputs, warnings };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const snap8 = (v) => clamp(Math.round(Number(v) / 8) * 8, 64, 4096);
const rndSeed = () => Math.floor(Math.random() * 4294967295);

/** Copy the graph and write the user's choices into the bound inputs. */
function apply(graph, bindings, p) {
  const g = JSON.parse(JSON.stringify(graph));
  const put = (key, value) => { for (const b of bindings[key] || []) if (g[b.node]) g[b.node].inputs[b.input] = value; };
  const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
  if (typeof p.prompt === 'string') put('prompt', p.prompt);
  if (typeof p.negative === 'string') put('negative', p.negative);
  put('seed', isNum(num(p.seed)) && num(p.seed) >= 0 ? Math.floor(num(p.seed)) : rndSeed());
  if (isNum(num(p.steps))) put('steps', clamp(Math.round(num(p.steps)), 1, 200));
  if (isNum(num(p.cfg))) put('cfg', clamp(num(p.cfg), 0, 30));
  if (isNum(num(p.width))) put('width', snap8(num(p.width)));
  if (isNum(num(p.height))) put('height', snap8(num(p.height)));
  if (isNum(num(p.frames))) put('frames', clamp(Math.round(num(p.frames)), 1, 1000));
  if (isNum(num(p.fps))) put('fps', clamp(Math.round(num(p.fps)), 1, 120));
  if (typeof p.imageName === 'string' && p.imageName) put('image', p.imageName);
  if (typeof p.checkpoint === 'string' && p.checkpoint) put('checkpoint', p.checkpoint);
  return g;
}

/* ------------------------------------------------------------------ check before sending */

function suggest(value, options) {
  const v = String(value).toLowerCase();
  const stem = v.replace(/\.[a-z0-9]+$/, '');
  return options.find((o) => String(o).toLowerCase().includes(stem.slice(0, Math.max(5, Math.min(stem.length, 12))))) || null;
}

/** Fill defaults ComfyUI would otherwise demand, and report anything that cannot work, in plain language. */
function preflight(graph, info) {
  const g = JSON.parse(JSON.stringify(graph));
  const problems = [];
  for (const [id, n] of Object.entries(g)) {
    if (!n || typeof n !== 'object' || !n.class_type) { problems.push(`Node ${id}: not a valid node`); continue; }
    n.inputs = n.inputs || {};
    const title = `Node ${id} (${n.class_type})`;
    const def = info[n.class_type];
    if (!def) { problems.push(`${title}: this node type is not installed in your ComfyUI. Install the custom node pack that provides it, or choose another workflow.`); continue; }
    const required = (def.input && def.input.required) || {};
    for (const [name, spec] of Object.entries(required)) {
      let v = n.inputs[name];
      if (v === undefined) {
        const d = spec[1] && typeof spec[1] === 'object' ? spec[1].default : undefined;
        if (d !== undefined) { n.inputs[name] = d; v = d; }
        else { problems.push(`${title}: the required input "${name}" is missing.`); continue; }
      }
      if (isRef(v)) {
        if (!g[v[0]]) problems.push(`${title}: input "${name}" points to node ${v[0]}, which does not exist.`);
        continue;
      }
      const options = optionsOf(spec);
      if (options && !(n.class_type === 'LoadImage' && name === 'image') && !options.includes(v)) {
        const near = suggest(v, options);
        problems.push(`${title}: "${v}" is not available for "${name}".${near ? ` Did you mean "${near}"?` : ''} Installed: ${options.slice(0, 6).join(', ')}${options.length > 6 ? ', …' : ''}${options.length ? '' : '(nothing installed)'}`);
      }
    }
  }
  return { graph: g, problems };
}

/* ------------------------------------------------------------------ workflows (auto + imported) */

const safeName = (s) => String(s || 'workflow').replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 60) || 'workflow';
const slug = (s) => safeName(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow';

function summary(w) {
  return {
    id: w.id, name: w.name, kind: w.kind, source: w.source, confidence: w.confidence || 'yours', family: w.family || '',
    bindings: Object.keys(w.bindings || {}), values: w.values || {}, nodes: Object.keys(w.graph || {}).length, warnings: w.warnings || [],
    needsImage: !!(w.bindings && w.bindings.image),
  };
}

function readImported() {
  const out = [];
  for (const f of fs.readdirSync(WF_DIR)) {
    if (!f.endsWith('.json')) continue;
    const w = config.readJson(path.join(WF_DIR, f), null);
    if (w && w.graph) out.push({ ...w, source: 'imported' });
  }
  return out.sort((a, b) => b.created - a.created);
}

async function listWorkflows() {
  let d = null, error = null;
  try { d = await discover(false); } catch (e) { error = e.message; }
  return {
    error, models: d ? d.models : null, skipped: d ? d.skipped : [],
    auto: d ? d.list.map(summary) : [], imported: readImported().map(summary),
  };
}

async function getWorkflow(id) {
  if (String(id).startsWith('auto:')) {
    const d = discovery && Date.now() - discovery.at < 10 * 60000 ? discovery : await discover(false);
    const w = d.list.find((x) => x.id === id);
    if (!w) throw store.httpError(404, 'That workflow is no longer available (the model may have been removed). Press Rescan.');
    return w;
  }
  const m = String(id).match(/^[a-z0-9-]+$/);
  const w = m && config.readJson(path.join(WF_DIR, id + '.json'), null);
  if (!w) throw store.httpError(404, 'Workflow not found.');
  return { ...w, source: 'imported' };
}

async function importWorkflow(b) {
  let graph = b.graph;
  if (typeof graph === 'string') { try { graph = JSON.parse(graph); } catch { throw store.httpError(400, 'That file is not valid JSON.'); } }
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw store.httpError(400, 'Expected a workflow object.');
  if (Array.isArray(graph.nodes) && Array.isArray(graph.links)) {
    throw store.httpError(400, 'This is ComfyUI\'s editor format. In ComfyUI open the workflow, then use the menu: Workflow → Export (API) (older versions: enable Dev mode, then "Save (API Format)"), and import that file.');
  }
  if (graph.prompt && typeof graph.prompt === 'object' && !graph.class_type) graph = graph.prompt; // {"prompt": {...}} wrapper
  const entries = Object.entries(graph);
  if (!entries.length || !entries.every(([, n]) => n && typeof n === 'object' && typeof n.class_type === 'string' && n.inputs && typeof n.inputs === 'object')) {
    throw store.httpError(400, 'This does not look like an API-format workflow (every node needs "class_type" and "inputs").');
  }
  const a = analyze(graph);
  const id = slug(b.name || 'workflow') + '-' + Math.random().toString(36).slice(2, 6);
  const rec = { id, name: safeName(b.name || 'Imported workflow'), kind: a.kind, graph, bindings: a.bindings, values: a.values, outputs: a.outputs, warnings: a.warnings, created: Date.now() };
  config.writeJsonAtomic(path.join(WF_DIR, id + '.json'), rec);
  let problems = [];
  try { problems = preflight(graph, await objectInfo(false)).problems; } catch { /* ComfyUI not running: checked again at run time */ }
  return { workflow: summary({ ...rec, source: 'imported' }), problems };
}

function deleteWorkflow(id) {
  if (!/^[a-z0-9-]+$/.test(String(id))) return false;
  try { fs.unlinkSync(path.join(WF_DIR, id + '.json')); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ running jobs */

const ACTIVE = new Map(); // job id -> live record (so Stop can reach a running job)

function recordPath(id) { return path.join(OUT_DIR, id + '.json'); }
function saveRecord(rec) { config.writeJsonAtomic(recordPath(rec.id), rec); }

function listJobs() {
  const out = [];
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!f.endsWith('.json')) continue;
    const r = config.readJson(path.join(OUT_DIR, f), null);
    if (r) out.push(ACTIVE.get(r.id) || r);
  }
  return out.sort((a, b) => b.created - a.created);
}

function deleteJob(id) {
  if (!store.safeId(id)) return false;
  const rec = config.readJson(recordPath(id), null);
  if (!rec) return false;
  for (const f of rec.files || []) { try { fs.unlinkSync(path.join(OUT_DIR, path.basename(f.file))); } catch { /* already gone */ } }
  try { fs.unlinkSync(recordPath(id)); } catch { /* already gone */ }
  ACTIVE.delete(id);
  return true;
}

function markStale() {
  for (const r of listJobs()) {
    if (r.status === 'running') { r.status = 'error'; r.error = 'Interrupted (the app was restarted).'; r.note = ''; saveRecord(r); }
  }
}

function explainFailure(entry) {
  const msgs = (entry.status && entry.status.messages) || [];
  const err = msgs.find((m) => m[0] === 'execution_error');
  if (!err) return 'ComfyUI reported an error while running this workflow. Check the ComfyUI window for details.';
  const d = err[1] || {};
  const text = `${d.node_type || 'A node'} failed: ${d.exception_message || 'unknown error'}`.replace(/\s+/g, ' ').trim();
  const oom = /out of memory|allocation on device|CUDA error|MPS backend out of memory/i.test(text);
  return oom ? `${text}\nThe GPU ran out of memory. Try a smaller size or fewer frames, or press "Free VRAM" and retry.` : text;
}

function explainPromptError(j) {
  if (!j) return '';
  const parts = [];
  if (j.error && j.error.message) parts.push(j.error.message + (j.error.details ? ': ' + j.error.details : ''));
  for (const [id, ne] of Object.entries(j.node_errors || {})) for (const e of ne.errors || []) parts.push(`Node ${id} (${ne.class_type}): ${e.message}${e.details ? ' - ' + e.details : ''}`);
  return parts.join('\n');
}

async function submit(graph, clientId) {
  const r = await call('/prompt', { method: 'POST', body: { prompt: graph, client_id: clientId }, timeoutMs: 60000 });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw new Error(explainPromptError(j) || `ComfyUI rejected the workflow (HTTP ${r.status}): ${text.slice(0, 300)}`);
  if (!j || !j.prompt_id) throw new Error('ComfyUI did not return a job id.');
  return j.prompt_id;
}

/** Live progress through ComfyUI's WebSocket. Best effort: polling still works without it. */
function watch(clientId, rec, graph, persist) {
  if (typeof WebSocket === 'undefined') return () => {};
  let ws;
  try { ws = new WebSocket(baseUrl().replace(/^http/i, 'ws') + '/ws?clientId=' + encodeURIComponent(clientId)); } catch { return () => {}; }
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return; // binary frames are previews
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    const d = m.data || {};
    if (m.type === 'progress' && d.max) { rec.progress = { value: d.value, max: d.max }; persist(); }
    else if (m.type === 'executing' && d.node) {
      const n = graph[d.node];
      rec.note = `Running ${(n && ((n._meta && n._meta.title) || n.class_type)) || 'node ' + d.node}…`;
      rec.progress = null;
      persist();
    }
  };
  ws.onerror = () => {};
  return () => { try { ws.close(); } catch { /* ignore */ } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForResult(rec, promptId, persist) {
  const deadline = Date.now() + settings().timeoutMin * 60000;
  let failures = 0;
  for (;;) {
    if (rec.cancelled) throw new Error('Stopped.');
    if (Date.now() > deadline) throw new Error(`Gave up after ${settings().timeoutMin} minutes. ComfyUI may still be working; raise the time limit if videos take longer on this computer.`);
    try {
      const r = await call('/history/' + encodeURIComponent(promptId), { timeoutMs: 20000 });
      const h = r.ok ? await r.json() : {};
      failures = 0;
      const e = h[promptId];
      if (e) {
        if (e.status && e.status.status_str === 'error') throw Object.assign(new Error(explainFailure(e)), { final: true });
        return e;
      }
      if (!rec.progress) {
        const q = await getJson('/queue', 10000).catch(() => null);
        if (q) {
          const idx = (q.queue_pending || []).findIndex((x) => x[1] === promptId);
          const note = idx >= 0 ? `Waiting in ComfyUI's queue (${idx + 1} ahead of the next slot)…` : (q.queue_running || []).some((x) => x[1] === promptId) ? (rec.note && /^Running/.test(rec.note) ? rec.note : 'Running in ComfyUI…') : rec.note;
          if (note !== rec.note) { rec.note = note; persist(); }
        }
      }
    } catch (e) {
      if (e.final) throw e;
      if (++failures > 6) throw new Error('Lost contact with ComfyUI while the job was running. ' + e.message);
    }
    await sleep(1000);
  }
}

function collectFiles(entry) {
  const found = [];
  for (const [node, o] of Object.entries(entry.outputs || {})) {
    for (const val of Object.values(o || {})) {
      if (!Array.isArray(val)) continue;
      for (const f of val) if (f && typeof f === 'object' && typeof f.filename === 'string') found.push({ ...f, node });
    }
  }
  const real = found.filter((f) => (f.type || 'output') === 'output');
  return real.length ? real : found;
}

async function download(f, name) {
  const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
  const r = await call('/view?' + q.toString(), { timeoutMs: 10 * 60000 });
  if (!r.ok) throw new Error(`Could not download ${f.filename} from ComfyUI (HTTP ${r.status}).`);
  fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(await r.arrayBuffer()));
}

async function runRecord(rec, graph) {
  const t0 = Date.now();
  let last = 0;
  const persist = (force) => { if (force || Date.now() - last > 400) { last = Date.now(); saveRecord(rec); } };
  const update = (patch) => { Object.assign(rec, patch); persist(true); };
  let stopWatch = () => {};
  try {
    const pf = preflight(graph, await objectInfo(false));
    if (pf.problems.length) throw new Error(pf.problems.join('\n'));
    update({ note: 'Sending to ComfyUI…' });
    const promptId = await submit(pf.graph, rec.id);
    update({ comfyId: promptId, note: 'Queued in ComfyUI…' });
    stopWatch = watch(rec.id, rec, pf.graph, persist);
    const entry = await waitForResult(rec, promptId, persist);
    update({ note: 'Saving to your computer…', progress: null });
    const files = [];
    for (const f of collectFiles(entry)) {
      const ext = path.extname(f.filename).toLowerCase();
      if (!IMG_EXT.includes(ext) && !VID_EXT.includes(ext)) continue;
      const name = `${rec.id}-${files.length + 1}${ext}`;
      await download(f, name);
      files.push({ file: name, type: MIME[ext], kind: VID_EXT.includes(ext) ? 'video' : 'image' });
    }
    if (!files.length) throw new Error('ComfyUI finished but produced no image or video. Does the workflow end in a Save Image / Save Video node?');
    update({ status: 'done', files, note: '', progress: null, seconds: Math.round((Date.now() - t0) / 1000) });
  } catch (e) {
    update({ status: rec.cancelled ? 'cancelled' : 'error', error: rec.cancelled ? 'Stopped.' : e.message, note: '', progress: null });
  } finally {
    stopWatch();
    ACTIVE.delete(rec.id);
  }
}

async function uploadImage(buf, filename) {
  const ext = path.extname(filename).toLowerCase();
  const form = new FormData();
  form.append('image', new Blob([buf], { type: MIME[ext] || 'image/png' }), filename);
  form.append('overwrite', 'true');
  const r = await call('/upload/image', { method: 'POST', form, timeoutMs: 60000 });
  if (!r.ok) throw store.httpError(502, `ComfyUI would not accept the start image (HTTP ${r.status}).`);
  const j = await r.json();
  return j.subfolder ? j.subfolder + '/' + j.name : j.name;
}

function imageBuffer(b) {
  if (b.imageData) {
    const m = String(b.imageData).match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
    if (!m) throw store.httpError(400, 'The start image must be a PNG, JPG, WEBP or GIF.');
    return { buf: Buffer.from(m[2], 'base64'), ext: '.' + m[1].toLowerCase().replace('jpeg', 'jpg') };
  }
  if (b.imageFrom) {
    const name = path.basename(String(b.imageFrom));
    const ext = path.extname(name).toLowerCase();
    if (!IMG_EXT.includes(ext)) throw store.httpError(400, 'Pick an image, not a video.');
    const full = path.join(OUT_DIR, name);
    if (!fs.existsSync(full)) throw store.httpError(404, 'That image is no longer on disk.');
    return { buf: fs.readFileSync(full), ext };
  }
  return null;
}

async function generate(b) {
  if (!b.workflow) throw store.httpError(400, 'Choose a workflow first.');
  const wf = await getWorkflow(String(b.workflow));
  const bind = wf.bindings || {};
  const prompt = String(b.prompt || '').trim();
  if (bind.prompt && !prompt) throw store.httpError(400, 'Describe what you want first.');
  const img = imageBuffer(b);
  if (bind.image && !img && wf.kind === 'video') throw store.httpError(400, 'This workflow animates a picture. Use "Animate" on an image, or choose a start image.');
  let imageName = '';
  if (bind.image && img) imageName = await uploadImage(img.buf, 'omnistudio-' + Date.now().toString(36) + img.ext);
  const count = clamp(Math.round(Number(b.count) || 1), 1, 8);
  const p = b.params || {};
  const base = Number(p.seed);
  const records = [];
  for (let i = 0; i < count; i++) {
    const params = { ...p, prompt, negative: typeof b.negative === 'string' ? b.negative : undefined, imageName, seed: Number.isFinite(base) && base >= 0 ? base + i : undefined };
    const graph = apply(wf.graph, bind, params);
    const seedUsed = bind.seed && graph[bind.seed[0].node].inputs[bind.seed[0].input];
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const rec = {
      id, created: Date.now() + i, kind: wf.kind, workflow: wf.id, workflowName: wf.name, prompt, negative: params.negative || '',
      params: { seed: seedUsed, steps: p.steps, cfg: p.cfg, width: p.width, height: p.height, frames: p.frames, fps: p.fps },
      status: 'running', note: 'Starting…', progress: null, files: [],
    };
    ACTIVE.set(id, rec);
    saveRecord(rec);
    records.push(rec);
    runRecord(rec, graph); // background; the UI polls /api/comfy/jobs
  }
  return records;
}

async function stopJob(id) {
  if (!store.safeId(id)) throw store.httpError(400, 'Bad job id.');
  const rec = ACTIVE.get(id) || config.readJson(recordPath(id), null);
  if (!rec) throw store.httpError(404, 'Job not found.');
  rec.cancelled = true;
  if (rec.comfyId) {
    try {
      const q = await getJson('/queue', 8000);
      if ((q.queue_running || []).some((x) => x[1] === rec.comfyId)) await call('/interrupt', { method: 'POST', body: {}, timeoutMs: 8000 });
      else await call('/queue', { method: 'POST', body: { delete: [rec.comfyId] }, timeoutMs: 8000 });
    } catch { /* ComfyUI unreachable: the local job still stops waiting */ }
  }
  return { ok: true };
}

async function freeMemory() {
  const r = await call('/free', { method: 'POST', body: { unload_models: true, free_memory: true }, timeoutMs: 15000 });
  if (!r.ok) throw store.httpError(502, `ComfyUI answered HTTP ${r.status} to the memory request. Update ComfyUI to use this.`);
  return { ok: true };
}

module.exports = {
  OUT_DIR, MIME, status, saveSettings, discover, listWorkflows, getWorkflow, importWorkflow, deleteWorkflow,
  generate, listJobs, deleteJob, stopJob, freeMemory, markStale,
  // exported for tests
  analyze, apply, preflight, optionsOf, familyOf, buildAuto,
};
