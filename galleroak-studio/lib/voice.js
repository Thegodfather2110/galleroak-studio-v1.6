'use strict';
/**
 * Voice: the ears and the mouth. Two jobs on the server, both optional (the browser can do both by itself):
 *   transcribe(): audio recorded in the browser -> OmniRoute's /audio/transcriptions -> text
 *   speak():      text -> OmniRoute's /audio/speech -> audio bytes the browser plays and lip-syncs to
 * Settings live in config.voice.
 */
const config = require('./config');
const omni = require('./omni');

const MAX_AUDIO = 20 * 1024 * 1024;
const MAX_SPEECH = 30 * 1024 * 1024;
const FORMATS = ['mp3', 'wav', 'opus', 'aac', 'flac'];
const TYPE_OF = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac' };
const EXT_OF = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac',
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const okPath = (s) => typeof s === 'string' && /^\/[A-Za-z0-9/_.\-]{1,100}$/.test(s.trim()) && !s.includes('..');
const okLang = (s) => s === '' || /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(s);

/** Only known keys with sane values reach the config file. */
function sanitize(b) {
  const out = {};
  if (b.stt && typeof b.stt === 'object') {
    const s = {};
    if (['browser', 'omniroute'].includes(b.stt.engine)) s.engine = b.stt.engine;
    if (typeof b.stt.language === 'string' && okLang(b.stt.language.trim())) s.language = b.stt.language.trim();
    if (typeof b.stt.model === 'string' && b.stt.model.trim()) s.model = b.stt.model.trim().slice(0, 100);
    if (okPath(b.stt.path)) s.path = b.stt.path.trim();
    out.stt = s;
  }
  if (b.tts && typeof b.tts === 'object') {
    const t = {};
    if (['browser', 'omniroute'].includes(b.tts.engine)) t.engine = b.tts.engine;
    if (typeof b.tts.model === 'string' && b.tts.model.trim()) t.model = b.tts.model.trim().slice(0, 100);
    if (okPath(b.tts.path)) t.path = b.tts.path.trim();
    if (FORMATS.includes(b.tts.format)) t.format = b.tts.format;
    out.tts = t;
  }
  if (typeof b.interrupt === 'boolean') out.interrupt = b.interrupt;
  return out;
}

async function transcribe(b) {
  const cfg = config.load().voice.stt;
  const mime = String(b.mime || 'audio/webm').split(';')[0].trim().toLowerCase();
  const ext = EXT_OF[mime];
  if (!ext) throw httpError(415, `Audio type ${mime} is not supported. Use webm, ogg, wav, mp3, m4a, aac or flac.`);
  const data = String(b.audio || '');
  if (!data) throw httpError(400, 'No audio was sent.');
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw httpError(400, 'The audio was empty.');
  if (buf.length > MAX_AUDIO) throw httpError(413, 'That recording is too long (20 MB limit). Speak in shorter pieces.');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), 'speech.' + ext);
  form.append('model', cfg.model);
  form.append('response_format', 'json');
  const lang = String(b.language || cfg.language || '').trim();
  if (lang) form.append('language', lang.length > 3 ? lang.slice(0, 2).toLowerCase() : lang.toLowerCase()); // Whisper wants "en", not "en-US"
  let resp;
  try {
    resp = await omni.postForm(cfg.path, form, { timeoutMs: 120000 });
  } catch (e) {
    throw httpError(502, omni.describeNetworkError(e));
  }
  if (!resp.ok) {
    const hint = resp.status === 404 ? ` OmniRoute may not offer speech-to-text at ${cfg.path}; check the path and model in Voice settings, or switch Ears to the browser engine.` : '';
    throw httpError(502, `OmniRoute could not transcribe (HTTP ${resp.status}): ${await omni.readError(resp)}.${hint}`);
  }
  let j = {};
  try { j = await resp.json(); } catch {}
  return { text: typeof j.text === 'string' ? j.text.trim() : '' };
}

async function speak(b) {
  const cfg = config.load().voice.tts;
  const input = String(b.text || '').trim().slice(0, 4000);
  if (!input) throw httpError(400, 'Nothing to say.');
  const body = { model: typeof b.model === 'string' && b.model.trim() ? b.model.trim().slice(0, 100) : cfg.model, input, voice: String(b.voice || 'alloy').trim().slice(0, 100) || 'alloy', response_format: cfg.format };
  const speed = Number(b.speed);
  if (Number.isFinite(speed) && speed > 0) body.speed = Math.max(0.5, Math.min(2, speed));
  let resp;
  try {
    resp = await omni.postJson(cfg.path, body, { timeoutMs: 120000, headers: { Accept: 'audio/*, application/json' } });
  } catch (e) {
    throw httpError(502, omni.describeNetworkError(e));
  }
  if (!resp.ok) {
    const hint = resp.status === 404 ? ` OmniRoute may not offer text-to-speech at ${cfg.path}; check the path and model in Voice settings, or switch Voice to the browser engine.` : '';
    throw httpError(502, `OmniRoute could not speak (HTTP ${resp.status}): ${await omni.readError(resp)}.${hint}`);
  }
  const type = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  let buffer;
  if (type.includes('json')) {
    // some gateways wrap the audio as base64 in JSON
    let j = {};
    try { j = await resp.json(); } catch {}
    const b64 = j.audio || j.audio_content || j.b64_json || (j.data && j.data[0] && j.data[0].b64_json) || '';
    if (!b64) throw httpError(502, 'OmniRoute answered with JSON but no audio. Check the speech model in Voice settings.');
    buffer = Buffer.from(String(b64), 'base64');
    return finish(buffer, TYPE_OF[cfg.format] || 'audio/mpeg');
  }
  buffer = Buffer.from(await resp.arrayBuffer());
  return finish(buffer, type && type !== 'application/octet-stream' ? type : TYPE_OF[cfg.format] || 'audio/mpeg');
}

function finish(buffer, type) {
  if (!buffer.length) throw httpError(502, 'OmniRoute returned empty audio.');
  if (buffer.length > MAX_SPEECH) throw httpError(502, 'The audio was too large to play.');
  return { buffer, type };
}

module.exports = { sanitize, transcribe, speak, FORMATS };
