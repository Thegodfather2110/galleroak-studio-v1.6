'use strict';
/**
 * Voice and faces (GallerOak Studio 1.4).
 *   S.personas / S.personaFor(model) / S.personaModel(p)   the cast, and a face for every combo
 *   S.avatar(persona, px)                                    small hologram head as an <img>
 *   S.ears.listen(opts)                                      speech-to-text (browser or OmniRoute)
 *   S.mouth.create(persona, hooks)                           text-to-speech with lip-sync level (browser or OmniRoute)
 *   S.dictate(input)                                         a mic button for any text box
 *   S.speakDock(persona, mouth)                              small floating face that talks while a reply is read
 *   S.views.voice                                            the Voice tab: cast, stage, hands-free talk, persona editor
 */
(function () {
  const { el } = S;
  const VT = window.VoiceText;
  const ROLE_MODE = { chat: 'chat', reasoning: 'reasoning', coding: 'coding', video: 'video' };
  const ROLE_PROMPT_FALLBACK = {
    chat: 'You are warm, direct and capable. You help with anything the user brings.',
    reasoning: 'You are a careful analytical thinker. You work out problems step by step and say which part you are least sure about.',
    coding: 'You are a senior software engineer. You are precise and practical, and you prefer the simplest thing that works.',
    video: 'You are a film director and editor. You think in shots, pacing and story, and you help turn ideas into video prompts and plans.',
  };

  S.personas = [];
  S.personaMeta = { signs: [], horns: [], hair: [], eyes: [], extras: [], roles: [], rolePrompt: ROLE_PROMPT_FALLBACK };
  S.loadPersonas = async () => {
    try {
      const r = await S.api('GET', '/api/personas');
      S.personas = r.personas || [];
      S.personaMeta = { signs: r.signs, horns: r.horns, hair: r.hair, eyes: r.eyes, extras: r.extras, roles: r.roles, rolePrompt: r.rolePrompt || ROLE_PROMPT_FALLBACK };
    } catch { /* faces still work from generated personas */ }
    return S.personas;
  };

  const norm = VT.normalizeName;
  /** The persona for a model or combo id: an explicit match, a name match, or a generated face that is always the same for that id. */
  S.personaFor = (modelId) => {
    const id = String(modelId || '');
    if (!id) return S.personas[0] || Holo.autoPersona('assistant');
    const exact = S.personas.find((p) => p.model && p.model === id);
    if (exact) return exact;
    const n = norm(id);
    const byName = S.personas.find((p) => n && (n === norm(p.name) || VT.nameVariants(p).includes(n)));
    if (byName) return byName;
    return Holo.autoPersona(id);
  };
  S.personaModel = (p) => p.model || S.config.modeModels[ROLE_MODE[p.role] || 'chat'] || S.config.modeModels.chat || '';
  S.personaSystem = (p, extra) => {
    const role = (S.personaMeta.rolePrompt || ROLE_PROMPT_FALLBACK)[p.role] || ROLE_PROMPT_FALLBACK.chat;
    return [`You are ${p.name}${p.tagline ? ' (' + p.tagline + ')' : ''}. ${role}`, p.system, extra].filter(Boolean).join('\n');
  };
  S.avatar = (persona, px = 28) => el('img', { class: 'avatar', src: Holo.avatar(persona, px * 2) || '', width: px, height: px, alt: persona.name, title: persona.name + (persona.tagline ? ' · ' + persona.tagline : '') });
  S.signBadge = (persona, px = 22) => {
    const c = el('canvas', { width: px * 2, height: px * 2, style: `width:${px}px;height:${px}px` });
    Holo.drawSign(c.getContext('2d'), persona.sign, px, px, px * 0.82, persona.color, 1, px / 8);
    return c;
  };

  const vcfg = () => (S.config && S.config.voice) || { stt: { engine: 'browser', language: 'en-US' }, tts: { engine: 'browser' }, interrupt: false };

  /* ------------------------------------------------------------------ ears ------------------------------------------------------------------ */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let micStream = null;
  async function getMic() {
    if (micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live')) return micStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot reach the microphone here. Open GallerOak Studio at http://localhost:PORT (not a LAN address) or use HTTPS.');
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      throw new Error(e && e.name === 'NotAllowedError' ? 'Microphone permission was blocked. Allow it in the address bar, then try again.' : e && e.name === 'NotFoundError' ? 'No microphone was found.' : 'Could not open the microphone: ' + (e.message || e));
    }
    return micStream;
  }
  function releaseMic() { if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; } }

  let actx = null;
  const audioCtx = () => {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  };
  const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('Could not read the recording')); r.readAsDataURL(blob); });

  S.ears = {
    browserOk: !!SR,
    /**
     * opts: { once, language, engine, onInterim(text), onFinal(text), onLevel(0..1), onState('listening'|'hearing'|'processing'|'idle'), onError(msg), onEnd() }
     * returns { stop(), pause(bool), level() }
     */
    async listen(opts) {
      const cfg = vcfg().stt;
      const engine = opts.engine || cfg.engine;
      const lang = opts.language || cfg.language || 'en-US';
      let stopped = false, paused = false, level = 0, rafId = 0, an = null, src = null;
      const ctl = { stop: () => end(), pause: (v) => { paused = !!v; if (v) { level = 0; } }, level: () => level };
      const state = (s) => opts.onState && opts.onState(s);
      let stream;
      try { stream = await getMic(); } catch (e) {
        if (engine === 'omniroute' || !SR) { opts.onError && opts.onError(e.message); return ctl; }
        stream = null; // browser recogniser can still work without our own meter
      }
      const buf = new Uint8Array(1024);
      const rms = () => { if (!an) return 0; an.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; } return Math.sqrt(s / buf.length); };
      if (stream) {
        try {
          const ac = audioCtx();
          src = ac.createMediaStreamSource(stream); an = ac.createAnalyser(); an.fftSize = 1024; src.connect(an);
        } catch { an = null; }
      }

      function end() {
        if (stopped) return;
        stopped = true;
        cancelAnimationFrame(rafId);
        try { rec && rec.stop(); } catch {}
        try { mr && mr.state !== 'inactive' && mr.stop(); } catch {}
        try { src && src.disconnect(); } catch {}
        state('idle');
        opts.onEnd && opts.onEnd();
      }

      /* ---------- browser engine ---------- */
      let rec = null, mr = null;
      if (engine === 'browser') {
        if (!SR) { opts.onError && opts.onError('This browser has no built-in speech recognition (Chrome and Edge do). Choose the OmniRoute engine in Voice settings.'); return ctl; }
        rec = new SR();
        rec.lang = lang; rec.interimResults = true; rec.continuous = !opts.once; rec.maxAlternatives = 1;
        let heard = false;
        rec.onstart = () => state('listening');
        rec.onspeechstart = () => { heard = true; state('hearing'); };
        rec.onresult = (ev) => {
          if (paused) { if (vcfg().interrupt && opts.onBargeIn) opts.onBargeIn(); return; }
          let interim = '';
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i], t = r[0].transcript;
            if (r.isFinal) { const text = t.trim(); if (text) { state('processing'); opts.onFinal && opts.onFinal(text); } } else interim += t;
          }
          if (interim && opts.onInterim) opts.onInterim(interim.trim());
        };
        rec.onerror = (e) => {
          if (e.error === 'no-speech' || e.error === 'aborted') return;
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { opts.onError && opts.onError('Microphone permission was blocked for speech recognition.'); end(); return; }
          if (e.error === 'network') { opts.onError && opts.onError('The browser speech service is not reachable (it needs internet). Switch Ears to OmniRoute in Voice settings, or try again.'); end(); return; }
          opts.onError && opts.onError('Speech recognition error: ' + e.error);
        };
        rec.onend = () => {
          if (stopped) return;
          if (opts.once) { end(); return; }
          setTimeout(() => { if (!stopped) { try { rec.start(); } catch {} } }, 150); // Chrome ends sessions on its own; keep listening
        };
        try { rec.start(); } catch (e) { opts.onError && opts.onError(e.message); }
        const loop = () => { if (stopped) return; level = paused ? 0 : Math.min(1, rms() * 6); opts.onLevel && opts.onLevel(level); rafId = requestAnimationFrame(loop); };
        loop();
        void heard;
        return ctl;
      }

      /* ---------- OmniRoute engine: record per utterance, detect the end of speech by silence, send to /api/voice/transcribe ---------- */
      if (typeof MediaRecorder === 'undefined' || !stream) { opts.onError && opts.onError('This browser cannot record audio here.'); return ctl; }
      const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
      let chunks = [], voiced = 0, silentSince = 0, segStart = 0, speechT = 0, sending = 0, lastVoice = 0;
      const THRESH = 0.035, MIN_VOICE_MS = 220, END_SILENCE = opts.once ? 1100 : 900, MAX_SEG = 60000, IDLE_RESTART = 12000;

      const startSeg = () => {
        chunks = []; voiced = 0; speechT = 0; silentSince = 0; segStart = performance.now(); lastVoice = 0;
        mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onstop = async () => {
          const keep = voiced >= MIN_VOICE_MS && !mr._drop;
          const blob = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
          if (!stopped && !(opts.once && keep)) startSeg();
          if (!keep) { if (!stopped) state('listening'); return; }
          sending++; state('processing');
          try {
            const r = await S.api('POST', '/api/voice/transcribe', { audio: await b64(blob), mime: blob.type, language: lang });
            if (r.text) opts.onFinal && opts.onFinal(r.text);
          } catch (e) { opts.onError && opts.onError(e.message); }
          sending--;
          if (opts.once) end(); else if (!sending && !stopped) state('listening');
        };
        mr.start(250);
      };
      state('listening');
      startSeg();
      let prev = performance.now();
      const tick = () => {
        if (stopped) return;
        const now = performance.now(), dt = now - prev; prev = now;
        const v = paused ? 0 : rms();
        level = Math.min(1, v * 6);
        opts.onLevel && opts.onLevel(level);
        if (paused) { if (mr && mr.state === 'recording' && voiced) { mr._drop = true; mr.stop(); } }
        else if (mr && mr.state === 'recording') {
          if (v > THRESH) {
            voiced += dt; lastVoice = now; silentSince = 0;
            if (voiced > MIN_VOICE_MS) state('hearing');
            if (vcfg().interrupt && opts.onBargeIn) opts.onBargeIn();
          } else if (voiced >= MIN_VOICE_MS) {
            silentSince = silentSince || now;
            if (now - silentSince > END_SILENCE) mr.stop();
          } else if (now - segStart > IDLE_RESTART) { mr._drop = true; mr.stop(); }
          if (now - segStart > MAX_SEG) mr.stop();
        }
        rafId = requestAnimationFrame(tick);
      };
      tick();
      void speechT; void lastVoice;
      return ctl;
    },
  };

  /* ----------------------------------------------------------------- mouth ----------------------------------------------------------------- */
  const synth = window.speechSynthesis;
  let voiceList = [];
  const loadVoices = () => { voiceList = synth ? synth.getVoices() : []; };
  if (synth) { loadVoices(); synth.addEventListener && synth.addEventListener('voiceschanged', loadVoices); }
  S.browserVoices = () => (voiceList.length ? voiceList : (loadVoices(), voiceList));

  /** Pick a browser voice: the one chosen for the persona, otherwise a stable pick so each character sounds different. */
  function pickVoice(persona) {
    const vs = S.browserVoices();
    if (!vs.length) return null;
    const want = (persona.voice && persona.voice.browserVoice) || (S.ui && S.ui.get('voiceName'));
    if (want) { const f = vs.find((v) => v.name === want); if (f) return f; }
    const lang = (vcfg().stt.language || 'en-US').toLowerCase().slice(0, 2);
    const pool = vs.filter((v) => v.lang && v.lang.toLowerCase().startsWith(lang));
    const list = pool.length ? pool : vs;
    return list[Holo.hash(persona.id || persona.name) % list.length];
  }

  /**
   * A mouth speaks sentences one after another and reports a loudness for lip-sync.
   *   m.feed(textSoFar, final)  speak a reply while it streams in
   *   m.say(text)               speak a fixed line
   *   m.stop()                  silence at once and clear the queue
   *   m.level()                 0..1
   *   hooks: onStart(), onEnd() (all queued speech finished), onError(msg)
   */
  S.mouth = {
    create(persona, hooks = {}) {
      const feeder = VT.createFeeder();
      const queue = [];
      let playing = false, paused = false, closed = false, finalSeen = false, lv = 0, env = 0, token = 0, current = null;
      const cfg = () => vcfg().tts;
      const m = {
        get busy() { return playing || queue.length > 0; },
        level: () => lv,
        setPersona(p) { persona = p; },
        feed(text, final) {
          if (closed) return;
          const parts = feeder.push(text, !!final);
          parts.forEach((s) => queue.push(s));
          if (final) finalSeen = true;
          pump();
        },
        get paused() { return paused; },
        pause() { if (paused || !playing) return; paused = true; if (synth && synth.speaking) synth.pause(); if (current && current.pause) { try { current.pause(); } catch {} } },
        resume() { if (!paused) return; paused = false; if (synth && synth.paused) synth.resume(); if (current && current.play) { try { current.play(); } catch {} } },
        say(text) { VT.speakable(text).forEach((s) => queue.push(s)); finalSeen = true; pump(); },
        stop() {
          closed = true; paused = false; queue.length = 0; token++;
          if (synth) synth.cancel();
          if (current && current.pause) { try { current.pause(); } catch {} }
          current = null; playing = false; lv = 0;
          hooks.onEnd && hooks.onEnd(true);
        },
      };

      // pre-fetch audio for upcoming sentences while the current one plays (OmniRoute engine only)
      const fetched = new Map();
      const fetchAudio = (text) => {
        if (fetched.has(text)) return fetched.get(text);
        const v = persona.voice || {};
        const p = fetch('/api/voice/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: v.omniVoice || 'alloy', speed: Math.max(0.5, Math.min(2, (v.rate || 1) * (S.ui ? S.ui.get('speechRate') : 1))) }) })
          .then(async (r) => {
            if (!r.ok) { let j = null; try { j = await r.json(); } catch {} throw new Error((j && j.error) || 'Could not get speech from OmniRoute (' + r.status + ')'); }
            return URL.createObjectURL(await r.blob());
          });
        p.catch(() => {});
        fetched.set(text, p);
        return p;
      };

      async function playOmni(text, my) {
        if (my !== token) return;
        const url = await fetchAudio(text);
        fetched.delete(text);
        if (my !== token) { URL.revokeObjectURL(url); return; }
        const a = new Audio(url);
        a.volume = persona.voice && persona.voice.volume !== undefined ? persona.voice.volume : 1;
        current = a;
        let an = null, data = null;
        try {
          const ac = audioCtx();
          const s = ac.createMediaElementSource(a);
          an = ac.createAnalyser(); an.fftSize = 512; data = new Uint8Array(an.fftSize);
          s.connect(an); an.connect(ac.destination);
        } catch { an = null; }
        let raf = 0;
        const meter = () => {
          if (an) { an.getByteTimeDomainData(data); let sum = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; } lv = Math.min(1, Math.sqrt(sum / data.length) * 4.2); }
          else lv = 0.35 + 0.35 * Math.abs(Math.sin(performance.now() / 95)) * Math.random();
          raf = requestAnimationFrame(meter);
        };
        await new Promise((resolve, reject) => {
          a.onended = resolve; a.onerror = () => reject(new Error('The audio could not be played.')); a.onpause = () => { if (my !== token) resolve(); };
          a.play().then(meter).catch(reject);
        }).finally(() => { cancelAnimationFrame(raf); lv = 0; URL.revokeObjectURL(url); });
      }

      function playBrowser(text, my) {
        return new Promise((resolve) => {
          if (!synth) { resolve(); return; }
          const u = new SpeechSynthesisUtterance(text);
          const v = pickVoice(persona), pv = persona.voice || {};
          if (v) { u.voice = v; u.lang = v.lang; }
          u.pitch = pv.pitch || 1; u.rate = Math.max(0.5, Math.min(2, (pv.rate || 1) * (S.ui ? S.ui.get('speechRate') : 1))); u.volume = pv.volume === undefined ? 1 : pv.volume;
          let raf = 0, t0 = 0, boundary = 0;
          // the browser does not expose its audio, so loudness is estimated: a lift on every word boundary over a wobble while it speaks
          const meter = () => {
            const now = performance.now();
            env *= 0.86;
            if (now - boundary < 130) env = Math.max(env, 0.55 + 0.35 * Math.random());
            lv = Math.min(1, env * 0.9 + (now - t0 > 60 ? 0.1 + 0.1 * Math.abs(Math.sin(now / 70)) : 0));
            raf = requestAnimationFrame(meter);
          };
          u.onstart = () => { t0 = performance.now(); boundary = t0; meter(); };
          u.onboundary = () => { boundary = performance.now(); };
          const done = () => { cancelAnimationFrame(raf); lv = 0; env = 0; resolve(); };
          u.onend = done; u.onerror = done;
          current = null;
          synth.speak(u);
          // Chrome sometimes never fires onend for long text; a safety timer prevents a stuck queue
          const guard = setTimeout(() => { if (my === token) { try { synth.cancel(); } catch {} } }, 45000 + text.length * 90);
          const prevDone = u.onend;
          u.onend = () => { clearTimeout(guard); prevDone(); };
          u.onerror = () => { clearTimeout(guard); done(); };
        });
      }

      async function pump() {
        if (playing) {
          if (cfg().engine === 'omniroute') queue.slice(0, 2).forEach((t) => fetchAudio(t)); // warm the next sentences
          return;
        }
        playing = true;
        const my = token;
        hooks.onStart && hooks.onStart();
        try {
          while (queue.length && my === token) {
            const text = queue.shift();
            if (cfg().engine === 'omniroute') { queue.slice(0, 2).forEach((t) => fetchAudio(t)); await playOmni(text, my); } else await playBrowser(text, my);
          }
        } catch (e) {
          queue.length = 0;
          hooks.onError && hooks.onError(e.message);
        }
        if (my !== token) return;
        playing = false;
        if (!queue.length && (finalSeen || closed)) { hooks.onEnd && hooks.onEnd(false); }
        else if (queue.length) pump();
        else hooks.onIdle && hooks.onIdle(); // waiting for the rest of a streaming reply
      }
      return m;
    },
  };

  /* ------------------------------------------------------------ dictation button for any text box ------------------------------------------------------------ */
  S.dictate = (input, opts = {}) => {
    let ctl = null, base = '';
    const btn = el('button', { class: 'btn sm mic', type: 'button', 'aria-label': 'Dictate with your microphone', title: 'Dictate with your voice (click again to stop). Nothing is sent until you press send.', onclick: async () => {
      if (ctl) { ctl.stop(); return; }
      if (S._stopDictation) S._stopDictation();
      S._stopDictation = () => { if (ctl) ctl.stop(); };
      base = input.value ? input.value.replace(/\s*$/, ' ') : '';
      btn.classList.add('on');
      ctl = await S.ears.listen({
        once: true,
        onInterim: (t) => { input.value = base + t; input.dispatchEvent(new Event('input')); },
        onFinal: (t) => { input.value = base + t; input.dispatchEvent(new Event('input')); input.focus(); opts.onFinal && opts.onFinal(t); },
        onError: (m) => S.toast(m, true),
        onState: (s) => { btn.classList.toggle('hot', s === 'hearing'); btn.classList.toggle('busy', s === 'processing'); },
        onEnd: () => { btn.classList.remove('on', 'hot', 'busy'); ctl = null; },
      });
    } }, S.iconEl('mic'));
    btn.destroy = () => { if (ctl) ctl.stop(); };
    return btn;
  };

  /* ------------------------------------------------------------- floating face that talks while a reply is read aloud ------------------------------------------------------------- */
  S.speakDock = (persona, mouth) => {
    const old = S.$('#speak-dock'); if (old) old.remove();
    const canvas = el('canvas', { class: 'dock-canvas' });
    const label = el('div', { class: 'dock-name', style: `color:${persona.color}` }, persona.name);
    const stopBtn = el('button', { class: 'btn sm', onclick: () => { mouth.stop(); close(); } }, 'Stop');
    const root = el('div', { id: 'speak-dock', class: 'speak-dock' }, canvas, label, stopBtn);
    document.body.append(root);
    const face = Holo.createFace(canvas, persona, { detail: 'low', fps: 30, interactive: false });
    face.levelOut = () => mouth.level();
    face.setState('speaking');
    function close() { face.destroy(); root.remove(); }
    return { close, setIdle: (b) => face.setState(b ? 'idle' : 'speaking') };
  };

  /* --------------------------------------------------------------------- the Voice tab --------------------------------------------------------------------- */
  S.views.voice = (container) => {
    const st = (S.voiceState ||= { activeId: 'sage', history: [], handsFree: false });
    let personas = S.personas.slice();
    const combos = () => [...new Set([...(S.config.pinned || []), ...S.combos])].filter((c) => !personas.some((p) => p.model === c));
    const auto = new Map();
    const comboPersona = (id) => { if (!auto.has(id)) { const p = Holo.autoPersona(id); p.model = id; auto.set(id, p); } return auto.get(id); };
    const all = () => [...personas, ...combos().map(comboPersona)];
    const active = () => all().find((p) => p.id === st.activeId) || personas[0] || comboPersona('assistant');

    let ears = null, mouth = null, abort = null, busy = false, speaking = false, face = null, status = 'idle', interimText = '', mouthFeedLen = 0;
    const canvas = el('canvas', { class: 'stage-canvas' });
    const nameEl = el('div', { class: 'stage-name' }), tagEl = el('div', { class: 'stage-tag' }), stateEl = el('div', { class: 'stage-state' });
    const interimEl = el('div', { class: 'stage-interim' });
    const log = el('div', { class: 'vlog' });
    const castEl = el('div', { class: 'cast' });
    const input = el('input', { type: 'text', placeholder: 'Type to a character, or press the mic and talk…  (say "Sage, …" to switch)', onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendText(); } } });
    const micBtn = el('button', { class: 'btn big mic-main', title: 'Talk (push to talk). Click again to stop.', onclick: () => pushToTalk() }, S.iconEl('mic'), el('span', {}, 'Talk'));
    const handsBtn = el('button', { class: 'btn', title: 'Hands-free: always listening. Your characters answer when you stop speaking.', onclick: () => setHandsFree(!st.handsFree) }, '🎧 Hands-free');
    const stopBtn = el('button', { class: 'btn', title: 'Stop talking and listening', onclick: () => stopAll() }, S.iconEl('stop'));
    const meterIn = el('i'), meterOut = el('i');

    const setStatus = (s) => {
      status = s;
      const label = { idle: 'Ready', listening: 'Listening…', hearing: 'Hearing you…', processing: 'Understanding…', thinking: 'Thinking…', speaking: 'Speaking' }[s] || s;
      stateEl.textContent = label; stateEl.dataset.s = s;
      face && face.setState(s === 'listening' || s === 'hearing' ? 'listening' : s === 'thinking' || s === 'processing' ? 'thinking' : s === 'speaking' ? 'speaking' : 'idle');
      micBtn.classList.toggle('on', s === 'listening' || s === 'hearing');
      handsBtn.classList.toggle('on', st.handsFree);
      canvas.parentElement && canvas.parentElement.style.setProperty('--glow', active().color);
    };

    function mountFace() {
      const p = active();
      if (face) face.destroy();
      face = Holo.createFace(canvas, p, { detail: 'high', fps: 60 });
      let inLvl = 0, outLvl = 0;
      face.levelIn = () => (ears ? ears.level() : 0);
      face.levelOut = () => (mouth ? mouth.level() : 0);
      const upd = () => { if (!canvas.isConnected) return; inLvl = face.levelIn(); outLvl = face.levelOut(); meterIn.style.width = Math.round(inLvl * 100) + '%'; meterOut.style.width = Math.round(outLvl * 100) + '%'; requestAnimationFrame(upd); };
      requestAnimationFrame(upd);
      nameEl.textContent = p.name; nameEl.style.color = p.color; tagEl.textContent = p.tagline || (p.auto ? 'A combo with a generated face' : '');
      setStatus(status);
    }

    function selectPersona(id) {
      if (st.activeId === id) return;
      stopSpeaking();
      st.activeId = id;
      mountFace(); renderCast();
    }

    function renderCast() {
      const card = (p) => el('button', { class: 'cast-card' + (p.id === st.activeId ? ' active' : ''), style: `--c:${p.color}`, onclick: () => selectPersona(p.id), title: p.auto ? `Generated face for the combo ${p.model}. Press Make persona to customise it.` : (p.tagline || p.name) },
        S.avatar(p, 44),
        el('div', { class: 'cast-t' }, el('b', {}, p.name), el('small', {}, p.auto ? 'combo · ' + p.model : p.tagline || S.personaModel(p) || p.role)),
        S.signBadge(p, 20));
      const list = [el('div', { class: 'cast-h' }, 'Characters'), ...personas.map(card)];
      const cs = combos();
      if (cs.length) list.push(el('div', { class: 'cast-h' }, 'Your combos'), ...cs.map((c) => card(comboPersona(c))));
      list.push(el('button', { class: 'btn', style: 'width:100%;justify-content:center;margin-top:8px', onclick: () => editPersona(null) }, S.iconEl('plus'), 'New character'));
      S.set(castEl, list);
    }

    /* ---- conversation ---- */
    const addLine = (who, text, p) => {
      const row = el('div', { class: 'vline ' + who }, who === 'you' ? el('span', { class: 'vwho' }, 'You') : S.avatar(p, 26), el('div', { class: 'vtext' }, text));
      const h = log.querySelector('.vhint'); if (h) h.remove();
      log.append(row); log.scrollTop = log.scrollHeight;
      return row.querySelector('.vtext');
    };

    function stopSpeaking() { if (mouth) { mouth.stop(); mouth = null; } if (ears) ears.pause(false); }
    function stopAll() {
      if (abort) abort.abort();
      stopSpeaking();
      if (ears) { ears.stop(); ears = null; }
      st.handsFree = false; busy = false; setStatus('idle'); handsBtn.classList.remove('on');
    }

    async function ask(text) {
      let p = active();
      const routed = VT.routeUtterance(text, all());
      if (routed.persona) {
        if (routed.persona.id !== p.id) { st.activeId = routed.persona.id; p = routed.persona; mountFace(); renderCast(); }
        text = routed.text;
        if (!text) { text = 'Hello'; }
      }
      const model = S.personaModel(p);
      addLine('you', text);
      if (!model) { S.toast('Pick a model for ' + p.name + ' (edit the character) or set a chat model in Settings.', true); setStatus('idle'); return; }
      st.history.push({ role: 'user', content: text, who: p.id });
      busy = true; setStatus('thinking');
      stopSpeaking();
      const textEl = addLine('bot', '…', p);
      const live = { text: '' };
      abort = new AbortController();
      mouthFeedLen = 0;
      let firstSpoken = false;
      mouth = S.mouth.create(p, {
        onStart: () => { firstSpoken = true; setStatus('speaking'); if (ears && !vcfg().interrupt) ears.pause(true); },
        onIdle: () => { if (busy) setStatus('thinking'); },
        onEnd: (cancelled) => { if (!cancelled) { mouth = null; if (ears) ears.pause(false); setStatus(ears ? 'listening' : 'idle'); } },
        onError: (m) => S.toast(m + ' Falling back is possible in Voice settings.', true),
      });
      const m = mouth;
      const system = S.personaSystem(p, 'You are speaking aloud with the user by voice. Answer in short, natural spoken sentences. No markdown, no lists, no emoji. If code is needed, put it in a code block and say only a short summary of it. Other characters in this room: ' + personas.filter((q) => q.id !== p.id).map((q) => q.name).join(', ') + '.');
      const messages = [{ role: 'system', content: system }, ...st.history.slice(-16).map((h) => ({ role: h.role, content: h.content }))];
      try {
        const r = await S.streamChat({
          model, messages, params: { temperature: 0.7 }, signal: abort.signal,
          onUpdate: (res) => { const ans = S.splitThink({ content: res.content, reasoning: res.reasoning }).answer; live.text = ans; textEl.innerHTML = S.md(ans || '…'); log.scrollTop = log.scrollHeight; m.feed(ans, false); },
        });
        const ans = S.splitThink({ content: r.content, reasoning: r.reasoning }).answer || r.content || '';
        live.text = ans; textEl.innerHTML = S.md(ans || '(empty reply)');
        st.history.push({ role: 'assistant', content: ans, who: p.id });
        busy = false;
        if (!ans) { setStatus(ears ? 'listening' : 'idle'); return; }
        m.feed(ans, true);
        if (!m.busy && !firstSpoken) { mouth = null; setStatus(ears ? 'listening' : 'idle'); }
      } catch (e) {
        busy = false;
        if (e.name !== 'AbortError') { textEl.textContent = e.message; textEl.parentElement.classList.add('err'); S.toast(e.message, true); }
        if (mouth === m) { m.stop(); mouth = null; }
        setStatus(ears ? 'listening' : 'idle');
      }
    }

    async function sendText() {
      const t = input.value.trim();
      if (!t) return;
      input.value = '';
      await ask(t);
    }

    function earOpts(once) {
      return {
        once,
        onInterim: (t) => { interimEl.textContent = t; },
        onFinal: (t) => { interimEl.textContent = ''; if (busy && abort) abort.abort(); ask(t); },
        onState: (s) => { if (s === 'idle') return; if (status === 'speaking' || status === 'thinking') return; setStatus(s); },
        onError: (m) => { S.toast(m, true); },
        onBargeIn: () => { if (mouth && mouth.busy) { mouth.stop(); mouth = null; if (ears) ears.pause(false); setStatus('listening'); } },
        onEnd: () => { if (once) { ears = null; interimEl.textContent = ''; if (!busy && !mouth) setStatus('idle'); } },
      };
    }

    async function pushToTalk() {
      if (ears && !st.handsFree) { ears.stop(); ears = null; return; }
      if (st.handsFree) return S.toast('Hands-free is on. Turn it off to use push to talk.');
      stopSpeaking(); if (abort) abort.abort();
      ears = await S.ears.listen(earOpts(true));
    }

    async function setHandsFree(on) {
      if (!on) { st.handsFree = false; if (ears) { ears.stop(); ears = null; } setStatus('idle'); handsBtn.classList.remove('on'); return; }
      if (ears) { ears.stop(); ears = null; }
      st.handsFree = true; handsBtn.classList.add('on');
      ears = await S.ears.listen(earOpts(false));
      if (!ears) st.handsFree = false;
      else S.toast('Listening. Just talk. Say a name first ("Clutch, …") to talk to someone else.');
    }

    /* ---- character editor ---- */
    async function editPersona(p, fromAuto) {
      const isNew = !p || fromAuto;
      const base = p ? JSON.parse(JSON.stringify(p)) : Holo.autoPersona('new character ' + Date.now());
      const d = { ...base, name: fromAuto ? p.name : isNew && !p ? '' : base.name, aliases: (base.aliases || []).join(', '), face: { ...base.face, extras: [...(base.face.extras || [])] }, voice: { ...base.voice } };
      if (isNew) delete d.id;
      const meta = S.personaMeta;
      const prev = el('canvas', { class: 'edit-canvas' });
      let pf = null;
      const redraw = () => { if (!pf) pf = Holo.createFace(prev, d, { detail: 'low', fps: 30, interactive: false }); else pf.setPersona(d); };
      const field = (label, node, hint) => el('label', { class: 'field' }, el('span', {}, label), node, hint ? el('small', { class: 'hint' }, hint) : null);
      const sel = (key, obj, list) => el('select', { onchange: (e) => { obj[key] = e.target.value; redraw(); } }, list.map((v) => el('option', { value: v, selected: obj[key] === v }, v)));
      const slider = (label, key, min, max, step, obj = d.face, after) => {
        const out = el('output', {}, String(obj[key]));
        const inp = el('input', { type: 'range', min, max, step, value: obj[key], oninput: () => { obj[key] = Number(inp.value); out.textContent = inp.value; redraw(); after && after(); } });
        return el('div', { class: 'range-row' }, el('span', {}, label), inp, out);
      };
      const nameIn = el('input', { type: 'text', value: d.name, maxlength: '24', placeholder: 'e.g. Nova', oninput: (e) => { d.name = e.target.value; } });
      const tagIn = el('input', { type: 'text', value: d.tagline || '', maxlength: '60', placeholder: 'Fast · Focused · Gets it done', oninput: (e) => { d.tagline = e.target.value; } });
      const color = el('input', { type: 'color', value: d.color, oninput: (e) => { d.color = e.target.value; redraw(); } });
      const signSel = el('select', { onchange: (e) => { d.sign = e.target.value; redraw(); } }, (meta.signs.length ? meta.signs : Holo.signNames).map((v) => el('option', { value: v, selected: d.sign === v }, v)));
      const roleSel = sel('role', d, meta.roles.length ? meta.roles : ['chat', 'reasoning', 'coding', 'video']);
      const modelSlot = el('span');
      modelSlot.append(S.modelSelect(d.model || '', (v) => { d.model = v; }, { allowEmpty: true, emptyLabel: '— use the model for its role —' }));
      const alias = el('input', { type: 'text', value: d.aliases, placeholder: 'kodex, codecs', oninput: (e) => { d.aliases = e.target.value; } });
      const sys = el('textarea', { rows: '3', placeholder: 'Optional extra personality for this character', oninput: (e) => { d.system = e.target.value; } }, d.system || '');
      const extras = el('div', { class: 'chips-row' }, (meta.extras.length ? meta.extras : ['headphones', 'scar', 'gem']).map((x) => el('label', { class: 'chip-check' }, el('input', { type: 'checkbox', checked: d.face.extras.includes(x), onchange: (e) => { d.face.extras = e.target.checked ? [...new Set([...d.face.extras, x])] : d.face.extras.filter((v) => v !== x); redraw(); } }), x)));
      const seedBtn = el('button', { class: 'btn sm', type: 'button', onclick: () => { d.face.seed = Math.floor(Math.random() * 1e5); redraw(); } }, '🎲 Surprise me');
      const vsel = el('select', { onchange: (e) => { d.voice.browserVoice = e.target.value; } }, [el('option', { value: '' }, 'Automatic (a different voice per character)'), ...S.browserVoices().map((v) => el('option', { value: v.name, selected: d.voice.browserVoice === v.name }, `${v.name} (${v.lang})`))]);
      const omniV = el('input', { type: 'text', list: 'omni-voices', value: d.voice.omniVoice || 'alloy', oninput: (e) => { d.voice.omniVoice = e.target.value; } });
      const dl = el('datalist', { id: 'omni-voices' }, ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((v) => el('option', { value: v })));
      const testBtn = el('button', { class: 'btn sm', type: 'button', onclick: () => {
        const tp = { ...d, id: d.id || 'preview', name: d.name || 'Preview' };
        const m = S.mouth.create(tp, { onError: (e) => S.toast(e, true), onEnd: () => {} });
        pf.setState('speaking'); pf.levelOut = () => m.level();
        m.say(`Hello, I am ${tp.name}. This is how I sound.`);
        const iv = setInterval(() => { if (!m.busy) { clearInterval(iv); pf.setState('idle'); } }, 300);
      } }, '🔊 Test voice');

      const body = el('div', { class: 'editor' },
        el('div', { class: 'editor-prev' }, prev, el('div', { class: 'row' }, seedBtn, testBtn)),
        el('div', { class: 'editor-form' },
          el('div', { class: 'two' }, field('Name', nameIn), field('Sign colour', color)),
          field('Tagline', tagIn),
          el('div', { class: 'two' }, field('Sign at the voice box', signSel), field('Role', roleSel)),
          field('Model or combo', modelSlot, 'Leave empty to use the model you set for this role.'),
          field('Other ways to say the name', alias, 'Comma separated. Helps the microphone catch the name ("kodex" for CODEX).'),
          el('div', { class: 'two' }, field('Horns', sel('horns', d.face, meta.horns.length ? meta.horns : ['none'])), field('Hair', sel('hair', d.face, meta.hair.length ? meta.hair : ['none']))),
          field('Eyes', sel('eyes', d.face, meta.eyes.length ? meta.eyes : ['sharp', 'calm', 'wide'])),
          el('div', { class: 'field' }, el('span', {}, 'Extras'), extras),
          slider('Head width', 'headW', 0.7, 0.9, 0.01), slider('Jaw', 'jaw', 0.12, 0.34, 0.01), slider('Cheeks', 'cheek', 0, 0.16, 0.01), slider('Brow', 'brow', 0, 0.12, 0.01), slider('Nose', 'nose', 0.08, 0.3, 0.01), slider('Lips', 'lips', 0.03, 0.11, 0.01), slider('Smile', 'smile', -0.5, 1, 0.05),
          field('Voice (browser engine)', vsel), field('Voice name (OmniRoute engine)', omniV), dl,
          slider('Pitch', 'pitch', 0.5, 2, 0.05, d.voice), slider('Speed', 'rate', 0.5, 2, 0.05, d.voice),
          field('Extra personality', sys)));
      setTimeout(redraw, 30);
      const actions = [{ label: 'Cancel', value: 'cancel' }];
      if (p && !isNew && !p.builtin) actions.unshift({ label: 'Delete', cls: 'danger', value: 'delete' });
      if (p && !isNew && p.builtin) actions.unshift({ label: 'Reset to original', value: 'reset' });
      actions.push({ label: isNew ? 'Create character' : 'Save', cls: 'primary', value: 'save' });
      const wide = S.$('#dialog'); wide.classList.add('wide');
      const choice = await S.dialog(isNew ? 'New character' : 'Edit ' + p.name, [body], actions);
      wide.classList.remove('wide');
      if (pf) { pf.destroy(); pf = null; }
      if (choice === 'save') {
        const payload = { name: d.name, tagline: d.tagline, color: d.color, sign: d.sign, role: d.role, model: d.model || '', aliases: d.aliases, system: d.system || '', face: d.face, voice: d.voice };
        try {
          const saved = isNew ? await S.api('POST', '/api/personas', payload) : await S.api('PATCH', '/api/personas/' + p.id, payload);
          await S.loadPersonas(); personas = S.personas.slice(); st.activeId = saved.id; mountFace(); renderCast(); S.toast(saved.name + ' saved');
        } catch (e) { S.toast(e.message, true); }
      } else if (choice === 'delete') {
        if (await S.confirm('Delete ' + p.name + '?', 'The character is removed. Chats are not affected.', 'Delete')) {
          try { await S.api('DELETE', '/api/personas/' + p.id); await S.loadPersonas(); personas = S.personas.slice(); st.activeId = personas[0].id; mountFace(); renderCast(); } catch (e) { S.toast(e.message, true); }
        }
      } else if (choice === 'reset') {
        try { await S.api('POST', `/api/personas/${p.id}/reset`, {}); await S.loadPersonas(); personas = S.personas.slice(); mountFace(); renderCast(); S.toast(p.name + ' is back to the original'); } catch (e) { S.toast(e.message, true); }
      }
    }

    /* ---- voice settings ---- */
    async function openSettings() {
      const v = JSON.parse(JSON.stringify(vcfg()));
      const eng = (obj, label, hint) => el('label', { class: 'field' }, el('span', {}, label),
        el('select', { onchange: (e) => { obj.engine = e.target.value; } }, [['browser', 'Browser (free, built in)'], ['omniroute', 'OmniRoute (your gateway)']].map(([val, t]) => el('option', { value: val, selected: obj.engine === val }, t))), el('small', { class: 'hint' }, hint));
      const txt = (label, obj, key, ph, hint) => el('label', { class: 'field' }, el('span', {}, label), el('input', { type: 'text', value: obj[key] || '', placeholder: ph, oninput: (e) => { obj[key] = e.target.value; } }), hint ? el('small', { class: 'hint' }, hint) : null);
      const body = [
        el('p', { class: 'hint', style: 'margin:0 0 10px' }, 'Ears turn your speech into text. Voices turn replies into speech. Both can use the browser for free, or OmniRoute if your gateway offers /audio/transcriptions and /audio/speech.'),
        eng(v.stt, 'Ears (speech to text)', S.ears.browserOk ? 'Chrome and Edge send audio to their speech service.' : 'This browser has no speech recognition. Use OmniRoute.'),
        txt('Language', v.stt, 'language', 'en-US', 'For example en-US, en-IN, hi-IN, es-ES.'),
        txt('Transcription model (OmniRoute)', v.stt, 'model', 'whisper-1'),
        eng(v.tts, 'Voices (text to speech)', 'Browser voices are free and different per character. OmniRoute voices sound more natural.'),
        txt('Speech model (OmniRoute)', v.tts, 'model', 'tts-1'),
        el('label', { class: 'switch', style: 'display:flex;margin:6px 0 12px' }, el('input', { type: 'checkbox', checked: v.interrupt, onchange: (e) => { v.interrupt = e.target.checked; } }), el('span', {}, 'Let me interrupt while a character is talking (use headphones, otherwise they hear themselves)')),
      ];
      const r = await S.dialog('Voice settings', body, [{ label: 'Cancel', value: false }, { label: 'Save', cls: 'primary', value: true }]);
      if (!r) return;
      try {
        S.config = { ...S.config, ...(await S.api('POST', '/api/config', { voice: v })) };
        S.toast('Voice settings saved');
        if (st.handsFree) setHandsFree(true);
      } catch (e) { S.toast(e.message, true); }
    }

    /* ---- layout ---- */
    const makeBtn = el('button', { class: 'btn sm', style: 'display:none', onclick: () => editPersona(active(), true) }, 'Make persona');
    const editBtn = el('button', { class: 'btn sm', onclick: () => { const p = active(); p.auto ? editPersona(p, true) : editPersona(p); } }, '✎ Edit character');
    const stage = el('div', { class: 'stage' },
      el('div', { class: 'stage-head' }, nameEl, tagEl, el('span', { style: 'flex:1' }), editBtn, makeBtn),
      el('div', { class: 'stage-canvas-wrap' }, canvas, el('div', { class: 'stage-hud' }, stateEl, interimEl)),
      el('div', { class: 'meters' }, el('div', { class: 'meter' }, el('span', {}, 'You'), el('b', {}, meterIn)), el('div', { class: 'meter out' }, el('span', {}, 'Voice'), el('b', {}, meterOut))));
    const talk = el('div', { class: 'talk' }, log,
      el('div', { class: 'talk-bar' }, micBtn, handsBtn, stopBtn, input, el('button', { class: 'btn primary', onclick: sendText }, S.iconEl('send'))));

    container.append(
      el('div', { class: 'topbar' }, el('h1', {}, 'Voice'), el('span', { class: 'sub' }, 'Talk to your characters. They hear you, and they talk back.'), el('span', { style: 'flex:1' }), el('button', { class: 'btn sm', onclick: openSettings }, S.iconEl('settings'), 'Voice settings')),
      el('div', { class: 'voice-wrap' }, castEl, el('div', { class: 'voice-main' }, stage, talk)));

    const tick = setInterval(() => { makeBtn.style.display = active().auto ? '' : 'none'; }, 400);
    renderCast(); mountFace();
    if (!st.history.length) log.append(el('div', { class: 'vhint' }, `Press Talk, or turn on Hands-free and just speak. Start with a name — "Sage, what should I build first?" — to talk to a specific character. ${vcfg().stt.engine === 'browser' && !S.ears.browserOk ? 'This browser has no speech recognition, so open Voice settings and switch Ears to OmniRoute.' : ''}`));
    else st.history.forEach((h) => { if (h.role === 'user') addLine('you', h.content); else addLine('bot', '', all().find((q) => q.id === h.who) || active()).innerHTML = S.md(h.content); });
    S.loadPersonas().then(() => { personas = S.personas.slice(); if (!personas.some((p) => p.id === st.activeId) && !combos().some((c) => comboPersona(c).id === st.activeId)) st.activeId = personas[0] ? personas[0].id : st.activeId; mountFace(); renderCast(); });

    return () => { clearInterval(tick); stopAll(); if (face) face.destroy(); };
  };
})();
