'use strict';
/**
 * Rules for files attached to a chat message. Shared: the server enforces them (a browser is never trusted),
 * the browser uses the same code for instant feedback (<script src="/shared/attach-rules.js">).
 */
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'env', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'php', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'swift', 'sh', 'bat', 'ps1', 'sql', 'r', 'lua', 'vue', 'svelte']);
const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const BLOCKED_EXT = new Set(['exe', 'dll', 'msi', 'com', 'scr', 'app', 'apk', 'jar', 'bin', 'dmg', 'iso', 'zip', 'rar', '7z', 'tar', 'gz']);
const DEFAULT_LIMITS = { maxFiles: 4, maxFileMB: 4, maxTextKB: 256 };
const HARD = { maxFiles: [1, 6], maxFileMB: [1, 5], maxTextKB: [16, 1024] };
const TOTAL_IMAGE_MB = 16;

const clampInt = (v, [lo, hi], d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

/** Only known keys with sane values. */
function sanitizeLimits(b, old) {
  const base = { ...DEFAULT_LIMITS, ...(old || {}) };
  const out = { ...base };
  if (b && typeof b === 'object') for (const k of Object.keys(HARD)) if (b[k] !== undefined) out[k] = clampInt(b[k], HARD[k], base[k]);
  return out;
}

const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');

/**
 * Check one file by name, claimed type and size. Returns { ok, kind: 'image'|'text', mime } or { ok: false, error }.
 * Never trusts the browser's type alone: images are also checked by their first bytes on the server (see imageMagic).
 */
function checkFile(file, limits) {
  const L = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const name = String(file && file.name || '').slice(0, 200);
  const size = Number(file && file.size) || 0;
  const ext = extOf(name);
  if (!name) return { ok: false, error: 'The file has no name.' };
  if (BLOCKED_EXT.has(ext)) return { ok: false, error: `${name}: programs and archives cannot be attached.` };
  if (ext === 'pdf' || file.type === 'application/pdf') return { ok: false, error: `${name}: PDF text extraction is not built in yet. Copy the text into the message, or save it as .txt or .md and attach that.` };
  if (!size) return { ok: false, error: `${name} is empty.` };
  if (IMAGE_EXT[ext] && (!file.type || IMAGE_TYPES[file.type])) {
    if (size > L.maxFileMB * 1048576) return { ok: false, error: `${name} is ${fmtSize(size)}; images can be up to ${L.maxFileMB} MB.` };
    return { ok: true, kind: 'image', mime: IMAGE_EXT[ext] };
  }
  if (TEXT_EXT.has(ext)) {
    if (size > L.maxTextKB * 1024) return { ok: false, error: `${name} is ${fmtSize(size)}; text files can be up to ${L.maxTextKB} KB.` };
    return { ok: true, kind: 'text', mime: 'text/plain' };
  }
  return { ok: false, error: `${name}: this type is not supported. Images (png, jpg, webp, gif) and text or code files are.` };
}

/** Does this byte sequence start like the image type it claims to be? */
function imageMagic(bytes, mime) {
  const b = bytes;
  if (mime === 'image/png') return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (mime === 'image/jpeg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === 'image/gif') return b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
  if (mime === 'image/webp') return b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  return false;
}

const attachApi = { IMAGE_TYPES, TEXT_EXT, DEFAULT_LIMITS, HARD, TOTAL_IMAGE_MB, sanitizeLimits, checkFile, imageMagic, extOf, fmtSize };
if (typeof module !== 'undefined' && module.exports) module.exports = attachApi;
else if (typeof window !== 'undefined') window.AttachRules = attachApi;
