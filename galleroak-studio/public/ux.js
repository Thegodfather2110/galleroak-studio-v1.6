'use strict';
/* GallerOak Studio interaction layer. Nothing here changes what any view does; it only polishes how it feels:
 *   - progress strip while requests are in flight
 *   - tooltips (from title="" or data-tip="") instead of the slow native ones
 *   - press ripple on buttons
 *   - animated, keyboard-friendly, searchable dropdowns that progressively enhance every <select>
 * Everything honours prefers-reduced-motion and the Settings > Motion switch. */
(function () {
  const { el } = S;
  const root = document.documentElement;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || root.dataset.motion === 'reduced';

  /* ------------------------------ progress strip ------------------------------ */
  (function progress() {
    const bar = S.$('#progress');
    if (!bar) return;
    let timer = null;
    document.addEventListener('gk:busy', (e) => {
      if (e.detail > 0) {
        if (!timer && !bar.classList.contains('on')) timer = setTimeout(() => { bar.classList.add('on'); timer = null; }, 160); // quick calls never flash it
      } else {
        clearTimeout(timer); timer = null;
        if (bar.classList.contains('on')) { bar.classList.add('fin'); setTimeout(() => bar.classList.remove('on', 'fin'), 360); }
      }
    });
  })();

  /* ------------------------------ tooltips ------------------------------ */
  (function tooltips() {
    const tip = el('div', { class: 'tooltip', role: 'tooltip', id: 'gk-tip' });
    document.body.append(tip);
    let cur = null, timer = null;

    const text = (t) => {
      let v = t.getAttribute('data-tip');
      if (v === null) {
        const ti = t.getAttribute('title');
        if (!ti) return '';
        // Take over from the slow native tooltip. Icon-only controls keep an accessible name.
        t.setAttribute('data-tip', ti);
        t.removeAttribute('title');
        if (!t.getAttribute('aria-label') && !t.textContent.trim() && /^(BUTTON|A|INPUT)$/.test(t.tagName)) t.setAttribute('aria-label', ti);
        v = ti;
      }
      return v;
    };
    const place = (t, side) => {
      const r = t.getBoundingClientRect();
      const w = tip.offsetWidth, h = tip.offsetHeight, m = 8;
      let x, y;
      if (side === 'right') { x = r.right + 10; y = r.top + r.height / 2 - h / 2; }
      else {
        x = r.left + r.width / 2 - w / 2;
        y = r.top - h - 8;
        if (y < m) { y = r.bottom + 8; side = 'bottom'; } else side = 'top';
      }
      x = Math.max(m, Math.min(x, innerWidth - w - m));
      y = Math.max(m, Math.min(y, innerHeight - h - m));
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      tip.dataset.side = side;
    };
    const show = (t) => {
      const v = text(t);
      if (!v) return;
      cur = t;
      tip.replaceChildren(el('span', {}, v));
      const k = t.getAttribute('data-tip-kbd');
      if (k) tip.append(el('kbd', {}, k));
      const collapsedNav = t.classList.contains('nav-item') && root.dataset.rail === 'collapsed';
      tip.classList.add('on');
      place(t, collapsedNav || t.dataset.tipPos === 'right' ? 'right' : 'top');
      t.setAttribute('aria-describedby', 'gk-tip');
    };
    const hide = () => {
      clearTimeout(timer); timer = null;
      tip.classList.remove('on');
      if (cur) { cur.removeAttribute('aria-describedby'); cur = null; }
    };
    const find = (n) => (n && n.closest ? n.closest('[data-tip],[title]') : null);
    // nav labels are already visible while the rail is expanded, so only show them when it is collapsed
    const skip = (t) => t.hasAttribute('data-notip') || (t.classList.contains('nav-item') && root.dataset.rail !== 'collapsed') || t.disabled && !t.getAttribute('data-tip');

    document.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const t = find(e.target);
      if (!t || t === cur) return;
      hide();
      if (skip(t)) return;
      const quick = tip.dataset.warm === '1';
      timer = setTimeout(() => { show(t); tip.dataset.warm = '1'; }, quick ? 60 : 420);
    });
    document.addEventListener('pointerout', (e) => {
      const t = find(e.target);
      if (!t || t.contains(e.relatedTarget)) return;
      hide();
      clearTimeout(window.__gkWarm); window.__gkWarm = setTimeout(() => { tip.dataset.warm = '0'; }, 500);
    });
    document.addEventListener('focusin', (e) => {
      const t = find(e.target);
      if (t && !skip(t) && e.target.matches && e.target.matches(':focus-visible')) show(t);
    });
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    document.addEventListener('gk:route', hide);
  })();

  /* ------------------------------ press ripple ------------------------------ */
  (function ripple() {
    const SEL = '.btn, .nav-item, .chip-btn, .tab, .pills button, .gcard, .suggest button, .hr, .m-btn, .rail-toggle, .proj-card, .cast-card';
    document.addEventListener('pointerdown', (e) => {
      if (reduced() || e.button > 0) return;
      const t = e.target.closest && e.target.closest(SEL);
      if (!t || t.disabled) return;
      const r = t.getBoundingClientRect();
      t.style.setProperty('--rx', e.clientX - r.left + 'px');
      t.style.setProperty('--ry', e.clientY - r.top + 'px');
      t.classList.remove('rip'); void t.offsetWidth; t.classList.add('rip');
      t.addEventListener('animationend', (ev) => { if (ev.animationName === 'gk-rip') t.classList.remove('rip'); }, { once: true });
    }, true);
  })();

  /* ------------------------------ dropdowns ------------------------------ */
  (function dropdowns() {
    const vDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    const iDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
    const ENH = new WeakMap();
    let openDD = null;
    const SEARCH_AT = 9;           // show a filter box when a list is longer than this
    const chev = () => el('span', { class: 'dd-chev', 'aria-hidden': 'true', html: S.icon('chevron') });

    function closeOpen(restoreFocus) {
      if (!openDD) return;
      const d = openDD; openDD = null;
      d.close(restoreFocus);
    }

    function enhance(sel) {
      if (ENH.has(sel)) return ensure(sel);
      if (!sel.isConnected || sel.multiple || sel.size > 1 || sel.closest('[data-native]') || sel.hasAttribute('data-native')) return;
      const wrap = el('span', { class: 'dd' });
      const label = el('span', { class: 'dd-val' });
      const btn = el('button', { type: 'button', class: 'dd-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, label, chev());
      // inline sizing the views set on the <select> moves to the wrapper / button
      const st = sel.style;
      for (const p of ['width', 'maxWidth', 'minWidth', 'flex', 'margin', 'marginTop', 'marginBottom', 'marginLeft', 'alignSelf']) if (st[p]) wrap.style[p] = st[p];
      for (const p of ['padding', 'fontSize']) if (st[p]) btn.style[p] = st[p];
      if (sel.title) { btn.setAttribute('data-tip', sel.title); }
      const labelledBy = sel.getAttribute('aria-label');
      if (labelledBy) btn.setAttribute('aria-label', labelledBy);
      sel.parentNode.insertBefore(wrap, sel);
      wrap.append(btn, sel);
      sel.classList.add('dd-native');
      sel.tabIndex = -1;
      sel.setAttribute('aria-hidden', 'true');

      const api = { wrap, btn, label };
      ENH.set(sel, api);

      const refresh = () => {
        const o = sel.options[sel.selectedIndex];
        label.textContent = o ? o.textContent : '';
        wrap.classList.toggle('ph', !o || o.value === '');
        btn.disabled = sel.disabled;
        wrap.classList.toggle('disabled', sel.disabled);
      };
      api.refresh = refresh;
      Object.defineProperty(sel, 'value', { configurable: true, get() { return vDesc.get.call(this); }, set(v) { vDesc.set.call(this, v); refresh(); } });
      Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return iDesc.get.call(this); }, set(v) { iDesc.set.call(this, v); refresh(); } });
      sel.focus = (o) => btn.focus(o);
      sel.addEventListener('focus', () => btn.focus());   // <label> clicks land on the hidden select; forward them
      let queued = false;
      const mo = new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; refresh(); }); } });
      mo.observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'label'] });
      api.mo = mo;
      refresh();

      /* ---------------- popup ---------------- */
      function open() {
        if (btn.disabled) return;
        closeOpen();
        const host = sel.closest('dialog[open]') || document.body;
        const pop = el('div', { class: 'dd-pop', role: 'listbox' });
        const items = [];            // { node, option, idx, text }
        const groups = [];
        const list = el('div', { class: 'dd-list' });
        const all = [...sel.querySelectorAll('option')];
        let search = null;
        if (all.length > SEARCH_AT) {
          search = el('input', { type: 'text', class: 'dd-search', placeholder: 'Search…', 'aria-label': 'Filter options', autocomplete: 'off', spellcheck: 'false' });
          pop.append(el('div', { class: 'dd-sw' }, el('span', { class: 'dd-si', html: S.icon('search'), 'aria-hidden': 'true' }), search));
        }
        const addOpt = (o, parent) => {
          const idx = all.indexOf(o);
          const node = el('div', { class: 'dd-item' + (o.disabled ? ' dis' : ''), role: 'option', 'aria-selected': String(idx === sel.selectedIndex), 'data-idx': idx },
            el('span', { class: 'dd-ck', html: S.icon('check'), 'aria-hidden': 'true' }), el('span', { class: 'dd-tx' }, o.textContent));
          const it = { node, option: o, idx, text: o.textContent.toLowerCase(), group: parent };
          node.addEventListener('pointermove', () => setActive(it, false));
          node.addEventListener('click', () => { if (!o.disabled) choose(it); });
          items.push(it);
          (parent ? parent.box : list).append(node);
        };
        for (const child of sel.children) {
          if (child.tagName === 'OPTGROUP') {
            const g = { head: el('div', { class: 'dd-group' }, child.label), box: el('div', { class: 'dd-gbox' }) };
            groups.push(g);
            list.append(g.head, g.box);
            for (const o of child.children) if (o.tagName === 'OPTION') addOpt(o, g);
          } else if (child.tagName === 'OPTION') addOpt(child, null);
        }
        const empty = el('div', { class: 'dd-empty' }, 'No matches');
        empty.hidden = true;
        pop.append(list, empty);
        host.append(pop);

        let active = null;
        const visible = () => items.filter((i) => !i.node.hidden && !i.option.disabled);
        function setActive(it, scroll = true) {
          if (active) active.node.classList.remove('act');
          active = it;
          if (it) { it.node.classList.add('act'); if (scroll) it.node.scrollIntoView({ block: 'nearest' }); }
        }
        function choose(it) {
          const changed = sel.selectedIndex !== it.idx;
          sel.selectedIndex = it.idx;
          if (changed) { sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
          closeOpen(true);
        }
        function position() {
          const r = btn.getBoundingClientRect();
          const vw = innerWidth, vh = innerHeight, m = 10;
          const minW = Math.max(r.width, 200);
          pop.style.minWidth = Math.min(minW, vw - 2 * m) + 'px';
          pop.style.maxWidth = vw - 2 * m + 'px';
          const below = vh - r.bottom - m, above = r.top - m;
          const flip = below < 220 && above > below;
          const room = Math.max(140, Math.min(380, (flip ? above : below) - 6));
          pop.style.maxHeight = room + 'px';
          list.style.maxHeight = room - (search ? 46 : 0) - 8 + 'px';
          let left = r.left;
          const w = pop.offsetWidth;
          if (left + w > vw - m) left = Math.max(m, vw - m - w);
          pop.style.left = Math.round(left) + 'px';
          if (flip) { pop.style.top = 'auto'; pop.style.bottom = Math.round(vh - r.top + 6) + 'px'; pop.dataset.side = 'top'; }
          else { pop.style.bottom = 'auto'; pop.style.top = Math.round(r.bottom + 6) + 'px'; pop.dataset.side = 'bottom'; }
        }
        position();
        const sIt = items.find((i) => i.idx === sel.selectedIndex) || visible()[0];
        setActive(sIt, false);
        requestAnimationFrame(() => { pop.classList.add('in'); if (sIt) sIt.node.scrollIntoView({ block: 'center' }); });
        btn.setAttribute('aria-expanded', 'true');
        wrap.classList.add('open');
        if (search) setTimeout(() => search.focus({ preventScroll: true }), 0);

        /* filtering */
        if (search) search.addEventListener('input', () => {
          const q = search.value.trim().toLowerCase();
          for (const it of items) it.node.hidden = !!q && !it.text.includes(q);
          for (const g of groups) g.head.hidden = g.box.hidden = ![...g.box.children].some((n) => !n.hidden);
          empty.hidden = items.some((i) => !i.node.hidden);
          setActive(visible()[0] || null, false);
          list.scrollTop = 0;
        });

        /* keyboard (captured so it wins over page shortcuts) */
        let typed = '', typedAt = 0;
        const onKey = (e) => {
          const v = visible();
          const i = Math.max(0, v.indexOf(active));
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(v[Math.min(v.length - 1, i + 1)]); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(v[Math.max(0, i - 1)]); }
          else if (e.key === 'Home') { e.preventDefault(); setActive(v[0]); }
          else if (e.key === 'End') { e.preventDefault(); setActive(v[v.length - 1]); }
          else if (e.key === 'PageDown') { e.preventDefault(); setActive(v[Math.min(v.length - 1, i + 8)]); }
          else if (e.key === 'PageUp') { e.preventDefault(); setActive(v[Math.max(0, i - 8)]); }
          else if (e.key === 'Enter') { e.preventDefault(); if (active) choose(active); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeOpen(true); }
          else if (e.key === 'Tab') closeOpen(false);
          else if (!search && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {   // type-ahead when there is no filter box
            const now = Date.now(); typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase(); typedAt = now;
            const hit = v.find((it) => it.text.startsWith(typed)) || v.find((it) => it.text.includes(typed));
            if (hit) setActive(hit);
          }
        };
        const onDown = (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) closeOpen(false); };
        const onScroll = (e) => { if (!pop.contains(e.target)) closeOpen(false); };
        const onResize = () => closeOpen(false);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', onDown, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        document.addEventListener('gk:route', onResize);

        openDD = {
          close(restoreFocus) {
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
            document.removeEventListener('gk:route', onResize);
            btn.setAttribute('aria-expanded', 'false');
            wrap.classList.remove('open');
            pop.classList.remove('in');
            pop.classList.add('out');
            setTimeout(() => pop.remove(), reduced() ? 0 : 150);
            if (restoreFocus) btn.focus({ preventScroll: true });
          },
        };
      }
      api.open = open;
      btn.addEventListener('click', () => (wrap.classList.contains('open') ? closeOpen(true) : open()));
      btn.addEventListener('keydown', (e) => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {   // closed type-ahead changes the value like a native select
          const q = e.key.toLowerCase();
          const opts = [...sel.options].filter((o) => !o.disabled);
          const start = opts.findIndex((o) => o === sel.options[sel.selectedIndex]);
          const next = [...opts.slice(start + 1), ...opts.slice(0, start + 1)].find((o) => o.textContent.trim().toLowerCase().startsWith(q));
          if (next) { sel.selectedIndex = next.index; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        }
      });
    }

    /* The select was moved out of its wrapper by a view: rebuild around its new spot. */
    function ensure(sel) {
      const api = ENH.get(sel);
      if (!api || sel.parentNode === api.wrap) return;
      try { api.mo.disconnect(); } catch {}
      api.wrap.remove();
      delete sel.value; delete sel.selectedIndex; delete sel.focus;
      sel.classList.remove('dd-native');
      sel.removeAttribute('aria-hidden'); sel.removeAttribute('tabindex');
      ENH.delete(sel);
      enhance(sel);
    }

    const scan = (node) => {
      if (!node || node.nodeType !== 1) return;
      try {
        if (node.tagName === 'SELECT') enhance(node);
        else if (node.querySelectorAll) node.querySelectorAll('select').forEach((s) => { try { enhance(s); } catch {} });
      } catch {}
    };
    new MutationObserver((muts) => { for (const m of muts) m.addedNodes.forEach(scan); }).observe(document.body, { childList: true, subtree: true });
    scan(document.body);
    S.enhanceSelects = scan;
  })();
})();
