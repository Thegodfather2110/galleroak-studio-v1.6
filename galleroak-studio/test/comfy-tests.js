'use strict';
/** ComfyUI integration tests against a mock ComfyUI. Run:  node test/comfy-tests.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnistudio-comfy-test-'));
process.env.OMNISTUDIO_DATA = tmp;
process.env.PORT = '3298';

const http = require('http');
const { createMockComfy } = require('./mock-comfy');
const { handle } = require('../server');
const comfy = require('../lib/comfy');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const BASE = 'http://localhost:3298';
async function api(method, p, body) {
  // same as the browser's S.api(): the JSON content type is only sent together with a body
  const resp = await fetch(BASE + p, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: resp.status, json, headers: resp.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + label); await sleep(120); }
}
const jobs = async () => (await api('GET', '/api/comfy/jobs')).json;
const job = async (id) => (await jobs()).find((j) => j.id === id);
const finished = (id) => until(async () => { const j = await job(id); return j && j.status !== 'running' ? j : null; }, 30000, 'job ' + id);

(async () => {
  const server = http.createServer(handle);
  await new Promise((r) => server.listen(3298, '127.0.0.1', r));
  console.log('ComfyUI integration tests (data dir: ' + tmp + ')');

  await test('status: a clear message when ComfyUI is not running', async () => {
    let r = await api('POST', '/api/comfy/config', { url: '127.0.0.1:28188' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /Cannot reach ComfyUI at http:\/\/127\.0\.0\.1:28188/);
    assert.match(r.json.error, /Start ComfyUI first/);
    r = await api('POST', '/api/comfy/config', { url: 'not a url ::' });
    assert.equal(r.status, 400);
  });

  const mock = await createMockComfy(28188);

  await test('status: connected, version, GPU and queue', async () => {
    const { json } = await api('GET', '/api/comfy/status');
    assert.equal(json.ok, true);
    assert.equal(json.version, '0.3.99');
    assert.match(json.devices[0].name, /RTX 4070/);
    assert.equal(json.devices[0].vramTotal, 12 * 1024 ** 3);
    assert.deepEqual(json.queue, { running: 0, pending: 0 });
  });

  let wf;
  await test('discovery: builds workflows for what is installed, explains what it skipped', async () => {
    const { json } = await api('GET', '/api/comfy/workflows');
    wf = json;
    assert.equal(json.error, null);
    const ids = json.auto.map((w) => w.id);
    assert.ok(ids.includes('auto:image:v1-5-pruned-emaonly.safetensors'));
    assert.ok(ids.includes('auto:image:sd_xl_base_1.0.safetensors'));
    assert.ok(ids.includes('auto:image:flux:flux1-dev.safetensors'));
    assert.ok(ids.includes('auto:video:wan:wan2.1_t2v_1.3B_fp16.safetensors'));
    assert.equal(json.auto.find((w) => w.id.includes('v1-5')).confidence, 'standard');
    assert.equal(json.auto.find((w) => w.id.includes('flux')).confidence, 'guess');
    assert.equal(json.auto.find((w) => w.id.includes('wan2.1')).kind, 'video');
    assert.ok(json.skipped.some((s) => s.what === 'Wan 2.2' && /two models/.test(s.why)));
    assert.deepEqual(json.models.checkpoints.length, 2);
  });

  await test('discovery: old and new ComfyUI combo formats give the same result', async () => {
    const old = await createMockComfy(28189, { oldStyle: true });
    await api('POST', '/api/comfy/config', { url: old.url });
    const r = await api('POST', '/api/comfy/rescan', {});
    assert.deepEqual(r.json.auto.map((w) => w.id), wf.auto.map((w) => w.id));
    await old.close();
    await api('POST', '/api/comfy/config', { url: mock.url });
    await api('POST', '/api/comfy/rescan', {});
  });

  await test('auto workflows: every control is bound without any manual setup', async () => {
    for (const w of wf.auto) {
      for (const k of ['prompt', 'seed', 'steps', 'cfg', 'width', 'height']) assert.ok(w.bindings.includes(k), `${w.id} missing ${k}`);
      if (w.kind === 'video') for (const k of ['frames', 'fps']) assert.ok(w.bindings.includes(k), `${w.id} missing ${k}`);
    }
    assert.ok(wf.auto.find((w) => w.id.includes('v1-5')).bindings.includes('negative'));
    assert.equal(wf.auto.find((w) => w.id.includes('v1-5')).values.width, 512);
    assert.equal(wf.auto.find((w) => w.id.includes('xl_base')).values.width, 1024);
  });

  const classic = 'auto:image:v1-5-pruned-emaonly.safetensors';
  let firstImages = [];
  await test('generate images: batch of 2, live progress, files saved and served', async () => {
    const r = await api('POST', '/api/comfy/generate', { workflow: classic, prompt: 'a red fox in snow', negative: 'blurry', count: 2, params: { width: 1001, height: 768, steps: 12, cfg: 5.5 } });
    assert.equal(r.status, 202);
    assert.equal(r.json.jobs.length, 2);
    let sawProgress = false, sawRunning = false;
    const done = await until(async () => {
      const list = (await jobs()).filter((j) => r.json.jobs.some((x) => x.id === j.id));
      if (list.some((j) => j.progress && j.progress.max === 6)) sawProgress = true;
      if (list.some((j) => /^Running/.test(j.note || ''))) sawRunning = true;
      return list.length === 2 && list.every((j) => j.status !== 'running') ? list : null;
    }, 30000, 'both jobs');
    assert.ok(done.every((j) => j.status === 'done'), JSON.stringify(done.map((j) => j.error)));
    if (typeof WebSocket !== 'undefined') {
      assert.ok(sawProgress, 'WebSocket progress (value/max) was never observed');
      assert.ok(sawRunning, 'node-by-node status was never observed');
      assert.ok(mock.state.wsClients >= 2);
    } else console.log('       (no WebSocket in this Node version: progress is polled)');
    for (const j of done) {
      const f = j.files[0];
      assert.equal(f.kind, 'image');
      const bytes = fs.readFileSync(path.join(tmp, 'outputs', 'comfy', f.file));
      assert.deepEqual([...bytes.subarray(0, 4)], [137, 80, 78, 71]);
      const served = await fetch(BASE + '/outputs/comfy/' + f.file);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'image/png');
    }
    assert.notEqual(done[0].params.seed, done[1].params.seed, 'each image should get its own random seed');
    const sent = mock.state.lastPrompt;
    const texts = Object.values(sent).filter((n) => n.class_type === 'CLIPTextEncode').map((n) => n.inputs.text).sort();
    assert.deepEqual(texts, ['a red fox in snow', 'blurry']);
    const lat = Object.values(sent).find((n) => n.class_type === 'EmptyLatentImage').inputs;
    assert.equal(lat.width, 1000); assert.equal(lat.height, 768);
    const ks = Object.values(sent).find((n) => n.class_type === 'KSampler').inputs;
    assert.equal(ks.steps, 12); assert.equal(ks.cfg, 5.5);
    firstImages = done.map((j) => j.files[0].file);
  });

  await test('generate video: Wan text-to-video with frames and fps', async () => {
    const r = await api('POST', '/api/comfy/generate', { workflow: 'auto:video:wan:wan2.1_t2v_1.3B_fp16.safetensors', prompt: 'waves at sunset', params: { width: 480, height: 320, frames: 17, fps: 12, seed: 7 } });
    const j = await finished(r.json.jobs[0].id);
    assert.equal(j.status, 'done', j.error);
    assert.equal(j.kind, 'video');
    assert.equal(j.files[0].kind, 'video');
    const served = await fetch(BASE + '/outputs/comfy/' + j.files[0].file);
    assert.equal(served.headers.get('content-type'), 'video/mp4');
    const sent = Object.values(mock.state.lastPrompt);
    assert.equal(sent.find((n) => n.class_type === 'EmptyHunyuanLatentVideo').inputs.length, 17);
    assert.equal(sent.find((n) => n.class_type === 'CreateVideo').inputs.fps, 12);
    assert.equal(sent.find((n) => n.class_type === 'KSampler').inputs.seed, 7);
  });

  await test('import: ComfyUI editor format is refused with exact instructions', async () => {
    const r = await api('POST', '/api/comfy/workflows', { name: 'x', graph: { nodes: [], links: [] } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Export \(API\)/);
    assert.equal((await api('POST', '/api/comfy/workflows', { name: 'x', graph: '{nope' })).status, 400);
    assert.equal((await api('POST', '/api/comfy/workflows', { name: 'x', graph: { a: { foo: 1 } } })).status, 400);
  });

  const classicGraph = (ckpt) => ({
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'old prompt', clip: ['1', 1] }, _meta: { title: 'Positive' } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'ugly', clip: ['1', 1] }, _meta: { title: 'Negative' } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: 640, height: 640, batch_size: 1 } },
    5: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 5, steps: 9, cfg: 4, sampler_name: 'euler', scheduler: 'normal', positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], denoise: 1 } },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
  });

  await test('import: your own API workflow is analysed and runs; a {"prompt": …} wrapper is accepted', async () => {
    const r = await api('POST', '/api/comfy/workflows', { name: 'My SD workflow', graph: { prompt: classicGraph('v1-5-pruned-emaonly.safetensors') } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.problems, []);
    assert.equal(r.json.workflow.kind, 'image');
    assert.equal(r.json.workflow.values.width, 640);
    assert.ok(['prompt', 'negative', 'seed', 'checkpoint'].every((k) => r.json.workflow.bindings.includes(k)));
    const run = await api('POST', '/api/comfy/generate', { workflow: r.json.workflow.id, prompt: 'new prompt', negative: '' });
    const j = await finished(run.json.jobs[0].id);
    assert.equal(j.status, 'done', j.error);
    const t = Object.values(mock.state.lastPrompt).filter((n) => n.class_type === 'CLIPTextEncode').map((n) => n.inputs.text).sort();
    assert.deepEqual(t, ['', 'new prompt']);
    const list = (await api('GET', '/api/comfy/workflows')).json;
    assert.equal(list.imported.length, 1);
    assert.equal((await api('DELETE', '/api/comfy/workflows/' + r.json.workflow.id)).json.ok, true);
    assert.equal((await api('GET', '/api/comfy/workflows')).json.imported.length, 0);
  });

  await test('check before sending: a missing model reads in plain words and nothing is sent to ComfyUI', async () => {
    const r = await api('POST', '/api/comfy/workflows', { name: 'Bad model', graph: classicGraph('v1-5-pruned.safetensors') });
    assert.ok(r.json.problems.length >= 1);
    assert.match(r.json.problems[0], /Node 1 \(CheckpointLoaderSimple\): "v1-5-pruned\.safetensors" is not available/);
    assert.match(r.json.problems[0], /Did you mean "v1-5-pruned-emaonly\.safetensors"\?/);
    const before = mock.state.lastPrompt;
    const run = await api('POST', '/api/comfy/generate', { workflow: r.json.workflow.id, prompt: 'x' });
    const j = await finished(run.json.jobs[0].id);
    assert.equal(j.status, 'error');
    assert.match(j.error, /not available/);
    assert.equal(mock.state.lastPrompt, before, 'the bad workflow must not reach ComfyUI');
    await api('DELETE', '/api/comfy/workflows/' + r.json.workflow.id);
  });

  await test('check before sending: unknown custom nodes are named', () => {
    const info = { KSampler: { input: { required: {} } } };
    const pf = comfy.preflight({ 1: { class_type: 'MyFancyNode', inputs: {} } }, info);
    assert.match(pf.problems[0], /MyFancyNode.*not installed.*custom node pack/);
  });

  await test('check before sending: missing defaults are filled in, broken links are reported', () => {
    const info = { KSampler: { input: { required: { seed: ['INT', { default: 0 }], denoise: ['FLOAT', { default: 1 }], model: ['MODEL'] } } } };
    const pf = comfy.preflight({ 1: { class_type: 'KSampler', inputs: { seed: 1, model: ['9', 0] } } }, info);
    assert.equal(pf.graph[1].inputs.denoise, 1);
    assert.match(pf.problems[0], /points to node 9/);
  });

  let i2v;
  const i2vGraph = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.1_t2v_1.3B_fp16.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'positive', clip: ['2', 0] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: 'negative words', clip: ['2', 0] } },
    6: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
    7: { class_type: 'WanImageToVideo', inputs: { positive: ['4', 0], negative: ['5', 0], vae: ['3', 0], width: 832, height: 480, length: 33, batch_size: 1, start_image: ['6', 0] } },
    8: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 1, steps: 20, cfg: 6, sampler_name: 'uni_pc', scheduler: 'simple', positive: ['7', 0], negative: ['7', 1], latent_image: ['7', 2], denoise: 1 } },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps: 16 } },
    11: { class_type: 'SaveVideo', inputs: { video: ['10', 0], filename_prefix: 'video/i2v', format: 'auto', codec: 'auto' } },
  };
  await test('image-to-video: positive and negative prompts stay separate through the Wan node', async () => {
    const r = await api('POST', '/api/comfy/workflows', { name: 'Wan I2V', graph: i2vGraph });
    assert.deepEqual(r.json.problems, []);
    i2v = r.json.workflow;
    assert.equal(i2v.kind, 'video');
    assert.equal(i2v.needsImage, true);
    assert.ok(['prompt', 'negative', 'image', 'frames', 'fps', 'width'].every((k) => i2v.bindings.includes(k)));
    const a = comfy.analyze(i2vGraph);
    assert.equal(a.bindings.prompt[0].node, '4');
    assert.equal(a.bindings.negative[0].node, '5');
  });

  await test('image-to-video: refuses without a start image; "Animate" uploads a saved image and runs', async () => {
    const no = await api('POST', '/api/comfy/generate', { workflow: i2v.id, prompt: 'zoom in' });
    assert.equal(no.status, 400);
    assert.match(no.json.error, /animates a picture/);
    const run = await api('POST', '/api/comfy/generate', { workflow: i2v.id, prompt: 'the fox runs', imageFrom: firstImages[0], params: { frames: 25 } });
    assert.equal(run.status, 202);
    const j = await finished(run.json.jobs[0].id);
    assert.equal(j.status, 'done', j.error);
    assert.equal(mock.state.uploads.length, 1);
    assert.deepEqual(mock.state.uploads[0].head, [137, 80, 78, 71], 'the PNG must arrive byte for byte');
    assert.equal(Object.values(mock.state.lastPrompt).find((n) => n.class_type === 'LoadImage').inputs.image, mock.state.uploads[0].name);
    assert.equal(Object.values(mock.state.lastPrompt).find((n) => n.class_type === 'WanImageToVideo').inputs.length, 25);
    const tiny = 'data:image/png;base64,' + fs.readFileSync(path.join(tmp, 'outputs', 'comfy', firstImages[1])).toString('base64');
    const run2 = await api('POST', '/api/comfy/generate', { workflow: i2v.id, prompt: 'again', imageData: tiny });
    assert.equal((await finished(run2.json.jobs[0].id)).status, 'done');
    assert.equal((await api('POST', '/api/comfy/generate', { workflow: i2v.id, prompt: 'x', imageData: 'data:text/html;base64,AAAA' })).status, 400);
    assert.equal((await api('POST', '/api/comfy/generate', { workflow: i2v.id, prompt: 'x', imageFrom: '../../config.json' })).status, 400);
  });

  await test('errors: GPU out-of-memory is explained with what to try', async () => {
    const run = await api('POST', '/api/comfy/generate', { workflow: classic, prompt: 'x', params: { seed: 13 } });
    const j = await finished(run.json.jobs[0].id);
    assert.equal(j.status, 'error');
    assert.match(j.error, /KSampler failed/);
    assert.match(j.error, /out of memory/i);
    assert.match(j.error, /Free VRAM/);
  });

  await test('errors: ComfyUI validation errors are turned into one readable message', async () => {
    const msg = comfy.preflight; // sanity: function exists
    assert.equal(typeof msg, 'function');
    const bad = { ...classicGraph('v1-5-pruned-emaonly.safetensors') };
    bad[5] = { class_type: 'KSampler', inputs: { ...bad[5].inputs, sampler_name: 'nonsense' } };
    const r = await api('POST', '/api/comfy/workflows', { name: 'Bad sampler', graph: bad });
    assert.match(r.json.problems.join(' '), /"nonsense" is not available for "sampler_name"/);
    await api('DELETE', '/api/comfy/workflows/' + r.json.workflow.id);
  });

  await test('stop: a queued job leaves the queue, a running job is interrupted', async () => {
    const run = await api('POST', '/api/comfy/generate', { workflow: classic, prompt: 'slow', count: 2 });
    const [a, b] = run.json.jobs;
    await until(async () => { const x = await job(a.id), y = await job(b.id); return x.comfyId && y.comfyId; }, 10000, 'both queued');
    const rb = await job(b.id);
    await api('POST', `/api/comfy/jobs/${b.id}/stop`, {});
    await api('POST', `/api/comfy/jobs/${a.id}/stop`, {});
    const [ja, jb] = [await finished(a.id), await finished(b.id)];
    assert.equal(ja.status, 'cancelled'); assert.equal(jb.status, 'cancelled');
    assert.ok(mock.state.queueDeletes.includes(rb.comfyId), 'pending job should be removed from ComfyUI queue');
    assert.ok(mock.state.interrupts >= 1, 'running job should be interrupted');
    await until(() => !mock.state.running && !mock.state.pending.length, 10000, 'mock idle');
  });

  await test('free VRAM calls ComfyUI', async () => {
    const r = await api('POST', '/api/comfy/free', {});
    assert.equal(r.status, 200);
    assert.equal(mock.state.frees, 1);
  });

  await test('access token: sent to ComfyUI, never returned to the browser', async () => {
    const secured = await createMockComfy(28190, { token: 's3cret' });
    let r = await api('POST', '/api/comfy/config', { url: secured.url });
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /HTTP 401/);
    r = await api('POST', '/api/comfy/config', { token: 's3cret' });
    assert.equal(r.json.ok, true);
    assert.ok(secured.state.authSeen.includes('Bearer s3cret'));
    const cfg = (await api('GET', '/api/config')).json;
    assert.equal(cfg.comfy.token, '');
    assert.equal(cfg.comfy.hasToken, true);
    assert.ok(!JSON.stringify(cfg).includes('s3cret'));
    await api('POST', '/api/comfy/config', { clearToken: true, url: mock.url });
    await secured.close();
    assert.equal((await api('GET', '/api/comfy/status')).json.ok, true);
  });

  await test('gallery: delete removes the record and the files; restart marks running jobs interrupted', async () => {
    const all = await jobs();
    const done = all.find((j) => j.status === 'done');
    const file = path.join(tmp, 'outputs', 'comfy', done.files[0].file);
    assert.ok(fs.existsSync(file));
    assert.equal((await api('DELETE', '/api/comfy/jobs/' + done.id)).json.ok, true);
    assert.ok(!fs.existsSync(file));
    fs.writeFileSync(path.join(tmp, 'outputs', 'comfy', 'czombie.json'), JSON.stringify({ id: 'czombie', created: 1, status: 'running', files: [], note: 'x' }));
    comfy.markStale();
    const z = (await jobs()).find((j) => j.id === 'czombie');
    assert.equal(z.status, 'error'); assert.match(z.error, /Interrupted/);
  });

  await test('static files: path tricks cannot escape the comfy outputs folder', async () => {
    for (const bad of ['..%2Fconfig.json', '..%2F..%2Fconfig.json', 'czombie.json']) {
      const r = await fetch(BASE + '/outputs/comfy/' + bad);
      assert.ok([403, 404].includes(r.status), bad + ' -> ' + r.status);
    }
  });

  await test('analysis: Flux-style zeroed negative, Wan 2.2 two-sampler graphs, missing save node', () => {
    const flux = comfy.analyze({
      1: { class_type: 'CLIPTextEncode', inputs: { text: 'p', clip: ['9', 0] } },
      2: { class_type: 'FluxGuidance', inputs: { conditioning: ['1', 0], guidance: 3.5 } },
      3: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['1', 0] } },
      4: { class_type: 'KSampler', inputs: { model: ['9', 0], seed: 1, steps: 20, cfg: 1, positive: ['2', 0], negative: ['3', 0], latent_image: ['9', 0] } },
      5: { class_type: 'SaveImage', inputs: { images: ['4', 0] } },
    });
    assert.equal(flux.bindings.prompt[0].node, '1');
    assert.equal(flux.bindings.negative, undefined, 'a zeroed negative has nothing to type');
    const wan22 = comfy.analyze({
      1: { class_type: 'CLIPTextEncode', inputs: { text: 'p', clip: ['9', 0] } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: 'n', clip: ['9', 0] } },
      3: { class_type: 'KSamplerAdvanced', inputs: { model: ['9', 0], noise_seed: 1, steps: 20, cfg: 3, positive: ['1', 0], negative: ['2', 0], latent_image: ['9', 0] } },
      4: { class_type: 'KSamplerAdvanced', inputs: { model: ['9', 0], noise_seed: 1, steps: 20, cfg: 3, positive: ['1', 0], negative: ['2', 0], latent_image: ['3', 0] } },
      5: { class_type: 'SaveVideo', inputs: { video: ['4', 0] } },
    });
    assert.equal(wan22.bindings.seed.length, 2, 'both samplers get the same seed');
    assert.equal(wan22.bindings.steps, undefined, 'steps are left alone when two samplers split them');
    assert.equal(wan22.kind, 'video');
    const none = comfy.analyze({ 1: { class_type: 'KSampler', inputs: { seed: 1 } } });
    assert.ok(none.warnings.some((w) => /No Save/.test(w)));
    assert.ok(none.warnings.some((w) => /No prompt/.test(w)));
  });

  await test('apply: sizes snap to multiples of 8 within limits, blank seed is random, input is not mutated', () => {
    const g = classicGraph('a.safetensors');
    const b = comfy.analyze(g).bindings;
    const out = comfy.apply(g, b, { prompt: 'hi', width: 99999, height: '1001', seed: '', steps: 0, cfg: '7' });
    const lat = out[4].inputs, ks = out[5].inputs;
    assert.equal(lat.width, 4096); assert.equal(lat.height, 1000);
    assert.equal(ks.steps, 1); assert.equal(ks.cfg, 7);
    assert.ok(Number.isInteger(ks.seed) && ks.seed >= 0 && ks.seed !== 5);
    assert.equal(g[4].inputs.width, 640, 'the stored workflow must not change');
  });

  await test('prompt reuse: a different run keeps its own record with prompt and workflow name', async () => {
    const r = await api('POST', '/api/comfy/generate', { workflow: classic, prompt: 'remember me' });
    const j = await finished(r.json.jobs[0].id);
    assert.equal(j.prompt, 'remember me');
    assert.equal(j.workflowName, 'v1-5-pruned-emaonly');
    assert.ok(j.seconds >= 0);
  });

  await test('errors: ComfyUI going away mid-use gives a readable error, not a crash', async () => {
    await mock.close();
    const s = (await api('GET', '/api/comfy/status')).json;
    assert.equal(s.ok, false);
    const r = await api('POST', '/api/comfy/generate', { workflow: classic, prompt: 'x' });
    assert.ok([200, 202, 400, 404, 502].includes(r.status));
    if (r.status === 202) assert.equal((await finished(r.json.jobs[0].id)).status, 'error');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  server.close();
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
