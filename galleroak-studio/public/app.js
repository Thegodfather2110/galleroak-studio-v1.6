'use strict';
/* Boot: load config, build the sidebar, open the last view. */
(async function () {
  const { el } = S;
  const root = document.documentElement;
  try { root.dataset.theme = S.pref.get('theme', 'dark'); } catch {}

  /* ------------------------------ navigation ------------------------------ */
  const NAV = [
    ['home', 'Home'],
    ['sep', 'Talk'], ['voice', 'Voice'], ['chat', 'Chat'], ['reasoning', 'Reasoning'], ['coding', 'Coding'],
    ['sep', 'Create'], ['builder', 'Websites'], ['rea', 'REA'], ['apps', 'Apps'], ['video', 'Video'], ['comfy', 'ComfyUI'],
    ['sep', 'Work'], ['agent', 'Computer'], ['team', 'Team'], ['connectors', 'Connectors'], ['gateway', 'App Chatbot'],
    ['sep', 'Compare'], ['arena', 'Arena'],
    ['sep', 'Teach'], ['skills', 'Skills'],
    ['sep', 'Setup'], ['settings', 'Settings'],
  ];
  const nav = S.$('#nav');
  let idx = 0;
  for (const [route, label] of NAV) {
    if (route === 'sep') { nav.append(el('div', { class: 'nav-sep', 'aria-hidden': 'true', style: `--i:${idx++}` }, el('span', {}, label))); continue; }
    nav.append(el('button', { class: 'nav-item', 'data-route': route, title: label, style: `--i:${idx++}`, onclick: () => {
      // leaving the Websites tab always lands on the gallery first
      if (route === 'builder' && S.route === 'builder') S.pref.set('project', '');
      if (route === 'rea' && S.route === 'rea') S.pref.set('rea.project', '');
      if (route === 'apps' && S.route === 'apps') S.pref.set('app.project', '');
      S.go(route);
      closeDrawer();
    } }, S.iconEl(route === 'home' ? 'home' : route), el('span', { class: 'nav-label' }, label)));
  }
  S.$('#status').addEventListener('click', () => { S.go('settings'); closeDrawer(); });
  S.$('#brandHome').addEventListener('click', () => { S.go('home'); closeDrawer(); });

  /* ------------------------------ brand marks ------------------------------ */
  S.$('#brandMark').innerHTML = S.brand.mark(30, { small: true });
  S.$('#mBrand').innerHTML = S.brand.mark(24, { small: true }) + '<b>GallerOak</b><i>STUDIO</i>';
  S.$('#menuBtn').innerHTML = S.icon('menu');
  S.$('#railToggleIco').innerHTML = S.icon('panel');

  /* --------------------- sidebar: collapse (desktop) + drawer (mobile) --------------------- */
  const mobile = window.matchMedia('(max-width: 820px)');
  const toggle = S.$('#railToggle');
  const menuBtn = S.$('#menuBtn');
  const paintRail = () => {
    const collapsed = root.dataset.rail === 'collapsed';
    const open = root.dataset.drawer === 'open';
    const expanded = mobile.matches ? open : !collapsed;
    toggle.setAttribute('aria-expanded', String(expanded));
    menuBtn.setAttribute('aria-expanded', String(open));
    const word = mobile.matches ? 'Close menu' : collapsed ? 'Expand' : 'Collapse';
    S.$('.rt-label', toggle).textContent = word;
    toggle.title = (mobile.matches ? 'Close menu' : collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  };
  function closeDrawer() { if (root.dataset.drawer === 'open') { delete root.dataset.drawer; paintRail(); } }
  function openDrawer() { root.dataset.drawer = 'open'; paintRail(); const a = S.$('.nav-item.active') || S.$('.nav-item'); if (a) a.focus({ preventScroll: true }); }
  S.toggleRail = () => {
    if (mobile.matches) { root.dataset.drawer === 'open' ? closeDrawer() : openDrawer(); return; }
    root.dataset.rail = root.dataset.rail === 'collapsed' ? 'expanded' : 'collapsed';
    S.pref.set('rail', root.dataset.rail);
    paintRail();
  };
  toggle.addEventListener('click', S.toggleRail);
  menuBtn.addEventListener('click', S.toggleRail);
  S.$('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); S.toggleRail(); }
    else if (e.key === 'Escape' && root.dataset.drawer === 'open') { closeDrawer(); menuBtn.focus(); }
  });
  mobile.addEventListener('change', () => { delete root.dataset.drawer; paintRail(); });
  paintRail();

  /* ------------------------------ boot sequence ------------------------------ */
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || root.dataset.motion === 'reduced';
  const started = performance.now();
  let seen = false;
  try { seen = sessionStorage.getItem('gk.boot') === '1'; sessionStorage.setItem('gk.boot', '1'); } catch {}
  const hideBoot = () => {
    const boot = S.$('#boot');
    if (!boot) return;
    const minShow = reduced() ? 0 : seen ? 250 : 1150;   // let the mark finish drawing on a first visit
    setTimeout(() => {
      boot.classList.add('done');
      setTimeout(() => boot.remove(), 450);
    }, Math.max(0, minShow - (performance.now() - started)));
  };

  try {
    S.config = await S.api('GET', '/api/config');
  } catch (e) {
    S.$('#view').append(el('div', { class: 'page' }, el('div', { class: 'banner bad' }, 'Cannot reach the GallerOak Studio server: ' + e.message)));
    hideBoot();
    return;
  }

  if (S.loadPersonas) await S.loadPersonas();
  const first = !S.config.hasKey;
  const saved = S.pref.get('route', 'home');
  S.go(first ? 'settings' : S.views[saved] ? saved : 'home');
  hideBoot();
  S.loadModels().then(async () => { if (await S.applyStarterModels()) S.go(S.route); });
})();
