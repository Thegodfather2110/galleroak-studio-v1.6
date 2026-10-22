'use strict';
/* App Chatbot: connect your own apps to OmniRoute as a support chatbot (Hindi, Hinglish, English).
   Tabs: Apps (connectors) / Test chat / Activity / Settings. The server side is lib/gateway.js. */
(function () {
  const { el } = S;
  const LANGS = [['auto', 'Auto (match the customer)'], ['en', 'English'], ['hi', 'Hindi (देवनागरी)'], ['hinglish', 'Hinglish (Roman Hindi)']];
  const TONES = [['friendly', 'Friendly'], ['formal', 'Formal'], ['casual', 'Casual']];
  const LANG_SHORT = { en: 'English', hi: 'Hindi', hinglish: 'Hinglish' };
  const SAMPLES = [
    ['English', 'Hi, where is my order? It was supposed to arrive yesterday.'],
    ['Hinglish', 'Mera order abhi tak nahi aaya, kab tak milega?'],
    ['हिंदी', 'मेरा ऑर्डर अभी तक नहीं आया, कृपया बताइए कब तक मिलेगा?'],
    ['Human', 'Mujhe kisi insaan se baat karni hai, manager se baat karwao'],
  ];

  const wide = (title, nodes, actions) => {
    const d = S.$('#dialog');
    d.classList.add('wide');
    const p = S.dialog(title, nodes, actions);
    p.then(() => d.classList.remove('wide'));
    return p;
  };
  const field = (label, input, hint) => el('label', { class: 'field' }, el('span', {}, label), input, hint ? el('div', { class: 'hint' }, hint) : null);
  const select = (opts, value, onChange) => {
    const s = el('select', {}, opts.map(([v, l]) => el('option', { value: v }, l)));
    s.value = value;
    if (onChange) s.addEventListener('change', () => onChange(s.value));
    return s;
  };
  const when = (ts) => (ts ? S.ago(ts) : 'never');
  const dot = (status) => el('span', { class: 'gw-dot ' + status, title: status });
  const code = (text) => el('pre', { class: 'gw-code' }, text);

  function snippets(base, id, key) {
    const k = key || 'YOUR_API_KEY';
    const url = `${base}/c/${id}/v1`;
    return {
      curl: `curl ${url}/chat/completions \\\n  -H "Authorization: Bearer ${k}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"messages":[{"role":"user","content":"Mera order kab aayega?"}]}'`,
      python: `from openai import OpenAI\n\nclient = OpenAI(base_url="${url}", api_key="${k}")\nr = client.chat.completions.create(\n    model="support-bot",\n    messages=[{"role": "user", "content": "Mera order kab aayega?"}],\n)\nprint(r.choices[0].message.content)\nprint(r.omni)  # {"language": "hinglish", "handoff": False}`,
      js: `const r = await fetch("${url}/chat/completions", {\n  method: "POST",\n  headers: { "Authorization": "Bearer ${k}", "Content-Type": "application/json" },\n  body: JSON.stringify({ messages: [{ role: "user", content: "मेरा ऑर्डर कहाँ है?" }] }),\n});\nconst data = await r.json();\nconsole.log(data.choices[0].message.content, data.omni);`,
    };
  }

  S.views.gateway = (container) => {
    let tab = S.pref.get('gw.tab', 'apps');
    let snap = null;
    let personas = [];
    const body = el('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto' });
    const chat = { id: S.pref.get('gw.test', ''), msgs: [], busy: false };

    async function load() {
      try {
        snap = await S.api('GET', '/api/gateway');
        try { personas = (await S.api('GET', '/api/personas')).personas || []; } catch {}
      } catch (e) { S.toast(e.message, true); }
      draw();
    }
    const go = (t) => { tab = t; S.pref.set('gw.tab', t); if (t === 'activity') drawActivity(); else draw(); };
    const base = () => (snap.status.addresses[0] || `http://YOUR-PC-IP:${snap.status.port}`);

    function tabs() {
      const t = (id, label) => el('button', { class: 'tab' + (tab === id ? ' active' : ''), onclick: () => go(id) }, label);
      return el('div', { class: 'tabs' }, t('apps', `Apps (${snap.connectors.length})`), t('test', 'Test chat'), t('activity', 'Activity'), t('settings', 'Settings'), el('span', { class: 'spacer' }),
        el('span', { class: 'gw-state' }, dot(snap.status.running ? 'connected' : 'revoked'), snap.status.running ? `Listening on port ${snap.status.port}` : 'Gateway is off'));
    }

    function draw() {
      if (!snap) return;
      body.replaceChildren(tabs(), tab === 'apps' ? apps() : tab === 'test' ? test() : tab === 'settings' ? settings() : el('div', { class: 'pad' }, 'Loading…'));
      if (tab === 'activity') drawActivity();
    }

    /* ------------------------------ apps ------------------------------ */
    function apps() {
      const wrap = el('div', { class: 'pad' });
      if (!snap.status.running) {
        wrap.append(el('div', { class: 'card gw-off' }, el('h2', {}, 'The gateway is switched off'),
          el('p', { class: 'desc' }, 'Your apps cannot connect until you turn it on. It listens on your WiFi/LAN only; GallerOak Studio itself stays private on this computer.'),
          el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => saveCfg({ enabled: true }) }, 'Turn on the gateway'), snap.status.error ? el('span', { style: 'color:var(--bad)' }, snap.status.error) : null)));
      } else if (snap.status.addresses.length) {
        wrap.append(el('p', { class: 'desc' }, 'Your apps connect to: ', ...snap.status.addresses.flatMap((a) => [el('code', {}, a), ' '])));
      }
      const s = snap.stats;
      wrap.append(el('div', { class: 'gw-stats' },
        el('div', {}, el('b', {}, String(s.chats24h)), el('span', {}, 'chats in 24 h')),
        el('div', {}, el('b', {}, String(s.handoffs24h)), el('span', {}, 'asked for a human')),
        el('div', {}, el('b', {}, String(s.alerts24h)), el('span', {}, 'warnings')),
        el('div', {}, el('b', {}, String(snap.banned.length)), el('span', {}, 'blocked addresses'))));
      wrap.append(el('div', { class: 'row', style: 'margin:12px 0' }, el('button', { class: 'btn primary', onclick: newApp }, '+ Connect a new app')));
      if (!snap.connectors.length) wrap.append(el('div', { class: 'card' }, el('h2', {}, 'No apps yet'), el('p', { class: 'desc' }, 'Create one connector per app (your shop app, your website, a WhatsApp bot). Each gets its own URL and secret key, so you can switch one off without touching the others.')));
      for (const c of snap.connectors) wrap.append(appCard(c));
      return wrap;
    }

    function appCard(c) {
      const s = c.settings;
      return el('div', { class: 'card gw-app' },
        el('div', { class: 'row' }, dot(c.status), el('h2', { style: 'margin:0;flex:1' }, c.name), el('span', { class: 'pill-s' }, LANGS.find((l) => l[0] === s.language)[1].split(' (')[0]),
          s.publicChat ? el('span', { class: 'pill-s' }, 'Chat page on') : null),
        el('p', { class: 'desc', style: 'margin:6px 0 10px' }, `${c.status === 'revoked' ? 'Revoked' : c.status === 'connected' ? 'Connected' : 'Idle'} · key ${c.hint} · ${c.requests} requests · last seen ${when(c.last_seen)}${c.last_ip ? ' from ' + c.last_ip : ''}`),
        el('div', { class: 'row' },
          el('button', { class: 'btn sm primary', onclick: () => details(c) }, 'Connection details'),
          el('button', { class: 'btn sm', onclick: () => { chat.id = c.id; chat.msgs = []; S.pref.set('gw.test', c.id); go('test'); } }, 'Test'),
          el('button', { class: 'btn sm', onclick: () => editApp(c) }, 'Settings'),
          c.revoked ? el('button', { class: 'btn sm', onclick: () => act(c, 'restore') }, 'Restore') : el('button', { class: 'btn sm', onclick: () => act(c, 'revoke') }, 'Revoke'),
          el('button', { class: 'btn sm', onclick: () => rotateKey(c) }, 'New key'),
          el('button', { class: 'btn sm danger', onclick: () => delApp(c) }, 'Delete')));
    }

    async function act(c, what) {
      try { await S.api('POST', `/api/gateway/connectors/${c.id}/${what}`, {}); S.toast(what === 'revoke' ? 'Revoked: that app can no longer connect' : 'Restored'); } catch (e) { S.toast(e.message, true); }
      load();
    }

    async function delApp(c) {
      if (!(await S.confirm('Delete this app?', `"${c.name}" will stop working immediately and its key cannot be recovered.`, 'Delete'))) return;
      try { await S.api('DELETE', `/api/gateway/connectors/${c.id}`); } catch (e) { S.toast(e.message, true); }
      load();
    }

    async function rotateKey(c) {
      if (!(await S.confirm('Issue a new key?', `The old key for "${c.name}" stops working right away. Update the app with the new one.`, 'Issue new key'))) return;
      try { const r = await S.api('POST', `/api/gateway/connectors/${c.id}/rotate`, {}); await load(); details(r.connector, r.key); } catch (e) { S.toast(e.message, true); }
    }

    async function newApp() {
      const name = el('input', { type: 'text', placeholder: 'e.g. Shop app, Website chat, WhatsApp bot', maxlength: 60 });
      const biz = el('input', { type: 'text', placeholder: 'Business name the bot speaks for (optional)', maxlength: 120 });
      const r = await S.dialog('Connect a new app', [field('App name', name), field('Business name', biz, 'The bot introduces itself as support for this business. You can change everything later.')],
        [{ label: 'Cancel', value: null }, { label: 'Create', cls: 'primary', value: () => ({ name: name.value, business: biz.value }) }]);
      if (!r || !r.name.trim()) return;
      try {
        const out = await S.api('POST', '/api/gateway/connectors', { name: r.name, settings: { business: r.business } });
        await load();
        details(out.connector, out.key);
      } catch (e) { S.toast(e.message, true); }
    }

    function details(c, key) {
      const sn = snippets(base(), c.id, key);
      let which = 'curl';
      const codeBox = el('div');
      const showCode = () => codeBox.replaceChildren(code(sn[which]), el('button', { class: 'btn sm', onclick: () => S.copy(sn[which]) }, 'Copy'));
      const tabsRow = el('div', { class: 'pills' }, ...[['curl', 'curl'], ['python', 'Python'], ['js', 'JavaScript']].map(([id, label]) => el('button', { onclick: () => { which = id; showCode(); } }, label)));
      showCode();
      const nodes = [
        field('Connector URL (paste this in your app)', el('div', { class: 'row' }, el('input', { type: 'text', readonly: true, value: `${base()}/c/${c.id}/v1`, style: 'flex:1' }), el('button', { class: 'btn sm', onclick: () => S.copy(`${base()}/c/${c.id}/v1`) }, 'Copy'))),
      ];
      if (key) nodes.push(el('div', { class: 'gw-key' }, el('b', {}, 'Your secret key (shown only once)'), el('div', { class: 'row' }, el('input', { type: 'text', readonly: true, value: key, style: 'flex:1' }), el('button', { class: 'btn sm primary', onclick: () => S.copy(key, 'Key copied') }, 'Copy')),
        el('div', { class: 'hint' }, 'Save it now. GallerOak Studio only keeps a fingerprint, so if you lose it, issue a new key.')));
      else nodes.push(el('p', { class: 'hint' }, `Key ${c.hint}. The full key is not stored. Use "New key" if you lost it.`));
      if (c.settings.publicChat) {
        const u = `${base()}/c/${c.id}/chat`;
        nodes.push(field('Ready-made chat page (no key needed, local network only)', el('div', { class: 'row' }, el('input', { type: 'text', readonly: true, value: u, style: 'flex:1' }), el('button', { class: 'btn sm', onclick: () => S.copy(u) }, 'Copy'))));
      }
      nodes.push(el('h4', { style: 'margin:14px 0 6px' }, 'Example code'), tabsRow, codeBox,
        el('p', { class: 'hint' }, 'It is OpenAI-compatible: any OpenAI SDK works with this URL and key. Replies carry the language in the "omni" field and the X-Language / X-Handoff headers. Add "stream": true for live text.'));
      if (!snap.status.running) nodes.unshift(el('p', { style: 'color:var(--bad)' }, 'The gateway is off right now. Turn it on in the Apps tab or Settings.'));
      return wide(c.name, nodes, [{ label: 'Done', cls: 'primary', value: true }]).then((v) => { load(); return v; });
    }

    async function editApp(c) {
      const s = c.settings;
      const f = {
        language: select(LANGS, s.language), tone: select(TONES, s.tone),
        business: el('input', { type: 'text', value: s.business, maxlength: 120 }),
        about: el('textarea', { rows: 8, placeholder: 'Opening hours, delivery times, return policy, prices, FAQs. The bot answers only from this.' }, s.about),
        handoff: el('input', { type: 'text', value: s.handoff, placeholder: 'Leave empty to use the default in the customer\'s language', maxlength: 400 }),
        greeting: el('input', { type: 'text', value: s.greeting, placeholder: 'Leave empty for the default greeting', maxlength: 300 }),
        model: S.modelSelect(s.model, () => {}, { allowEmpty: true, emptyLabel: '— use the gateway default —' }),
        persona: select([['', '— none —'], ...personas.map((p) => [p.id, p.name])], s.personaId),
        max: el('input', { type: 'number', min: 50, max: 2000, value: s.maxTokens }),
        pub: el('input', { type: 'checkbox', checked: s.publicChat }),
        origins: el('input', { type: 'text', value: s.allowedOrigins, placeholder: 'https://myshop.example (space separated, or * for any)' }),
      };
      const r = await wide('Settings: ' + c.name, [
        el('div', { class: 'grid2' }, field('Language', f.language, 'Auto answers in whatever the customer writes: Hindi, Hinglish or English.'), field('Tone', f.tone)),
        field('Business name', f.business),
        field('What the bot knows about your business', f.about, 'Up to 6000 characters.'),
        field('Hand-off message', f.handoff, 'Said when the customer wants a human or the bot cannot help.'),
        field('Greeting (chat page)', f.greeting),
        el('div', { class: 'grid2' }, field('Model or combo', f.model), field('Persona voice (optional)', f.persona)),
        el('div', { class: 'grid2' }, field('Max reply length (tokens)', f.max), field('Allowed websites (CORS)', f.origins, 'Only needed when a website calls the connector from the browser.')),
        el('label', { class: 'check' }, f.pub, ' Turn on the ready-made chat page (no key, local network only, stricter limits)'),
      ], [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: () => ({
        language: f.language.value, tone: f.tone.value, business: f.business.value, about: f.about.value, handoff: f.handoff.value, greeting: f.greeting.value,
        model: f.model.value, personaId: f.persona.value, maxTokens: Number(f.max.value), publicChat: f.pub.checked, allowedOrigins: f.origins.value }) }]);
      if (!r) return;
      try { await S.api('PATCH', `/api/gateway/connectors/${c.id}`, { settings: r }); S.toast('Saved'); } catch (e) { S.toast(e.message, true); }
      load();
    }

    /* ------------------------------ test chat ------------------------------ */
    function test() {
      const wrap = el('div', { class: 'pad gw-test' });
      if (!snap.connectors.length) return el('div', { class: 'pad' }, el('div', { class: 'card' }, el('h2', {}, 'Create an app first'), el('p', { class: 'desc' }, 'The test chat talks to a connector exactly like your real app would, using its settings and knowledge.')));
      if (!snap.connectors.some((c) => c.id === chat.id)) chat.id = snap.connectors[0].id;
      const sel = select(snap.connectors.map((c) => [c.id, c.name]), chat.id, (v) => { chat.id = v; chat.msgs = []; S.pref.set('gw.test', v); draw(); });
      const log = el('div', { class: 'gw-log' });
      const input = el('textarea', { rows: 2, placeholder: 'Type as a customer: Hindi, Hinglish or English…' });
      const draw1 = () => {
        log.replaceChildren(...chat.msgs.map((m) => el('div', { class: 'gw-msg ' + m.role }, m.content, m.meta ? el('div', { class: 'gw-meta' }, m.meta) : null)));
        log.scrollTop = log.scrollHeight;
      };
      const send = async (text) => {
        text = (text || input.value).trim();
        if (!text || chat.busy) return;
        input.value = '';
        chat.msgs.push({ role: 'user', content: text });
        chat.busy = true; draw1();
        try {
          const r = await S.api('POST', `/api/gateway/connectors/${chat.id}/test`, { messages: chat.msgs.map((m) => ({ role: m.role, content: m.content })) });
          chat.msgs.push({ role: 'assistant', content: r.reply || '(empty reply)', meta: `${LANG_SHORT[r.language] || r.language} · ${r.model}${r.handoff ? ' · 🙋 human requested' : ''}` });
        } catch (e) { chat.msgs.push({ role: 'assistant', content: e.message, meta: 'error' }); }
        chat.busy = false; draw1(); input.focus();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      wrap.append(el('div', { class: 'row' }, field('Connector', sel), el('button', { class: 'btn sm', onclick: () => { chat.msgs = []; draw1(); } }, 'Clear')),
        el('div', { class: 'pills', style: 'margin-bottom:8px' }, ...SAMPLES.map(([l, t]) => el('button', { title: t, onclick: () => send(t) }, l))),
        log, el('div', { class: 'row', style: 'align-items:flex-end' }, input, el('button', { class: 'btn primary', onclick: () => send() }, 'Send')),
        el('p', { class: 'hint' }, 'This test uses the same pipeline as a real request, so it uses model credits. It does not count as a connected app.'));
      draw1();
      return wrap;
    }

    /* ------------------------------ activity ------------------------------ */
    let level = '';
    async function drawActivity() {
      const wrap = el('div', { class: 'pad' }, 'Loading…');
      body.replaceChildren(tabs(), wrap);
      let evs = [];
      try { evs = (await S.api('GET', '/api/gateway/events?limit=300' + (level ? '&level=' + level : ''))).events; snap = await S.api('GET', '/api/gateway'); } catch (e) { S.toast(e.message, true); }
      const names = Object.fromEntries(snap.connectors.map((c) => [c.id, c.name]));
      wrap.replaceChildren();
      wrap.append(el('div', { class: 'row', style: 'margin-bottom:10px' }, select([['', 'All events'], ['alert', 'Alerts'], ['warn', 'Warnings'], ['error', 'Errors'], ['info', 'Info']], level, (v) => { level = v; drawActivity(); }),
        el('button', { class: 'btn sm', onclick: drawActivity }, 'Refresh'), el('span', { class: 'spacer' }),
        el('button', { class: 'btn sm danger', onclick: async () => { if (await S.confirm('Clear the activity log?', 'This removes all events.', 'Clear')) { await S.api('DELETE', '/api/gateway/events'); drawActivity(); } } }, 'Clear')));
      if (snap.banned.length) wrap.append(el('div', { class: 'card', style: 'margin-bottom:12px' }, el('h2', {}, 'Blocked addresses'),
        ...snap.banned.map((b) => el('div', { class: 'row' }, el('code', {}, b.ip), el('span', { class: 'hint', style: 'margin:0' }, 'until ' + new Date(b.until).toLocaleTimeString()), el('button', { class: 'btn sm', onclick: async () => { await S.api('POST', '/api/gateway/unban', { ip: b.ip }); drawActivity(); } }, 'Unblock')))));
      wrap.append(el('p', { class: 'hint' }, 'Only metadata is logged. Customer messages and replies are never stored here.'));
      if (!evs.length) { wrap.append(el('p', { class: 'desc' }, 'Nothing yet.')); return; }
      wrap.append(el('div', { class: 'gw-events' }, ...evs.map((e) => el('div', { class: 'gw-ev ' + e.level },
        el('span', { class: 'gw-t' }, new Date(e.t).toLocaleString()), el('span', { class: 'gw-k' }, e.kind), el('span', { class: 'gw-d' }, e.detail + (e.connector && names[e.connector] ? ` (${names[e.connector]})` : '') + (e.ip ? ` · ${e.ip}` : ''))))));
    }

    /* ------------------------------ settings ------------------------------ */
    async function saveCfg(patch) {
      try { await S.api('POST', '/api/gateway/config', patch); S.toast('Saved'); } catch (e) { S.toast(e.message, true); }
      load();
    }

    function settings() {
      const c = snap.config;
      const en = el('input', { type: 'checkbox', checked: c.enabled });
      const port = el('input', { type: 'number', min: 1024, max: 65535, value: c.port });
      const nonLan = el('input', { type: 'checkbox', checked: c.allowNonLan });
      const rl = el('input', { type: 'number', min: 1, max: 1000, value: c.rateLimit });
      const prl = el('input', { type: 'number', min: 1, max: 1000, value: c.publicRateLimit });
      const model = S.modelSelect(c.model, () => {}, { allowEmpty: true, emptyLabel: '— use the Chat model from Settings —' });
      const up = el('div', { class: 'hint' }, '');
      const check = async () => { up.textContent = 'Checking…'; const r = await S.api('GET', '/api/gateway/upstream'); up.style.color = r.ok ? 'var(--ok)' : 'var(--bad)'; up.textContent = r.ok ? 'OmniRoute is reachable.' : 'OmniRoute problem: ' + r.error; };
      return el('div', { class: 'pad' },
        el('div', { class: 'card' }, el('h2', {}, 'Gateway'), el('p', { class: 'desc' }, 'A separate listener for your apps. GallerOak Studio itself stays on this computer only.'),
          el('label', { class: 'check' }, en, ' Gateway on (starts with GallerOak Studio)'),
          el('div', { class: 'grid2' }, field('Port', port), field('Default model or combo', model)),
          el('div', { class: 'grid2' }, field('Requests per minute (per app)', rl), field('Requests per minute (chat page, per visitor)', prl)),
          el('label', { class: 'check' }, nonLan, ' Also accept connections from outside my local network'),
          nonLan.checked ? el('p', { class: 'hint', style: 'color:var(--bad)' }, 'Only turn this on behind a firewall or a secure tunnel. Anyone who reaches the port can try keys.') : el('p', { class: 'hint' }, 'Recommended off: only phones and PCs on your WiFi/LAN can connect.'),
          el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => saveCfg({ enabled: en.checked, port: Number(port.value), allowNonLan: nonLan.checked, rateLimit: Number(rl.value), publicRateLimit: Number(prl.value), model: model.value }) }, 'Save and apply'),
            el('button', { class: 'btn', onclick: check }, 'Check OmniRoute'), up)),
        el('div', { class: 'card', style: 'margin-top:14px' }, el('h2', {}, 'Security built in'),
          el('p', { class: 'desc', style: 'margin:0' }, 'Keys are stored as fingerprints and shown once. Wrong keys get the same answer as unknown apps. Five failed attempts block an address for 15 minutes. Requests are size-limited and rate-limited. Apps cannot change the model, tools or instructions. Customer messages are never logged.')));
    }

    container.append(el('div', { class: 'topbar' }, el('h1', {}, 'App Chatbot'), el('span', { class: 'sub' }, 'Connect your apps over WiFi as a support chatbot in Hindi, Hinglish and English')), body);
    if (!S.modelsLoaded) S.loadModels().then(() => { if (snap) draw(); });
    load();
  };
})();
