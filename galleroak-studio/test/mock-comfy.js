'use strict';
/**
 * A small stand-in for ComfyUI used by the tests. It speaks the same HTTP + WebSocket API shapes
 * (/system_stats, /object_info, /prompt, /queue, /history, /view, /upload/image, /interrupt, /free, /ws)
 * and validates prompts the way ComfyUI does, so integration code can be exercised without a GPU.
 * It does NOT render anything: outputs are tiny generated files.
 */
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, [r, g, b]) {
  const row = Buffer.alloc(w * 3 + 1);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function wsFrame(payload, binary) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const op = binary ? 2 : 1;
  const head = data.length < 126 ? Buffer.from([0x80 | op, data.length]) : (() => { const h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(data.length, 2); return h; })();
  return Buffer.concat([head, data]);
}

function createMockComfy(port, opts = {}) {
  const o = { oldStyle: false, kStepMs: 150, token: '', ...opts };
  const combo = (list, extra = {}) => (o.oldStyle ? [list, extra] : ['COMBO', { options: list, ...extra }]);
  const state = {
    checkpoints: o.checkpoints || ['v1-5-pruned-emaonly.safetensors', 'sd_xl_base_1.0.safetensors'],
    unets: o.unets || ['flux1-dev.safetensors', 'wan2.1_t2v_1.3B_fp16.safetensors', 'wan2.2_t2v_high_noise_14B_fp8.safetensors'],
    clips: o.clips || ['umt5_xxl_fp8_e4m3fn_scaled.safetensors'],
    dualClips: o.dualClips || ['t5xxl_fp16.safetensors', 'clip_l.safetensors'],
    vaes: o.vaes || ['ae.safetensors', 'wan_2.1_vae.safetensors'],
    inputs: ['example.png'], pending: [], running: null, history: {}, files: new Map(), clients: new Map(),
    promptCount: 0, interrupts: 0, queueDeletes: [], frees: 0, uploads: [], authSeen: [], lastPrompt: null, wsClients: 0,
  };
  const num = (def, extra = {}) => ['INT', { default: def, min: 0, max: 8192, ...extra }];
  const nodes = () => ({
    CheckpointLoaderSimple: { input: { required: { ckpt_name: combo(state.checkpoints) } }, output: ['MODEL', 'CLIP', 'VAE'] },
    CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } }, output: ['CONDITIONING'] },
    EmptyLatentImage: { input: { required: { width: num(512), height: num(512), batch_size: num(1) } }, output: ['LATENT'] },
    EmptySD3LatentImage: { input: { required: { width: num(1024), height: num(1024), batch_size: num(1) } }, output: ['LATENT'] },
    KSampler: { input: { required: { model: ['MODEL'], seed: num(0, { max: 2 ** 53 }), steps: num(20), cfg: ['FLOAT', { default: 8 }], sampler_name: combo(['euler', 'dpmpp_2m', 'uni_pc']), scheduler: combo(['normal', 'karras', 'simple', 'sgm_uniform']), positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT', { default: 1 }] } }, output: ['LATENT'] },
    VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'] },
    SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } }, output: [], output_node: true },
    UNETLoader: { input: { required: { unet_name: combo(state.unets), weight_dtype: combo(['default', 'fp8_e4m3fn']) } }, output: ['MODEL'] },
    DualCLIPLoader: { input: { required: { clip_name1: combo(state.dualClips), clip_name2: combo(state.dualClips), type: combo(['sdxl', 'sd3', 'flux', 'hunyuan_video']) } }, output: ['CLIP'] },
    CLIPLoader: { input: { required: { clip_name: combo(state.clips), type: combo(['stable_diffusion', 'sd3', 'wan']) }, optional: { device: combo(['default', 'cpu']) } }, output: ['CLIP'] },
    VAELoader: { input: { required: { vae_name: combo(state.vaes) } }, output: ['VAE'] },
    FluxGuidance: { input: { required: { conditioning: ['CONDITIONING'], guidance: ['FLOAT', { default: 3.5 }] } }, output: ['CONDITIONING'] },
    ConditioningZeroOut: { input: { required: { conditioning: ['CONDITIONING'] } }, output: ['CONDITIONING'] },
    EmptyHunyuanLatentVideo: { input: { required: { width: num(848), height: num(480), length: num(25), batch_size: num(1) } }, output: ['LATENT'] },
    ModelSamplingSD3: { input: { required: { model: ['MODEL'], shift: ['FLOAT', { default: 3 }] } }, output: ['MODEL'] },
    CreateVideo: { input: { required: { images: ['IMAGE'], fps: ['FLOAT', { default: 30 }] } }, output: ['VIDEO'] },
    SaveVideo: { input: { required: { video: ['VIDEO'], filename_prefix: ['STRING', { default: 'video/ComfyUI' }], format: combo(['auto', 'mp4']), codec: combo(['auto', 'h264']) } }, output: [], output_node: true },
    LoadImage: { input: { required: { image: combo(state.inputs) } }, output: ['IMAGE', 'MASK'] },
    WanImageToVideo: { input: { required: { positive: ['CONDITIONING'], negative: ['CONDITIONING'], vae: ['VAE'], width: num(832), height: num(480), length: num(81), batch_size: num(1) }, optional: { start_image: ['IMAGE'] } }, output: ['CONDITIONING', 'CONDITIONING', 'LATENT'] },
    KSamplerAdvanced: { input: { required: { model: ['MODEL'], noise_seed: num(0), steps: num(20), cfg: ['FLOAT', { default: 8 }], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'] } }, output: ['LATENT'] },
  });

  /* ---- validation (same error shape as ComfyUI) ---- */
  function validate(prompt) {
    const info = nodes();
    const node_errors = {};
    const bad = (id, cls, type, message, details) => { (node_errors[id] = node_errors[id] || { errors: [], class_type: cls }).errors.push({ type, message, details, extra_info: {} }); };
    for (const [id, n] of Object.entries(prompt)) {
      const def = info[n.class_type];
      if (!def) { bad(id, n.class_type, 'missing_node_type', `Node '${n.class_type}' not found. The custom node may not be installed.`, ''); continue; }
      for (const [name, spec] of Object.entries(def.input.required)) {
        const v = (n.inputs || {})[name];
        if (v === undefined) { bad(id, n.class_type, 'required_input_missing', 'Required input is missing', name); continue; }
        if (Array.isArray(v)) { if (!prompt[v[0]]) bad(id, n.class_type, 'bad_link', 'Link to a missing node', name); continue; }
        const list = Array.isArray(spec[0]) ? spec[0] : spec[0] === 'COMBO' ? spec[1].options : null;
        if (list && !list.includes(v)) bad(id, n.class_type, 'value_not_in_list', `Value not in list: ${name}: '${v}' not in [${list.join(', ')}]`, `${name}: '${v}' not in list`);
      }
    }
    return node_errors;
  }

  /* ---- worker ---- */
  const sendWs = (cid, msg, binary) => { const s = state.clients.get(cid); if (s && !s.destroyed) s.write(wsFrame(msg, binary)); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let busy = false;
  async function work() {
    if (busy) return;
    busy = true;
    while (state.pending.length) {
      const job = state.pending.shift();
      state.running = job;
      try { await runJob(job); } finally { state.running = null; }
    }
    busy = false;
  }
  async function runJob(job) {
    const { id, prompt, cid } = job;
    sendWs(cid, { type: 'execution_start', data: { prompt_id: id } });
    let failed = null;
    for (const [nid, n] of Object.entries(prompt).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      sendWs(cid, { type: 'executing', data: { node: nid, prompt_id: id } });
      if (/^KSampler/.test(n.class_type)) {
        const seed = n.inputs.seed ?? n.inputs.noise_seed;
        const steps = 6;
        for (let i = 1; i <= steps; i++) {
          await wait(o.kStepMs);
          if (job.interrupted) break;
          sendWs(cid, { type: 'progress', data: { value: i, max: steps, prompt_id: id, node: nid } });
          if (i === 2) sendWs(cid, Buffer.from('preview-bytes'), true); // binary preview frame the client must ignore
        }
        if (seed === 13) failed = { node_type: n.class_type, exception_message: 'Allocation on device 0 would exceed allowed memory. (out of memory)' };
      }
      if (job.interrupted || failed) break;
    }
    sendWs(cid, { type: 'executing', data: { node: null, prompt_id: id } });
    const entry = { prompt: [0, id, prompt], outputs: {}, status: { status_str: 'success', completed: true, messages: [] } };
    if (job.interrupted) { entry.status = { status_str: 'error', completed: false, messages: [['execution_interrupted', { node_type: 'KSampler' }]] }; }
    else if (failed) { entry.status = { status_str: 'error', completed: false, messages: [['execution_error', failed]] }; }
    else {
      for (const [nid, n] of Object.entries(prompt)) {
        const seedNode = Object.values(prompt).find((x) => x.inputs && (x.inputs.seed ?? x.inputs.noise_seed) !== undefined);
        const seed = seedNode ? Number(seedNode.inputs.seed ?? seedNode.inputs.noise_seed) : 0;
        if (n.class_type === 'SaveImage') {
          const name = `OmniStudio_${String(++state.promptCount).padStart(5, '0')}_.png`;
          state.files.set(`output/|${name}`, { type: 'image/png', data: png(64, 48, [seed % 256, (seed >> 3) % 256, 120]) });
          entry.outputs[nid] = { images: [{ filename: name, subfolder: '', type: 'output' }] };
        } else if (n.class_type === 'SaveVideo') {
          const name = `OmniStudio_${String(++state.promptCount).padStart(5, '0')}_.mp4`;
          state.files.set(`output/video|${name}`, { type: 'video/mp4', data: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), crypto.randomBytes(2000)]) });
          entry.outputs[nid] = { images: [{ filename: name, subfolder: 'video', type: 'output' }], animated: [true] };
        }
      }
    }
    state.history[id] = entry;
  }

  /* ---- http ---- */
  const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b); };
  const readAll = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    state.authSeen.push(req.headers.authorization || '');
    if (o.token && req.headers.authorization !== 'Bearer ' + o.token) return json(res, 401, { error: 'unauthorized' });
    try {
      if (u.pathname === '/system_stats') return json(res, 200, { system: { os: 'posix', comfyui_version: '0.3.99', python_version: '3.12' }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4070 : cudaMallocAsync', type: 'cuda', vram_total: 12 * 1024 ** 3, vram_free: 9 * 1024 ** 3 }] });
      if (u.pathname === '/object_info') return json(res, 200, nodes());
      if (u.pathname === '/queue' && req.method === 'GET') return json(res, 200, { queue_running: state.running ? [[0, state.running.id, state.running.prompt, {}, []]] : [], queue_pending: state.pending.map((j, i) => [i + 1, j.id, j.prompt, {}, []]) });
      if (u.pathname === '/queue' && req.method === 'POST') {
        const b = JSON.parse((await readAll(req)).toString() || '{}');
        for (const id of b.delete || []) { state.queueDeletes.push(id); state.pending = state.pending.filter((j) => j.id !== id); state.history[id] = { prompt: [0, id, {}], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_interrupted', {}]] } }; }
        return json(res, 200, {});
      }
      if (u.pathname === '/interrupt') { state.interrupts++; if (state.running) state.running.interrupted = true; return json(res, 200, {}); }
      if (u.pathname === '/free') { state.frees++; return json(res, 200, {}); }
      if (u.pathname.startsWith('/history/')) { const id = decodeURIComponent(u.pathname.slice(9)); return json(res, 200, state.history[id] ? { [id]: state.history[id] } : {}); }
      if (u.pathname === '/view') {
        const f = state.files.get(`${u.searchParams.get('type')}/${u.searchParams.get('subfolder')}|${u.searchParams.get('filename')}`);
        if (!f) { res.writeHead(404); return res.end('nope'); }
        res.writeHead(200, { 'Content-Type': f.type }); return res.end(f.data);
      }
      if (u.pathname === '/upload/image' && req.method === 'POST') {
        const body = await readAll(req);
        const boundary = '--' + String(req.headers['content-type']).split('boundary=')[1];
        const part = body.toString('latin1').split(boundary).find((p) => /name="image"/.test(p));
        const name = part && (part.match(/filename="([^"]+)"/) || [])[1];
        if (!name) return json(res, 400, { error: 'no image' });
        const data = Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''), 'latin1');
        state.inputs.push(name); state.uploads.push({ name, size: data.length, head: [...data.subarray(0, 4)] });
        return json(res, 200, { name, subfolder: '', type: 'input' });
      }
      if (u.pathname === '/prompt' && req.method === 'POST') {
        const b = JSON.parse((await readAll(req)).toString());
        state.lastPrompt = b.prompt;
        const errs = validate(b.prompt || {});
        if (Object.keys(errs).length) return json(res, 400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} }, node_errors: errs });
        const id = crypto.randomUUID();
        state.pending.push({ id, prompt: b.prompt, cid: b.client_id });
        setImmediate(work);
        return json(res, 200, { prompt_id: id, number: state.pending.length, node_errors: {} });
      }
      res.writeHead(404); res.end('not found');
    } catch (e) { json(res, 500, { error: String(e) }); }
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const cid = new URL(req.url, 'http://x').searchParams.get('clientId');
    state.clients.set(cid, socket); state.wsClients++;
    socket.on('data', () => {}); socket.on('error', () => {}); socket.on('close', () => state.clients.delete(cid));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    state, port, url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { for (const s of state.clients.values()) s.destroy(); server.close(() => r()); server.closeAllConnections && server.closeAllConnections(); }),
  })));
}

module.exports = { createMockComfy };
