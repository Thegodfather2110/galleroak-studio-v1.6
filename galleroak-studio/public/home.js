'use strict';
/* Home: the GallerOak command center. An oak-tree map of every tool converging on one hub,
   live status tiles, the full gallery of tools, and recent chats. Read-only: it only calls existing GET endpoints. */
(function () {
  const { el } = S;

  const SECTIONS = [
    ['Talk', [
      ['voice', 'Voice', 'Talk with animated characters, each with its own model and voice.'],
      ['chat', 'Chat', 'Everyday conversation with any model or combo from your gateway.'],
      ['reasoning', 'Reasoning', 'Slower, careful thinking with the reasoning shown.'],
      ['coding', 'Coding', 'Write, explain and review code with a coding model.'],
    ]],
    ['Create', [
      ['builder', 'Websites', 'Generate complete websites and keep them as named projects.'],
      ['apps', 'Apps', 'Build working apps, previewed and stored on this computer.'],
      ['rea', 'REA', 'Reverse-engineer any GitHub project through an MCP server.'],
      ['video', 'Video', 'Generate video clips from a prompt through your gateway.'],
      ['comfy', 'ComfyUI', 'Image and video generation with your local ComfyUI workflows.'],
    ]],
    ['Work', [
      ['agent', 'Computer', 'A computer for models: files, shell and web search in a workspace.'],
      ['team', 'Team', 'Several models share one project and take the tasks they do best.'],
      ['connectors', 'Connectors', 'Plug in MCP servers so models can use your tools.'],
      ['gateway', 'App Chatbot', 'A support chatbot for your apps in Hindi, Hinglish and English.'],
    ]],
    ['Compare & teach', [
      ['arena', 'Arena', 'Race models side by side on one prompt and compare the results.'],
      ['skills', 'Skills', 'Teach models with .md skill files per model or combo.'],
      ['settings', 'Settings', 'Connection, defaults, search, voice, appearance and data.'],
    ]],
  ];

  /* Eight tools on the oak's crown. Order is clockwise from the top. */
  const ORBIT = [
    ['reasoning', 'Reasoning'], ['chat', 'Chat'], ['coding', 'Coding'], ['builder', 'Websites'],
    ['video', 'Video'], ['voice', 'Voice'], ['agent', 'Computer'], ['connectors', 'Connectors'],
  ];

  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}, ...kids) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
    for (const k of kids.flat()) if (k) n.append(k.nodeType ? k : document.createTextNode(k));
    return n;
  };
  const motionOk = () => !matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.motion !== 'reduced';

  /** The interactive map: branches grow from the hub to each tool; small packets travel along them. */
  function constellation() {
    const C = 260, ORB = 168, NR = 31;
    const wrap = el('div', { class: 'hc-map', role: 'group', 'aria-label': 'Map of GallerOak tools' });
    const root = svg('svg', { viewBox: '0 0 520 520', class: 'hc-svg', 'aria-hidden': null });
    const defs = svg('defs', {},
      svg('radialGradient', { id: 'hcGlow', cx: '50%', cy: '50%', r: '50%' },
        svg('stop', { offset: '0%', 'stop-color': 'currentColor', 'stop-opacity': '.16' }),
        svg('stop', { offset: '100%', 'stop-color': 'currentColor', 'stop-opacity': '0' })));
    root.append(defs, svg('circle', { cx: C, cy: C, r: 250, fill: 'url(#hcGlow)' }));
    root.append(svg('circle', { cx: C, cy: C, r: 236, class: 'hc-ring' }));
    const spin = svg('g', { class: 'hc-spin' }, svg('circle', { cx: C, cy: C, r: ORB, class: 'hc-orbit' }));
    root.append(spin);

    const pts = ORBIT.map(([route, label], i) => {
      const a = (-90 + i * 45) * Math.PI / 180;
      return { route, label, i, a, x: C + ORB * Math.cos(a), y: C + ORB * Math.sin(a) };
    });
    const branches = svg('g', { class: 'hc-branches' });
    const packets = svg('g', { class: 'hc-packets' });
    pts.forEach((p) => {
      // end the branch at the node's rim; bow it sideways a little so it reads as a limb, not a spoke
      const rim = [C + (ORB - NR) * Math.cos(p.a), C + (ORB - NR) * Math.sin(p.a)];
      const start = [C + 30 * Math.cos(p.a), C + 30 * Math.sin(p.a)];
      const bow = 22 * (p.i % 2 ? 1 : -1);
      const mx = (start[0] + rim[0]) / 2 + bow * Math.cos(p.a + Math.PI / 2);
      const my = (start[1] + rim[1]) / 2 + bow * Math.sin(p.a + Math.PI / 2);
      const d = `M${start[0].toFixed(1)} ${start[1].toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${rim[0].toFixed(1)} ${rim[1].toFixed(1)}`;
      p.d = d;
      branches.append(svg('path', { d, class: 'hc-branch', 'data-route': p.route, style: `--d:${0.25 + p.i * 0.07}s` }));
    });
    root.append(branches);

    if (motionOk()) {
      pts.forEach((p) => {
        const begin = `${1.1 + p.i * 0.37}s`;
        const dot = svg('circle', { r: 2.2, class: 'hc-packet', visibility: 'hidden' },
          svg('set', { attributeName: 'visibility', to: 'visible', begin }),    // hidden until it starts moving, so nothing sits at the origin
          svg('animateMotion', { dur: `${3.2 + (p.i % 3) * 0.9}s`, begin, repeatCount: 'indefinite', path: p.d, keyPoints: p.i % 2 ? '0;1' : '1;0', keyTimes: '0;1', calcMode: 'linear' }));
        packets.append(dot);
      });
      root.append(packets);
    }

    const nodes = svg('g', { class: 'hc-nodes' });
    pts.forEach((p) => {
      const g = svg('g', { class: 'hc-node', tabindex: '0', role: 'link', 'aria-label': 'Open ' + p.label, 'data-route': p.route, style: `--d:${0.55 + p.i * 0.07}s`, transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})` });
      const inner = svg('g', { class: 'hc-node-in' });
      inner.append(svg('circle', { r: NR, class: 'hc-disc' }));
      // icon, scaled from the 24px icon set
      const ico = svg('g', { class: 'hc-ico', transform: 'translate(-12 -12)' });
      ico.innerHTML = (S.icon(p.route === 'voice' ? 'voice' : p.route) || '').replace(/^<svg[^>]*>|<\/svg>$/g, '');
      inner.append(ico);
      const up = Math.sin(p.a) < -0.2;                 // upper half: label sits above the node, otherwise below
      inner.append(svg('text', { class: 'hc-label', y: up ? -NR - 12 : NR + 20, 'text-anchor': 'middle' }, p.label));
      g.append(inner);
      const go = () => S.go(p.route);
      g.addEventListener('click', go);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      const light = (on) => { const b = branches.querySelector(`[data-route="${p.route}"]`); if (b) b.classList.toggle('lit', on); };
      g.addEventListener('pointerenter', () => light(true)); g.addEventListener('pointerleave', () => light(false));
      g.addEventListener('focus', () => light(true)); g.addEventListener('blur', () => light(false));
      nodes.append(g);
    });
    root.append(nodes);

    // the hub: a diamond with a four-point star, the "central intelligence"
    const hub = svg('g', { class: 'hc-hub', transform: `translate(${C} ${C})` });
    hub.append(svg('path', { class: 'hc-hub-pulse', d: 'M0 -40 L40 0 L0 40 L-40 0 Z' }),
      svg('path', { class: 'hc-hub-d', d: 'M0 -32 L32 0 L0 32 L-32 0 Z' }),
      svg('path', { class: 'hc-hub-star', d: 'M0 -17 Q3 -3 17 0 Q3 3 0 17 Q-3 3 -17 0 Q-3 -3 0 -17 Z' }));
    root.append(hub);
    wrap.append(root);
    return wrap;
  }

  const tile = (label, value, sub, extra) => el('div', { class: 'ht' }, el('span', { class: 'ht-l' }, label), el('b', { class: 'ht-v' }, value), el('span', { class: 'ht-s' }, sub || ''), extra || null);

  S.views.home = (container) => {
    const stats = el('div', { class: 'ht-grid' });
    const recent = el('div', { class: 'hr-list' });
    let gone = false;

    const hero = el('section', { class: 'hero' },
      el('div', { class: 'hero-copy' },
        el('div', { class: 'eyebrow' }, 'Gallery of AI tools'),
        el('h1', {}, 'One workspace for every model, agent and creative tool you own.'),
        el('p', {}, 'Branches reach out to chat, code, media, voice and your apps. Everything converges here, and everything it makes stays on this computer.'),
        el('div', { class: 'row hero-cta' },
          el('button', { class: 'btn primary big', onclick: () => S.go('chat') }, S.iconEl('chat'), 'Start a chat'),
          el('button', { class: 'btn big', onclick: () => S.go('voice') }, S.iconEl('voice'), 'Talk to a character'),
          el('button', { class: 'btn big ghost', onclick: () => S.go('builder') }, S.iconEl('builder'), 'Build a website'))),
      constellation());

    const gallery = el('div', { class: 'gal' }, SECTIONS.map(([title, items]) =>
      el('section', { class: 'gal-sec' },
        el('h2', { class: 'sec-h' }, title),
        el('div', { class: 'gal-grid' }, items.map(([route, name, desc], i) =>
          el('button', { class: 'gcard', style: `--i:${i}`, onclick: () => S.go(route) },
            el('span', { class: 'gcard-ico' }, S.iconEl(route)),
            el('span', { class: 'gcard-t' }, el('b', {}, name), el('small', {}, desc)),
            el('span', { class: 'gcard-go', 'aria-hidden': 'true', html: S.icon('arrow') })))))));

    container.append(
      el('div', { class: 'page home' },
        hero,
        el('section', { class: 'home-sec' }, el('h2', { class: 'sec-h' }, 'Status'), stats),
        el('section', { class: 'home-sec' }, el('h2', { class: 'sec-h' }, 'Recent chats'), recent),
        el('section', { class: 'home-sec home-gallery' }, el('h2', { class: 'sec-h big' }, 'The gallery'), gallery)));

    /* ---- status tiles (skeletons first, then real numbers) ---- */
    const skeleton = () => S.set(stats, [0, 1, 2, 3, 4].map(() => el('div', { class: 'ht skel' }, el('i', {}), el('i', {}), el('i', {}))));
    skeleton();
    S.set(recent, [0, 1, 2].map(() => el('div', { class: 'hr skel' }, el('i', {}), el('i', {}))));

    const paintConn = () => {
      const bad = !!S.modelsError, ok = !bad && S.models.length > 0;
      return tile('Gateway', ok ? 'Connected' : bad ? 'Not connected' : S.modelsLoaded ? 'No models' : 'Checking…',
        ok ? `${S.models.length} models available` : bad ? 'Open Settings to connect' : '',
        el('i', { class: 'ht-dot ' + (ok ? 'ok' : bad ? 'bad' : '') }));
    };

    (async () => {
      const [chats, sites, apps, gw] = await Promise.allSettled([
        S.api('GET', '/api/chats'), S.api('GET', '/api/projects'), S.api('GET', '/api/projects?kind=app'), S.api('GET', '/api/gateway'),
      ]);
      if (gone) return;
      const val = (r, d) => (r.status === 'fulfilled' ? r.value : d);
      const chatList = val(chats, []), siteList = val(sites, []), appList = val(apps, []), g = val(gw, null);
      const online = g ? (g.connectors || []).filter((c) => c.status === 'connected').length : 0;
      S.set(stats,
        paintConn(),
        tile('Combos', String(S.combos.length || 0), S.combos.length ? 'ready in every picker' : 'none pinned yet'),
        tile('Projects', String(siteList.length + appList.length), `${siteList.length} websites · ${appList.length} apps`),
        tile('Chats', String(chatList.length), chatList[0] ? 'last ' + S.ago(chatList[0].updated) : 'nothing yet'),
        tile('App Chatbot', g ? (g.status.running ? 'Listening' : 'Off') : '—', g ? (g.status.running ? `${online} app${online === 1 ? '' : 's'} online · ${g.stats.chats24h} chats today` : 'start it in App Chatbot') : '',
          el('i', { class: 'ht-dot ' + (g && g.status.running ? 'ok' : '') })));

      const top = chatList.slice(0, 6);
      if (!top.length) {
        S.set(recent, el('div', { class: 'hr-empty' }, 'No chats yet. ', el('button', { class: 'link', onclick: () => S.go('chat') }, 'Start one'), ' and it will show up here.'));
      } else {
        S.set(recent, top.map((c, i) => el('button', { class: 'hr', style: `--i:${i}`, onclick: async () => {
          const route = S.views[c.mode] ? c.mode : 'chat';
          try {
            const st = (S.chatState[route] ||= { chat: null, list: [], busy: false, abort: null });
            if (!st.busy) st.chat = await S.api('GET', '/api/chats/' + c.id);
          } catch (e) { S.toast(e.message, true); }
          S.go(route);
        } }, el('span', { class: 'hr-t' }, c.title || 'Untitled'), el('span', { class: 'chip' }, c.mode), el('span', { class: 'hr-m' }, `${c.count} msg · ${S.ago(c.updated)}`))));
      }
    })();

    const onModels = () => { const first = stats.firstChild; if (first && !first.classList.contains('skel')) first.replaceWith(paintConn()); };
    document.addEventListener('gk:models', onModels);
    return () => { gone = true; document.removeEventListener('gk:models', onModels); };
  };
})();
