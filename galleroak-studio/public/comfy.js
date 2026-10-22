'use strict';
/* ComfyUI tab: connect, pick a workflow (auto-detected or imported), make images and videos, browse the gallery. */
(function () {
  const { el } = S;

  const SIZES = {
    image: [['Square 1024', '1024x1024'], ['Square 768', '768x768'], ['Square 512', '512x512'], ['Landscape 1344×768', '1344x768'], ['Portrait 832×1216', '832x1216']],
    video: [['Landscape 832×480', '832x480'], ['Portrait 480×832', '480x832'], ['Small 640×360', '640x360'], ['Square 512', '512x512']],
  };
  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  // ComfyUI reports e.g. "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync"; show just the card
  const deviceName = (n) => String(n).replace(/^\w+:\d+\s+/, '').replace(/\s*:\s*\w+$/, '').trim() || String(n);
  const PROMPT_HELPER = {
    image: 'You write prompts for AI image generators. Rewrite the user idea as ONE detailed prompt (40-80 words): subject, setting, composition, lighting, colour palette, lens or art style. No preamble, no quotes, output only the prompt.',
    video: 'You write prompts for AI video generators. Rewrite the user idea as ONE detailed prompt (60-110 words): subject, action, setting, camera movement and angle, lighting, colour mood, style. No preamble, no quotes, output only the prompt.',
  };

  S.views.comfy = (container) => {
    let st = null, wfs = { auto: [], imported: [], skipped: [], models: null, error: null }, jobs = [];
    let dead = false, jobTimer = null, statTimer = null, loadedWf = '';
    let kind = S.pref.get('comfy.kind', 'image');
    let startData = null, startFrom = '';
    const input = (type, attrs = {}) => el('input', { type, ...attrs });

    /* ------------------------------ connection ------------------------------ */
    const statusBox = el('div', { class: 'card' });
    const urlIn = input('text', { placeholder: 'http://127.0.0.1:8188' });
    const tokenIn = input('password', { placeholder: 'Only if your ComfyUI needs one' });
    const timeoutIn = input('number', { min: '1', max: '600', style: 'width:90px' });
    const settingsBox = el('div', { style: 'display:none', class: 'stack' });
    let settingsOpen = false;

    function drawStatus() {
      const kids = [];
      if (!st) kids.push(el('div', { class: 'hint' }, 'Checking ComfyUI…'));
      else if (st.ok) {
        const d = st.devices[0];
        kids.push(el('div', { class: 'row' },
          el('span', { class: 'chip accent' }, '● Connected'),
          el('span', {}, `ComfyUI ${st.version || ''}`.trim()),
          d ? el('span', { class: 'hint', style: 'margin:0' }, `${deviceName(d.name)} · ${gb(d.vramFree)} of ${gb(d.vramTotal)} GB video memory free`) : null,
          st.queue ? el('span', { class: 'hint', style: 'margin:0' }, `queue: ${st.queue.running} running, ${st.queue.pending} waiting`) : null,
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn sm', title: 'Look at the models installed in ComfyUI again', onclick: rescan }, S.iconEl('refresh'), 'Rescan'),
          el('button', { class: 'btn sm', title: 'Unload models from the GPU to make room', onclick: freeVram }, 'Free VRAM'),
          el('button', { class: 'btn sm ghost', onclick: () => { settingsOpen = !settingsOpen; drawSettings(); } }, S.iconEl('sliders'), 'Connection')));
      } else {
        kids.push(el('div', { class: 'banner bad', style: 'margin:0 0 12px' }, el('div', {}, el('b', {}, 'Not connected. '), st.error || 'ComfyUI did not answer.')));
        settingsOpen = true;
        kids.push(el('div', { class: 'hint' }, 'Start ComfyUI (its window shows an address, usually ' + 'http://127.0.0.1:8188), then press Connect. If you use ComfyUI Desktop, open it first.'));
      }
      statusBox.replaceChildren(...kids, settingsBox);
      drawSettings();
    }

    function drawSettings() {
      settingsBox.style.display = settingsOpen ? '' : 'none';
      if (!settingsOpen) return;
      urlIn.value = urlIn.value || (st && st.url) || S.config.comfy.url;
      timeoutIn.value = timeoutIn.value || (st && st.timeoutMin) || 60;
      S.set(settingsBox,
        el('div', { class: 'grid2', style: 'margin-top:10px' },
          el('label', { class: 'field' }, el('span', {}, 'ComfyUI address'), urlIn),
          el('label', { class: 'field' }, el('span', {}, 'Give up on a job after (minutes)'), timeoutIn)),
        el('label', { class: 'field' }, el('span', {}, st && st.hasToken ? 'Access token (saved - type to replace)' : 'Access token (optional)'), tokenIn),
        el('div', { class: 'row' },
          el('button', { class: 'btn primary', onclick: saveConn }, 'Connect'),
          st && st.hasToken ? el('button', { class: 'btn', onclick: () => saveConn(true) }, 'Remove saved token') : null,
          el('span', { class: 'hint', style: 'margin:0' }, 'The token is stored on this computer and never shown again.')));
    }

    async function saveConn(clearToken) {
      try {
        st = await S.api('POST', '/api/comfy/config', { url: urlIn.value, token: tokenIn.value, timeoutMin: timeoutIn.value, clearToken: clearToken === true });
        tokenIn.value = '';
        if (st.ok) { settingsOpen = false; S.toast('Connected to ComfyUI'); await loadWorkflows(); } else S.toast(st.error, true);
        drawStatus();
      } catch (e) { S.toast(e.message, true); }
    }
    async function loadStatus() { try { st = await S.api('GET', '/api/comfy/status'); } catch (e) { st = { ok: false, error: e.message }; } if (!dead) drawStatus(); }
    const rescan = async () => { try { wfs = await S.api('POST', '/api/comfy/rescan', {}); drawWf(); S.toast('Rescanned: ' + wfs.auto.length + ' workflows detected'); loadStatus(); } catch (e) { S.toast(e.message, true); } };
    const freeVram = async () => { try { await S.api('POST', '/api/comfy/free', {}); S.toast('Asked ComfyUI to free GPU memory'); loadStatus(); } catch (e) { S.toast(e.message, true); } };

    /* ------------------------------ generator form ------------------------------ */
    const seg = el('div', { class: 'seg' });
    const wfSel = el('select', {});
    const wfNote = el('div', { class: 'hint' });
    const prompt = el('textarea', { rows: '4', placeholder: 'Describe what you want…' });
    const negative = el('textarea', { rows: '2', placeholder: 'What to avoid (optional)' });
    const preset = el('select', {});
    const wIn = input('number', { min: '64', max: '4096', step: '8' });
    const hIn = input('number', { min: '64', max: '4096', step: '8' });
    const framesIn = input('number', { min: '1', max: '1000' });
    const fpsIn = input('number', { min: '1', max: '120' });
    const stepsIn = input('number', { min: '1', max: '200' });
    const cfgIn = input('number', { min: '0', max: '30', step: '0.1' });
    const seedIn = input('number', { min: '0', placeholder: 'random' });
    const countIn = input('number', { min: '1', max: '8', value: '1' });
    const field = (label, node) => el('label', { class: 'field', style: 'margin:0' }, el('span', {}, label), node);
    const F = {
      negative: field('Negative prompt', negative), size: field('Size', preset), width: field('Width', wIn), height: field('Height', hIn),
      frames: field('Frames', framesIn), fps: field('Frames per second', fpsIn), steps: field('Steps', stepsIn), cfg: field('Guidance (CFG)', cfgIn),
      seed: field('Seed', seedIn), count: field('How many', countIn),
    };
    const startBox = el('div', { class: 'card', style: 'display:none;margin:0;background:var(--panel-2)' });
    const genBtn = el('button', { class: 'btn primary' }, 'Generate');
    const boostBtn = el('button', { class: 'btn', title: 'Ask your chat model to turn a rough idea into a detailed prompt' }, '✨ Improve prompt');
    const importIn = input('file', { accept: '.json,application/json', style: 'display:none' });
    const importBtn = el('button', { class: 'btn', title: 'Use a workflow you made in ComfyUI (Workflow → Export (API))' }, S.iconEl('plus'), 'Import workflow');
    const delWfBtn = el('button', { class: 'btn ghost danger', style: 'display:none' }, S.iconEl('trash'), 'Remove this workflow');
    const adv = el('details', {}, el('summary', { class: 'hint', style: 'cursor:pointer' }, 'Advanced'), el('div', { class: 'grid2', style: 'margin-top:10px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))' }, F.steps, F.cfg, F.seed, F.count));
    const sizeRow = el('div', { class: 'grid2', style: 'grid-template-columns:repeat(auto-fit,minmax(130px,1fr))' }, F.size, F.width, F.height, F.frames, F.fps);

    const all = () => [...wfs.auto, ...wfs.imported];
    const current = () => all().find((w) => w.id === wfSel.value) || null;

    function drawKind() {
      seg.replaceChildren(...['image', 'video'].map((k) => el('button', { class: kind === k ? 'on' : '', onclick: () => { kind = k; S.pref.set('comfy.kind', k); loadedWf = ''; drawKind(); drawWf(); } }, k === 'image' ? 'Images' : 'Videos')));
    }

    function drawWf() {
      const mine = (list) => list.filter((w) => w.kind === kind);
      const prev = wfSel.value || S.pref.get('comfy.wf.' + kind, '');
      wfSel.replaceChildren();
      const group = (label, list) => { if (list.length) wfSel.append(el('optgroup', { label }, list.map((w) => el('option', { value: w.id }, w.name + (w.confidence === 'guess' ? '  (best guess)' : ''))))); };
      group('Detected in your ComfyUI', mine(wfs.auto));
      group('Your imported workflows', mine(wfs.imported));
      if ([...wfSel.options].some((o) => o.value === prev)) wfSel.value = prev;
      const notes = [];
      if (wfs.error) notes.push(wfs.error);
      else if (!wfSel.options.length) {
        notes.push(`No ${kind} workflows yet. ${kind === 'video' ? 'Wan 2.1 text-to-video is built automatically when its model, text encoder and VAE are installed. For other video models' : 'For models GallerOak Studio does not build automatically'}, import a workflow with "Import workflow".`);
      }
      for (const s of wfs.skipped || []) if ((kind === 'video') === /wan|video/i.test(s.what)) notes.push(`${s.what}: ${s.why}.`);
      wfNote.replaceChildren(...notes.map((n) => el('div', {}, n)));
      onWorkflowChange(false);
    }

    function onWorkflowChange(user) {
      const wf = current();
      if (wf) S.pref.set('comfy.wf.' + kind, wf.id);
      const has = (k) => !!wf && wf.bindings.includes(k);
      F.negative.style.display = has('negative') ? '' : 'none';
      F.size.style.display = has('width') ? '' : 'none'; F.width.style.display = F.height.style.display = has('width') ? '' : 'none';
      F.frames.style.display = has('frames') ? '' : 'none'; F.fps.style.display = has('fps') ? '' : 'none';
      F.steps.style.display = has('steps') ? '' : 'none'; F.cfg.style.display = has('cfg') ? '' : 'none'; F.seed.style.display = has('seed') ? '' : 'none';
      sizeRow.style.display = has('width') || has('frames') ? '' : 'none';
      delWfBtn.style.display = wf && wf.source === 'imported' ? '' : 'none';
      genBtn.disabled = !wf;
      preset.replaceChildren(...SIZES[kind].map(([l, v]) => el('option', { value: v }, l)), el('option', { value: 'custom' }, 'Custom'));
      if (wf && loadedWf !== wf.id) {
        loadedWf = wf.id;
        const v = wf.values || {};
        wIn.value = v.width || ''; hIn.value = v.height || ''; framesIn.value = v.frames || ''; fpsIn.value = v.fps || '';
        stepsIn.value = v.steps || ''; cfgIn.value = v.cfg || '';
        syncPreset();
        if (kind === 'video' && !wf.needsImage) { startData = null; startFrom = ''; }
      }
      const extra = [];
      if (wf && wf.confidence === 'guess') extra.push('Built automatically for this model family; if results look wrong, import your own workflow.');
      for (const w of (wf && wf.warnings) || []) extra.push(w);
      if (wf && wf.source === 'imported') extra.push('Detected controls: ' + wf.bindings.filter((b) => b !== 'checkpoint').join(', ') + '.');
      for (const e of extra) wfNote.append(el('div', {}, e));
      drawStart();
    }

    function syncPreset() { const key = `${wIn.value}x${hIn.value}`; preset.value = [...preset.options].some((o) => o.value === key) ? key : 'custom'; }
    preset.addEventListener('change', () => { if (preset.value === 'custom') return; const [w, h] = preset.value.split('x'); wIn.value = w; hIn.value = h; });
    wIn.addEventListener('input', syncPreset); hIn.addEventListener('input', syncPreset);
    wfSel.addEventListener('change', () => onWorkflowChange(true));

    function drawStart() {
      const wf = current();
      if (!wf || !wf.needsImage) { startBox.style.display = 'none'; return; }
      startBox.style.display = '';
      const file = input('file', { accept: 'image/png,image/jpeg,image/webp', style: 'display:none' });
      file.addEventListener('change', () => {
        const f = file.files[0]; if (!f) return;
        if (f.size > 15 * 1024 * 1024) return S.toast('Pick an image under 15 MB.', true);
        const r = new FileReader();
        r.onload = () => { startData = r.result; startFrom = ''; drawStart(); };
        r.readAsDataURL(f);
      });
      const src = startFrom ? '/outputs/comfy/' + encodeURIComponent(startFrom) : startData;
      S.set(startBox,
        el('div', { class: 'row' },
          src ? el('img', { src, style: 'height:64px;border-radius:8px;display:block' }) : null,
          el('div', {}, el('b', {}, 'Start image'), el('div', { class: 'hint', style: 'margin:0' }, src ? 'This picture becomes the first frame. Describe the motion below.' : 'This workflow animates a picture. Choose one, or press "Animate" on an image in the gallery.')),
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn sm', onclick: () => file.click() }, src ? 'Change' : 'Choose image…'),
          src ? el('button', { class: 'btn sm ghost', onclick: () => { startData = null; startFrom = ''; drawStart(); } }, 'Clear') : null, file));
    }

    genBtn.addEventListener('click', async () => {
      const wf = current();
      if (!wf) return S.toast('Choose a workflow first.', true);
      if (wf.bindings.includes('prompt') && !prompt.value.trim()) return S.toast('Describe what you want first.', true);
      const params = {};
      const num = (k, node) => { if (wf.bindings.includes(k) && node.value !== '') params[k] = Number(node.value); };
      num('width', wIn); num('height', hIn); num('frames', framesIn); num('fps', fpsIn); num('steps', stepsIn); num('cfg', cfgIn); num('seed', seedIn);
      genBtn.disabled = true;
      try {
        await S.api('POST', '/api/comfy/generate', { workflow: wf.id, prompt: prompt.value, negative: wf.bindings.includes('negative') ? negative.value : undefined, count: Number(countIn.value) || 1, params, imageData: startFrom ? undefined : startData || undefined, imageFrom: startFrom || undefined });
        S.toast('Sent to ComfyUI. It will appear below when ready.');
        refreshJobs();
      } catch (e) { S.toast(e.message, true); }
      genBtn.disabled = false;
    });

    boostBtn.addEventListener('click', async () => {
      const text = prompt.value.trim();
      const model = S.config.modeModels.chat;
      if (!text) return S.toast('Type a rough idea first.');
      if (!model) return S.toast('Pick a default Chat model in Settings to use this.', true);
      boostBtn.disabled = true; boostBtn.textContent = 'Improving…';
      try {
        const r = await S.api('POST', '/api/chat', { model, stream: false, skills: false, params: { temperature: 0.8 }, messages: [{ role: 'system', content: PROMPT_HELPER[kind] }, { role: 'user', content: text }] });
        const out = (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content || '').trim();
        if (out) prompt.value = out;
      } catch (e) { S.toast(e.message, true); }
      boostBtn.disabled = false; boostBtn.textContent = '✨ Improve prompt';
    });

    importBtn.addEventListener('click', () => importIn.click());
    importIn.addEventListener('change', async () => {
      const f = importIn.files[0]; importIn.value = '';
      if (!f) return;
      try {
        const r = await S.api('POST', '/api/comfy/workflows', { name: f.name.replace(/\.json$/i, ''), graph: await f.text() });
        kind = r.workflow.kind; S.pref.set('comfy.kind', kind); S.pref.set('comfy.wf.' + kind, r.workflow.id);
        wfs = await S.api('GET', '/api/comfy/workflows'); wfSel.value = ''; loadedWf = ''; drawKind(); drawWf();
        if (r.problems.length) await S.dialog('Imported, but ComfyUI would not run it yet', [el('p', { style: 'color:var(--muted);margin:0 0 8px' }, 'Fix these in ComfyUI (install the model or node), then press Rescan:'), el('pre', { style: 'white-space:pre-wrap;font-size:12.5px' }, r.problems.join('\n'))], [{ label: 'OK', cls: 'primary', value: true }]);
        else S.toast('Workflow imported. Detected: ' + r.workflow.bindings.filter((b) => b !== 'checkpoint').join(', '));
      } catch (e) { S.toast(e.message, true); }
    });
    delWfBtn.addEventListener('click', async () => {
      const wf = current();
      if (!wf || !(await S.confirm('Remove this workflow?', `"${wf.name}" is removed from GallerOak Studio. ComfyUI itself is not touched.`, 'Remove'))) return;
      await S.api('DELETE', '/api/comfy/workflows/' + wf.id);
      wfs = await S.api('GET', '/api/comfy/workflows'); loadedWf = ''; drawWf();
    });

    /* ------------------------------ gallery ------------------------------ */
    const gallery = el('div', { class: 'video-grid' });
    const fileUrl = (f) => '/outputs/comfy/' + encodeURIComponent(f.file);

    function reuse(j) {
      kind = j.kind; S.pref.set('comfy.kind', kind);
      if (all().some((w) => w.id === j.workflow)) S.pref.set('comfy.wf.' + kind, j.workflow);
      loadedWf = ''; wfSel.value = ''; drawKind(); drawWf();
      prompt.value = j.prompt; negative.value = j.negative || '';
      const p = j.params || {};
      if (p.width) wIn.value = p.width; if (p.height) hIn.value = p.height; if (p.frames) framesIn.value = p.frames; if (p.fps) fpsIn.value = p.fps;
      if (p.steps) stepsIn.value = p.steps; if (p.cfg) cfgIn.value = p.cfg; seedIn.value = p.seed !== undefined ? p.seed : '';
      syncPreset(); prompt.scrollIntoView({ behavior: 'smooth', block: 'center' }); S.toast('Settings copied. The seed is kept, so you can reproduce this result.');
    }

    async function animate(j) {
      const cands = wfs.imported.filter((w) => w.kind === 'video' && w.needsImage);
      if (!cands.length) return S.dialog('Animate needs an image-to-video workflow', [el('p', { style: 'color:var(--muted);margin:0' }, 'In ComfyUI build or open an image-to-video workflow (for example Wan 2.1 / 2.2 image-to-video), export it with Workflow → Export (API), then press "Import workflow" here. After that, Animate works on any image in this gallery.')], [{ label: 'OK', cls: 'primary', value: true }]);
      kind = 'video'; S.pref.set('comfy.kind', 'video'); S.pref.set('comfy.wf.video', cands[0].id);
      loadedWf = ''; wfSel.value = ''; drawKind(); drawWf();
      startFrom = j.files[0].file; startData = null; drawStart();
      prompt.value = prompt.value || j.prompt; prompt.scrollIntoView({ behavior: 'smooth', block: 'center' }); prompt.focus();
      S.toast('Start image set. Describe the motion, then press Generate.');
    }

    function drawGallery() {
      gallery.replaceChildren();
      if (!jobs.length) gallery.append(el('div', { class: 'hint', style: 'grid-column:1/-1' }, 'Nothing yet. Results are saved on this computer in data/outputs/comfy.'));
      const canAnimate = wfs.imported.some((w) => w.kind === 'video' && w.needsImage);
      for (const j of jobs) {
        let top;
        if (j.status === 'done' && j.files[0]) {
          const f = j.files[0];
          top = f.kind === 'video' ? el('video', { controls: true, loop: true, muted: true, preload: 'metadata', src: fileUrl(f) })
            : el('a', { href: fileUrl(f), target: '_blank', rel: 'noopener', title: 'Open full size' }, el('img', { src: fileUrl(f), loading: 'lazy', alt: j.prompt }));
        } else if (j.status === 'error' || j.status === 'cancelled') {
          top = el('div', { class: 'ph', style: j.status === 'error' ? 'color:var(--bad);white-space:pre-wrap;text-align:left' : '' }, j.status === 'cancelled' ? 'Stopped.' : j.error || 'Failed');
        } else {
          const pct = j.progress && j.progress.max ? Math.round(100 * j.progress.value / j.progress.max) : null;
          top = el('div', { class: 'ph' }, el('div', { style: 'width:100%' }, el('div', { class: 'spin' }), el('div', {}, j.note || 'Generating…'),
            pct !== null ? el('div', { class: 'pbar', style: 'margin:8px auto 0' }, el('i', { style: `width:${pct}%` })) : null,
            pct !== null ? el('div', { class: 'hint' }, `step ${j.progress.value} of ${j.progress.max}`) : null));
        }
        const done = j.status === 'done' && j.files[0];
        gallery.append(el('div', { class: 'vcard' }, top, el('div', { class: 'b' },
          el('div', { class: 'p', title: j.prompt }, j.prompt || '(no prompt)'),
          el('div', { class: 'row' }, el('span', { class: 'chip' }, j.workflowName), j.params && j.params.width ? el('span', { class: 'chip' }, `${j.params.width || ''}×${j.params.height || ''}`.replace(/^×$/, '')) : null,
            j.seconds !== undefined && done ? el('span', { class: 'chip' }, j.seconds + 's') : null, el('span', { class: 'hint', style: 'margin:0' }, S.ago(j.created))),
          el('div', { class: 'row' },
            done ? el('a', { class: 'btn sm', href: fileUrl(j.files[0]), download: j.files[0].file }, S.iconEl('down'), 'Download') : null,
            done && j.files[0].kind === 'image' && canAnimate ? el('button', { class: 'btn sm', onclick: () => animate(j) }, '🎬 Animate') : null,
            j.prompt ? el('button', { class: 'btn sm', onclick: () => reuse(j) }, 'Reuse') : null,
            j.status === 'running' ? el('button', { class: 'btn sm danger', onclick: async () => { try { await S.api('POST', `/api/comfy/jobs/${j.id}/stop`, {}); refreshJobs(); } catch (e) { S.toast(e.message, true); } } }, S.iconEl('stop'), 'Stop') : null,
            el('span', { class: 'spacer' }),
            j.status !== 'running' ? el('button', { class: 'btn sm ghost danger', onclick: async () => { if (await S.confirm('Delete this result?', 'The file is removed from your computer.', 'Delete')) { await S.api('DELETE', '/api/comfy/jobs/' + j.id); refreshJobs(); } } }, S.iconEl('trash')) : null))));
      }
    }

    let sig = '';
    async function refreshJobs() {
      if (dead) return;
      try { jobs = await S.api('GET', '/api/comfy/jobs'); } catch { /* keep the old list */ }
      if (dead) return;
      const s = JSON.stringify(jobs.map((j) => [j.id, j.status, j.note, j.progress, j.error, (j.files[0] || {}).file]));
      if (s !== sig) { sig = s; drawGallery(); }
      clearTimeout(jobTimer);
      if (jobs.some((j) => j.status === 'running')) jobTimer = setTimeout(refreshJobs, 1000);
    }

    async function loadWorkflows() {
      try { wfs = await S.api('GET', '/api/comfy/workflows'); } catch (e) { wfs = { auto: [], imported: [], skipped: [], models: null, error: e.message }; }
      if (dead) return;
      loadedWf = ''; drawWf(); drawGallery();
    }

    /* ------------------------------ page ------------------------------ */
    container.append(
      el('div', { class: 'topbar' }, el('h1', {}, 'ComfyUI'), el('span', { class: 'sub' }, 'Images and videos from the ComfyUI on your computer, with workflows built from what you have installed')),
      el('div', { class: 'page' }, el('div', { class: 'stack' },
        statusBox,
        el('div', { class: 'card' },
          el('div', { class: 'row', style: 'margin-bottom:12px' }, seg, el('span', { class: 'spacer' }), importBtn, importIn, delWfBtn),
          el('label', { class: 'field', style: 'margin-bottom:6px' }, el('span', {}, 'Workflow'), wfSel), wfNote,
          startBox,
          el('label', { class: 'field', style: 'margin-top:12px' }, el('span', {}, 'Prompt'), prompt),
          F.negative, sizeRow, adv,
          el('div', { class: 'row', style: 'margin-top:12px' }, genBtn, boostBtn)),
        gallery)));

    drawKind(); drawStatus(); drawGallery();
    loadStatus().then(() => { if (st && st.ok) loadWorkflows(); else { drawWf(); } });
    refreshJobs();
    statTimer = setInterval(() => { if (!document.hidden && !statusBox.contains(document.activeElement)) loadStatus(); }, 15000);
    return () => { dead = true; clearTimeout(jobTimer); clearInterval(statTimer); };
  };
})();
