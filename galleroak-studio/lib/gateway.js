'use strict';
/* App Chatbot gateway.
   Lets your own apps (a shop app, a website, a WhatsApp bot) use OmniRoute as a customer-support chatbot in Hindi, Hinglish and English.
   Each app gets a connector: a URL plus an API key. The gateway is a second, separate HTTP server (off by default) so that
   GallerOak Studio itself stays on 127.0.0.1. Customer messages are never written to the activity log. */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const omni = require('./omni');
const lang = require('./lang');
const personas = require('./personas');

const FILE = path.join(config.DATA_DIR, 'gateway.json');
const EVENTS = path.join(config.DATA_DIR, 'gateway-events.jsonl');
const MAX_BODY = 256 * 1024;
const MAX_MSGS = 60;
const MAX_MSG_CHARS = 8000;
const MAX_TOTAL_CHARS = 40000;
const MAX_TOKENS_CAP = 2000;
const IDLE_MS = 90 * 1000;
const BAN_AFTER = 5;
const BAN_WINDOW_MS = 5 * 60 * 1000;
const BAN_MS = 15 * 60 * 1000;
const EVENTS_KEEP = 5000;

const DEFAULT_STATE = { enabled: false, port: 8765, allowNonLan: false, rateLimit: 60, publicRateLimit: 12, model: '', defaults: {}, connectors: [] };

let state = null;
let dirty = false;
let flushTimer = null;
let server = null;
let listening = null; // { port, error }
const hits = new Map(); // key -> [timestamps]
const strikes = new Map(); // ip -> { fails: [], until }
let events = null;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ------------------------------ state ------------------------------ */

function load() {
  if (!state) {
    const raw = config.readJson(FILE, {});
    state = { ...DEFAULT_STATE, ...raw };
    if (!Array.isArray(state.connectors)) state.connectors = [];
    state.defaults = cleanSettings(state.defaults || {}, {});
  }
  return state;
}

function save() {
  config.writeJsonAtomic(FILE, load());
  dirty = false;
}

function touch() {
  dirty = true;
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (dirty) save();
    }, 4000);
    flushTimer.unref();
  }
}

function cleanSettings(b, base) {
  const d = lang.DEFAULT_SETTINGS;
  const out = { ...d, ...(base || {}) };
  const str = (k, max) => {
    if (b[k] !== undefined) out[k] = String(b[k] == null ? '' : b[k]).slice(0, max);
  };
  if (b.language !== undefined) {
    if (!['auto', 'en', 'hi', 'hinglish'].includes(b.language)) throw httpError(400, 'Language must be auto, en, hi or hinglish.');
    out.language = b.language;
  }
  str('business', 120);
  str('about', 6000);
  if (b.tone !== undefined) {
    if (!['friendly', 'formal', 'casual'].includes(b.tone)) throw httpError(400, 'Tone must be friendly, formal or casual.');
    out.tone = b.tone;
  }
  str('handoff', 400);
  str('greeting', 300);
  str('model', 200);
  str('personaId', 60);
  str('allowedOrigins', 600);
  if (b.maxTokens !== undefined) {
    const n = Math.round(Number(b.maxTokens));
    if (!Number.isFinite(n) || n < 50 || n > MAX_TOKENS_CAP) throw httpError(400, `Max reply length must be 50 to ${MAX_TOKENS_CAP} tokens.`);
    out.maxTokens = n;
  }
  if (b.publicChat !== undefined) out.publicChat = !!b.publicChat;
  return out;
}

function effective(conn) {
  return { ...lang.DEFAULT_SETTINGS, ...load().defaults, ...(conn.settings || {}) };
}

/* ------------------------------ events (metadata only) ------------------------------ */

function loadEvents() {
  if (events) return events;
  events = [];
  try {
    const lines = fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean);
    for (const l of lines.slice(-EVENTS_KEEP)) {
      try {
        events.push(JSON.parse(l));
      } catch {}
    }
    if (lines.length > EVENTS_KEEP * 1.2) fs.writeFileSync(EVENTS, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } catch {}
  return events;
}

function log(level, kind, connector, ip, detail) {
  const ev = { t: Date.now(), level, kind, connector: connector || '', ip: ip || '', detail: String(detail || '').slice(0, 300) };
  loadEvents().push(ev);
  if (events.length > EVENTS_KEEP) events.splice(0, events.length - EVENTS_KEEP);
  try {
    config.ensureDir(config.DATA_DIR);
    fs.appendFileSync(EVENTS, JSON.stringify(ev) + '\n');
  } catch {}
  return ev;
}

function listEvents(limit, filter) {
  let list = loadEvents();
  if (filter && filter.level) list = list.filter((e) => e.level === filter.level);
  if (filter && filter.connector) list = list.filter((e) => e.connector === filter.connector);
  return list.slice(-Math.min(Number(limit) || 200, 1000)).reverse();
}

function clearEvents() {
  events = [];
  try {
    fs.writeFileSync(EVENTS, '');
  } catch {}
}

/* ------------------------------ network helpers ------------------------------ */

function clientIp(req) {
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function isLoopback(ip) {
  return ip === '::1' || ip.startsWith('127.');
}

function isLan(ip) {
  if (isLoopback(ip)) return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const low = ip.toLowerCase();
  return low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd');
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function rateOk(key, limit, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  return true;
}

function banned(ip) {
  const s = strikes.get(ip);
  return !!(s && s.until && s.until > Date.now());
}

function strike(ip, connector, why) {
  if (isLoopback(ip)) return;
  const now = Date.now();
  const s = strikes.get(ip) || { fails: [], until: 0 };
  s.fails = s.fails.filter((t) => now - t < BAN_WINDOW_MS);
  s.fails.push(now);
  if (s.fails.length >= BAN_AFTER && !(s.until > now)) {
    s.until = now + BAN_MS;
    s.fails = [];
    log('alert', 'banned', connector, ip, `Blocked for ${BAN_MS / 60000} minutes after ${BAN_AFTER} failed attempts (${why}).`);
  }
  strikes.set(ip, s);
}

function bannedList() {
  const now = Date.now();
  return [...strikes.entries()].filter(([, s]) => s.until > now).map(([ip, s]) => ({ ip, until: s.until }));
}

function unban(ip) {
  if (ip) strikes.delete(ip);
  else strikes.clear();
}

/* ------------------------------ connectors ------------------------------ */

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function newKey() {
  return 'gk_' + crypto.randomBytes(24).toString('base64url');
}

function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function find(id) {
  return load().connectors.find((c) => c.id === id);
}

function view(c) {
  const idle = !c.last_seen || Date.now() - c.last_seen > IDLE_MS;
  return {
    id: c.id,
    name: c.name,
    hint: c.hint,
    created: c.created,
    revoked: !!c.revoked,
    last_seen: c.last_seen || 0,
    last_ip: c.last_ip || '',
    requests: c.requests || 0,
    known_ips: c.known_ips || [],
    status: c.revoked ? 'revoked' : idle ? 'idle' : 'connected',
    settings: effective(c),
    own: c.settings || {},
  };
}

function createConnector(b) {
  const name = String((b && b.name) || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) throw httpError(400, 'Give the app a name.');
  const s = load();
  if (s.connectors.length >= 50) throw httpError(400, 'Too many connectors (50). Delete unused ones first.');
  const key = newKey();
  const c = {
    id: 'c_' + crypto.randomBytes(6).toString('hex'),
    name,
    key_hash: hashKey(key),
    hint: 'gk_…' + key.slice(-4),
    created: Date.now(),
    revoked: false,
    last_seen: 0,
    last_ip: '',
    requests: 0,
    known_ips: [],
    settings: cleanSettings((b && b.settings) || {}, {}),
  };
  s.connectors.push(c);
  save();
  log('info', 'created', c.id, '', `Connector "${name}" created.`);
  return { connector: view(c), key };
}

function updateConnector(id, b) {
  const c = find(id);
  if (!c) throw httpError(404, 'Connector not found');
  if (b.name !== undefined) {
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!name) throw httpError(400, 'Give the app a name.');
    c.name = name;
  }
  if (b.settings) c.settings = cleanSettings(b.settings, c.settings || {});
  save();
  return view(c);
}

function setRevoked(id, revoked) {
  const c = find(id);
  if (!c) throw httpError(404, 'Connector not found');
  c.revoked = !!revoked;
  save();
  log('warn', revoked ? 'revoked' : 'restored', c.id, '', `Connector "${c.name}" ${revoked ? 'revoked' : 'restored'}.`);
  return view(c);
}

function rotate(id) {
  const c = find(id);
  if (!c) throw httpError(404, 'Connector not found');
  const key = newKey();
  c.key_hash = hashKey(key);
  c.hint = 'gk_…' + key.slice(-4);
  c.revoked = false;
  save();
  log('warn', 'rotated', c.id, '', `New key issued for "${c.name}". The old key stopped working.`);
  return { connector: view(c), key };
}

function removeConnector(id) {
  const s = load();
  const i = s.connectors.findIndex((c) => c.id === id);
  if (i < 0) throw httpError(404, 'Connector not found');
  const [c] = s.connectors.splice(i, 1);
  save();
  log('warn', 'deleted', c.id, '', `Connector "${c.name}" deleted.`);
}

/* ------------------------------ global config ------------------------------ */

function getConfig() {
  const s = load();
  return {
    enabled: s.enabled,
    port: s.port,
    allowNonLan: s.allowNonLan,
    rateLimit: s.rateLimit,
    publicRateLimit: s.publicRateLimit,
    model: s.model,
    defaults: effective({}),
  };
}

function saveConfig(b) {
  const s = load();
  if (b.port !== undefined) {
    const n = Math.round(Number(b.port));
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw httpError(400, 'Port must be 1024 to 65535.');
    if (n === Number(process.env.PORT || 3210)) throw httpError(400, 'That port is used by GallerOak Studio itself.');
    s.port = n;
  }
  if (b.enabled !== undefined) s.enabled = !!b.enabled;
  if (b.allowNonLan !== undefined) s.allowNonLan = !!b.allowNonLan;
  for (const k of ['rateLimit', 'publicRateLimit']) {
    if (b[k] !== undefined) {
      const n = Math.round(Number(b[k]));
      if (!Number.isFinite(n) || n < 1 || n > 1000) throw httpError(400, 'Rate limits must be 1 to 1000 per minute.');
      s[k] = n;
    }
  }
  if (b.model !== undefined) s.model = String(b.model || '').slice(0, 200);
  if (b.defaults) s.defaults = cleanSettings(b.defaults, s.defaults);
  save();
  return getConfig();
}

/* ------------------------------ chat pipeline ------------------------------ */

function modelFor(c) {
  const s = effective(c);
  let model = s.model || load().model || '';
  if (!model && s.personaId) {
    try {
      model = personas.get(s.personaId).model || '';
    } catch {}
  }
  return model || config.load().modeModels.chat || '';
}

function personaPrompt(c) {
  const s = effective(c);
  if (!s.personaId) return '';
  try {
    return personas.get(s.personaId).system || '';
  } catch {
    return '';
  }
}

/** Validate the customer's messages and build the body that goes to OmniRoute. Throws 422 on bad input. */
function prepare(c, body, opts = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(422, 'Body must be a JSON object.');
  const raw = body.messages;
  if (!Array.isArray(raw) || !raw.length) throw httpError(422, '"messages" must be a non-empty list.');
  if (raw.length > MAX_MSGS) throw httpError(422, `At most ${MAX_MSGS} messages.`);
  const msgs = [];
  let total = 0;
  for (const m of raw) {
    if (!m || typeof m !== 'object' || typeof m.content !== 'string') throw httpError(422, 'Every message needs a text "content" (images and tool calls are not supported).');
    if (!['user', 'assistant', 'system'].includes(m.role)) throw httpError(422, 'Roles allowed: user, assistant.');
    if (m.content.length > MAX_MSG_CHARS) throw httpError(422, `A message is longer than ${MAX_MSG_CHARS} characters.`);
    total += m.content.length;
    if (m.role === 'system') continue; // the app cannot override the gateway's own instructions
    msgs.push({ role: m.role, content: m.content });
  }
  if (total > MAX_TOTAL_CHARS) throw httpError(422, 'The conversation is too long. Send only the recent messages.');
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw httpError(422, 'The last message must be from the user.');
  const model = modelFor(c);
  if (!model) throw httpError(503, 'No model is set for this connector. Pick one in GallerOak Studio → App Chatbot → Settings.');
  const s = effective(c);
  const forced = opts.pub && s.language === 'auto' && ['en', 'hi', 'hinglish'].includes(body.language) ? body.language : '';
  const language = forced || (s.language === 'auto' ? lang.detect(msgs) : s.language);
  const last = msgs[msgs.length - 1].content;
  const handoff = lang.wantsHandoff(last);
  let system = lang.buildSystem({ ...s, language: forced || s.language }, language, personaPrompt(c));
  if (handoff) system += '\n\nThe customer is asking for a human or is unhappy. Acknowledge them kindly and give the hand-off message. Do not try to keep solving it yourself.';
  const out = { model, messages: [{ role: 'system', content: system }, ...msgs], stream: !!opts.stream && body.stream === true };
  const t = Number(body.temperature);
  if (Number.isFinite(t)) out.temperature = Math.min(2, Math.max(0, t));
  const tp = Number(body.top_p);
  if (Number.isFinite(tp)) out.top_p = Math.min(1, Math.max(0, tp));
  const mt = Math.round(Number(body.max_tokens));
  out.max_tokens = Number.isFinite(mt) && mt > 0 ? Math.min(mt, s.maxTokens, MAX_TOKENS_CAP) : s.maxTokens;
  return { upstream: out, language, handoff, model };
}

async function upstreamFail(resp, c, ip) {
  const msg = await omni.readError(resp);
  log('error', 'upstream', c.id, ip, `OmniRoute answered ${resp.status}: ${msg}`.slice(0, 280));
  return httpError(502, 'The AI service is not available right now. Please try again.');
}

/** Run one chat and return the OpenAI-shaped JSON plus extra fields. Used by the admin "Test chat". */
async function adminChat(id, messages) {
  const c = find(id);
  if (!c) throw httpError(404, 'Connector not found');
  const p = prepare(c, { messages }, { stream: false });
  let resp;
  try {
    resp = await omni.postJson('/chat/completions', p.upstream);
  } catch (e) {
    throw httpError(502, omni.describeNetworkError(e));
  }
  if (!resp.ok) throw httpError(502, await omni.readError(resp));
  const j = await resp.json();
  const reply = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return { reply, language: p.language, handoff: p.handoff, model: p.model };
}

/* ------------------------------ http ------------------------------ */

function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
}

function oaError(res, status, message, extra) {
  send(res, status, { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error' } }, extra);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY) {
      req.resume();
      return reject(httpError(413, 'Request body too large'));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, 'Body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function originAllowed(c, origin) {
  if (!origin) return true; // server to server calls have no Origin
  const list = String(effective(c).allowedOrigins || '')
    .split(/[\s,]+/)
    .filter(Boolean);
  return list.includes('*') || list.includes(origin);
}

function corsHeaders(c, req) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(c, origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600' };
}

function authenticate(req, res, c, ip) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  const key = m ? m[1] : '';
  const good = c && !!key && safeEq(hashKey(key), c.key_hash);
  if (!good) {
    log('warn', 'auth_failed', c ? c.id : '', ip, c ? 'Wrong or missing API key.' : 'Unknown connector id.');
    strike(ip, c ? c.id : '', 'bad key');
    oaError(res, 401, 'Invalid connector or API key.', { 'WWW-Authenticate': 'Bearer' });
    return false;
  }
  if (c.revoked) {
    log('warn', 'revoked_use', c.id, ip, 'A revoked connector tried to connect.');
    oaError(res, 403, 'This connector has been revoked.');
    return false;
  }
  return true;
}

function noteSeen(c, ip) {
  const now = Date.now();
  if (!c.last_seen || now - c.last_seen > IDLE_MS) log('info', 'connected', c.id, ip, `"${c.name}" connected.`);
  if (ip && !(c.known_ips || []).includes(ip)) {
    c.known_ips = [...(c.known_ips || []), ip].slice(-20);
    if (c.known_ips.length > 1) log('warn', 'new_ip', c.id, ip, `"${c.name}" is being used from a new address.`);
  }
  c.last_seen = now;
  c.last_ip = ip;
  c.requests = (c.requests || 0) + 1;
  touch();
}

async function chatRoute(req, res, c, ip, pub) {
  const cors = corsHeaders(c, req);
  if (!originAllowed(c, req.headers.origin)) {
    log('warn', 'origin_blocked', c.id, ip, 'Browser origin not allowed: ' + String(req.headers.origin).slice(0, 100));
    return oaError(res, 403, 'This website is not allowed to use the connector.');
  }
  const limit = pub ? load().publicRateLimit : load().rateLimit;
  if (!rateOk((pub ? 'pub:' + ip + ':' : 'c:') + c.id, limit)) {
    log('warn', 'rate_limited', c.id, ip, `More than ${limit} requests per minute.`);
    return oaError(res, 429, 'Too many requests. Please slow down.', { 'Retry-After': '30', ...cors });
  }
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    log('warn', 'bad_request', c.id, ip, e.message);
    return oaError(res, e.status || 400, e.message, cors);
  }
  let p;
  try {
    p = prepare(c, body, { stream: true, pub });
  } catch (e) {
    log('warn', e.status === 503 ? 'no_model' : 'bad_request', c.id, ip, e.message);
    return oaError(res, e.status || 422, e.message, cors);
  }
  if (!pub) noteSeen(c, ip);
  const meta = { 'X-Language': p.language, 'X-Handoff': p.handoff ? '1' : '0', 'Access-Control-Expose-Headers': 'X-Language, X-Handoff', ...cors };
  if (p.handoff) log('info', 'handoff', c.id, ip, `A customer asked for a human (${p.language}).`);
  let resp;
  try {
    resp = await omni.postJson('/chat/completions', p.upstream);
  } catch (e) {
    log('error', 'upstream', c.id, ip, omni.describeNetworkError(e));
    return oaError(res, 502, 'The AI service is not available right now. Please try again.', meta);
  }
  if (!resp.ok) {
    const err = await upstreamFail(resp, c, ip);
    return oaError(res, 502, err.message, meta);
  }
  log('info', 'chat', c.id, ip, `${pub ? 'public ' : ''}${p.language}${p.upstream.stream ? ' stream' : ''} model=${p.model}`);
  if (p.upstream.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...meta });
    omni.pipeBody(resp, res);
    return;
  }
  let j;
  try {
    j = await resp.json();
  } catch {
    return oaError(res, 502, 'The AI service sent an unreadable answer.', meta);
  }
  j.omni = { language: p.language, handoff: p.handoff };
  send(res, 200, j, meta);
}

function modelsRoute(res, c) {
  const id = modelFor(c) || 'support-bot';
  send(res, 200, { object: 'list', data: [{ id, object: 'model', owned_by: 'omnistudio' }] });
}

const pageApi = require('./gateway-page');

async function handle(req, res) {
  const ip = clientIp(req);
  const s = load();
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    return oaError(res, 400, 'Bad request');
  }
  const p = url.pathname;
  if (banned(ip)) return oaError(res, 429, 'Too many failed attempts. Try again later.', { 'Retry-After': '900' });
  if (!s.allowNonLan && !isLan(ip)) {
    log('alert', 'blocked', '', ip, 'Request from outside your local network was refused.');
    return oaError(res, 403, 'Forbidden');
  }
  if (p === '/assets/lang.js' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(fs.readFileSync(path.join(__dirname, 'lang.js')));
  }
  if (p === '/' && req.method === 'GET') return send(res, 200, { service: 'GallerOak Studio App Chatbot', ok: true });
  const m = /^\/c\/(c_[a-f0-9]{12})\/(.*)$/.exec(p);
  if (!m) {
    log('warn', 'probe', '', ip, `${req.method} ${p}`.slice(0, 120));
    return oaError(res, 404, 'Not found');
  }
  const c = find(m[1]);
  const rest = m[2];

  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      const h = c ? corsHeaders(c, req) : {};
      res.writeHead(Object.keys(h).length ? 204 : 403, h);
      return res.end();
    }
    // public chat: no key, only when the owner switched it on for this connector, LAN only, stricter limits
    if (c && rest === 'chat' && req.method === 'GET') {
      if (!effective(c).publicChat || c.revoked) return oaError(res, 404, 'Not found');
      const nonce = crypto.randomBytes(16).toString('base64');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      return res.end(pageApi.render(view(c), nonce, lang));
    }
    if (c && rest === 'v1/public' && req.method === 'POST') {
      if (!effective(c).publicChat || c.revoked) return oaError(res, 404, 'Not found');
      if (!isLan(ip)) return oaError(res, 403, 'Forbidden');
      return await chatRoute(req, res, c, ip, true);
    }
    // everything below needs the connector key
    if (!/^v1\/(ping|models|chat\/completions)$/.test(rest)) {
      log('warn', 'probe', m[1], ip, `${req.method} ${rest}`.slice(0, 120));
      return oaError(res, 404, 'Not found');
    }
    if (!authenticate(req, res, c, ip)) return;
    if (rest === 'v1/ping' && req.method === 'GET') {
      noteSeen(c, ip);
      return send(res, 200, { ok: true, name: c.name, languages: ['en', 'hi', 'hinglish'], model: modelFor(c) || null });
    }
    if (rest === 'v1/models' && req.method === 'GET') {
      noteSeen(c, ip);
      return modelsRoute(res, c);
    }
    if (rest === 'v1/chat/completions' && req.method === 'POST') return await chatRoute(req, res, c, ip, false);
    return oaError(res, 405, 'Method not allowed');
  } catch (e) {
    if (e && e.status) return oaError(res, e.status, e.message);
    log('error', 'internal', c ? c.id : '', ip, (e && e.message) || 'error');
    return oaError(res, 500, 'Internal error');
  }
}

/* ------------------------------ server lifecycle ------------------------------ */

function createServer() {
  const srv = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      try {
        res.writeHead(500);
        res.end();
      } catch {}
    });
  });
  srv.requestTimeout = 0;
  srv.headersTimeout = 20000;
  return srv;
}

function start() {
  const s = load();
  if (server) return Promise.resolve(status());
  if (!s.enabled) return Promise.resolve(status());
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', (e) => {
      listening = { port: s.port, error: e.code === 'EADDRINUSE' ? `Port ${s.port} is already in use. Pick another port.` : e.message };
      server = null;
      log('error', 'server', '', '', listening.error);
      resolve(status());
    });
    srv.listen(s.port, '0.0.0.0', () => {
      server = srv;
      listening = { port: s.port, error: '' };
      log('info', 'server', '', '', `Gateway listening on port ${s.port}.`);
      resolve(status());
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server) {
      listening = null;
      return resolve();
    }
    const srv = server;
    server = null;
    listening = null;
    srv.close(() => resolve());
    if (srv.closeAllConnections) srv.closeAllConnections();
  });
}

async function restart() {
  await stop();
  return start();
}

function status() {
  const s = load();
  return {
    enabled: s.enabled,
    running: !!server,
    port: s.port,
    error: (listening && listening.error) || '',
    addresses: lanAddresses().map((a) => `http://${a}:${s.port}`),
  };
}

async function upstreamStatus() {
  try {
    const r = await omni.getJson('/models');
    return { ok: r.ok, status: r.status, error: r.ok ? '' : await omni.readError(r) };
  } catch (e) {
    return { ok: false, status: 0, error: omni.describeNetworkError(e) };
  }
}

function snapshot() {
  const s = load();
  const evs = loadEvents();
  const day = Date.now() - 86400000;
  return {
    config: getConfig(),
    status: status(),
    connectors: s.connectors.map(view),
    banned: bannedList(),
    stats: {
      chats24h: evs.filter((e) => e.kind === 'chat' && e.t > day).length,
      handoffs24h: evs.filter((e) => e.kind === 'handoff' && e.t > day).length,
      alerts24h: evs.filter((e) => (e.level === 'alert' || e.level === 'warn') && e.t > day).length,
    },
    langNames: lang.LANG_NAMES,
  };
}

function autostart() {
  if (load().enabled) return start();
  return Promise.resolve(status());
}

function _reset() {
  hits.clear();
  strikes.clear();
}

module.exports = {
  FILE, EVENTS, load, getConfig, saveConfig, createConnector, updateConnector, setRevoked, rotate, removeConnector,
  listEvents, clearEvents, unban, adminChat, snapshot, start, stop, restart, status, autostart, upstreamStatus,
  createServer, handle, isLan, _reset, view,
};
