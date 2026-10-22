'use strict';
/**
 * Text helpers for talking with your combos. Shared by the server tests and the browser (<script src="/shared/voice-text.js">).
 *
 *  - cleanInline(text)         markdown / links / emoji out, so a voice reads it naturally
 *  - createFeeder()            turns a reply that is still streaming into speakable sentences, one at a time.
 *                              Code blocks are never read out (one short note is spoken instead).
 *  - routeUtterance(text, personas)  "Sage, what do you think?" -> { persona: Sage, text: "what do you think?" }
 *  - nameVariants(persona)     the spellings a speech recogniser may produce for a name
 */

const GREETINGS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'so', 'listen']);

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function nameVariants(persona) {
  const set = new Set();
  const add = (v) => { const n = normalizeName(v); if (n.length >= 3) set.add(n); };
  add(persona && persona.name);
  for (const a of (persona && persona.aliases) || []) add(a);
  return [...set];
}

/** If the sentence starts by calling someone by name (optionally after "hey"), return that persona and the rest. */
function routeUtterance(text, personas) {
  const raw = String(text || '').trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { persona: null, text: raw };
  const g = GREETINGS.has(normalizeName(tokens[0])) ? 1 : 0;
  for (let k = 1; k <= 3; k++) {
    if (g + k > tokens.length) break;
    const cand = normalizeName(tokens.slice(g, g + k).join(''));
    if (!cand) continue;
    for (const p of personas || []) {
      if (nameVariants(p).includes(cand)) {
        return { persona: p, text: tokens.slice(g + k).join(' ').replace(/^[\s,.:;!?\-–—]+/, ''), addressed: true };
      }
    }
  }
  return { persona: null, text: raw };
}

function cleanInline(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?;:)]|$)/g, '$1$2')
    .replace(/(\w)_(?=\w)/g, '$1 ')
    .replace(/(\*\*|__|~~|\*)/g, '')
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|dr|mr|mrs|ms|st|no|approx|inc|ltd|fig)$/i;

/** Index just after the end of the sentence that starts at `from`, or -1 if it is not finished yet. */
function sentenceEnd(text, from, final) {
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (ch === '`' && text.startsWith('```', j)) return j > from ? j : -1; // a code block starts here
    if (ch === '\n') return j + 1;
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let k = j + 1;
      while (k < text.length && /["'”’)\]*_]/.test(text[k])) k++;
      if (k >= text.length) { if (final) return k; return -1; }
      if (!/\s/.test(text[k])) continue; // 3.5, example.com, file.js
      if (ch === '.' && ABBREV.test(text.slice(Math.max(from, j - 8), j))) continue;
      return k;
    }
  }
  return final && from < text.length ? text.length : -1;
}

function chunkLong(s, max = 260) {
  const out = [];
  while (s.length > max) {
    let cut = s.lastIndexOf(', ', max - 20);
    if (cut < 80) cut = s.lastIndexOf(' ', max - 20);
    if (cut <= 0) cut = max - 20;
    out.push(s.slice(0, cut + 1).trim());
    s = s.slice(cut + 1).trim();
  }
  if (s) out.push(s);
  return out;
}

/**
 * feeder.push(textSoFar, final) -> array of new sentences to speak (possibly empty).
 * Call it again with the longer text as the reply streams in; call it with final=true at the end.
 */
function createFeeder() {
  let pos = 0, noted = false, pending = '';
  const MIN = 14; // very short sentences are joined to the next one so speech does not sound chopped
  return {
    push(raw, final) {
      const text = String(raw || '');
      const out = [];
      const emit = (s) => {
        const joined = (pending ? pending + ' ' : '') + s;
        if (joined.length < MIN) { pending = joined; return; }
        pending = '';
        out.push(...chunkLong(joined));
      };
      while (pos < text.length) {
        if (text.startsWith('```', pos)) {
          const close = text.indexOf('```', pos + 3);
          if (close < 0) {
            if (!final) break;
            pos = text.length;
          } else {
            pos = close + 3;
          }
          if (!noted) { noted = true; if (pending) { out.push(pending); pending = ''; } out.push("I've put the code in the chat."); }
          continue;
        }
        const end = sentenceEnd(text, pos, final);
        if (end < 0) break;
        const clean = cleanInline(text.slice(pos, end));
        pos = end;
        if (/[\p{L}\p{N}]/u.test(clean)) emit(clean);
      }
      if (final && pending) { out.push(pending); pending = ''; }
      return out;
    },
  };
}

/** Everything in one go (for a finished message). */
function speakable(text) {
  return createFeeder().push(text, true);
}

const voiceTextApi = { normalizeName, nameVariants, routeUtterance, cleanInline, createFeeder, speakable, sentenceEnd, chunkLong };
if (typeof module !== 'undefined' && module.exports) module.exports = voiceTextApi;
else if (typeof window !== 'undefined') window.VoiceText = voiceTextApi;
