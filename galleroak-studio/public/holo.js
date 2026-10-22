'use strict';
/**
 * Holo: zero-dependency 3D hologram faces, drawn on a plain 2D canvas.
 *
 * Each face is a small 3D model (a lathe-style head with a brow, nose, lips and chin, horns, hair strands, eyes, a neck and
 * shoulders) that is rotated, jaw-animated and projected by hand every frame, then drawn as glowing contour lines.
 * The persona's sign (its emblem) floats at the voice box and pulses with whatever is being said or heard.
 *
 *   Holo.createFace(canvas, persona, opts) -> controller
 *       controller.setState('idle' | 'listening' | 'thinking' | 'speaking')
 *       controller.levelOut = () => 0..1      how loud the face is speaking (drives jaw + sign)
 *       controller.levelIn  = () => 0..1      how loud the user is (drives the listening ripples)
 *       controller.setPersona(p), controller.destroy()
 *   Holo.avatar(persona, px) -> data URL of a small still head (cached)
 *   Holo.autoPersona(name)   -> a stable generated persona for any combo that has none
 *   Holo.drawSign(ctx, sign, cx, cy, r, color, alpha)  flat emblem for badges and pickers
 */
(function () {
  const TAU = Math.PI * 2;
  const D2R = Math.PI / 180;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  function rng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const hex2rgb = (h) => { const n = parseInt(String(h).slice(1), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const mix = (c, d, t) => [lerp(c[0], d[0], t), lerp(c[1], d[1], t), lerp(c[2], d[2], t)];
  const WHITE = [255, 255, 255];

  /* ------------------------------------------------------------------ signs ------------------------------------------------------------------ */
  const pol = (r, deg) => [r * Math.cos(deg * D2R), r * Math.sin(deg * D2R)];
  function arc(cx, cy, r, a0, a1, n) {
    n = n || Math.max(8, Math.round(Math.abs(a1 - a0) / 8));
    const p = [];
    for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * D2R; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return p;
  }
  const circle = (cx, cy, r) => arc(cx, cy, r, 0, 360, 40);
  const closed = (pts) => [...pts, pts[0]];

  /** Each sign is a list of polylines in a -1..1 box (y up). */
  const SIGN_DEFS = {
    target: () => {
      const o = [];
      for (let k = 0; k < 4; k++) o.push(arc(0, 0, 0.92, k * 90 + 16, k * 90 + 74));
      o.push(circle(0, 0, 0.58), circle(0, 0, 0.13));
      for (let k = 0; k < 4; k++) o.push([pol(0.58, k * 90), pol(0.3, k * 90)]);
      for (let k = 0; k < 4; k++) o.push([pol(1.0, k * 90 + 45), pol(1.1, k * 90 + 45)]);
      return o;
    },
    split: () => [arc(0, 0, 0.9, 104, 436), [[0, 1.02], [0, 0.3]], circle(0, -0.14, 0.2), arc(0, -0.14, 0.46, 205, 335)],
    eye: () => [
      closed([[-1, 0], [0, 0.72], [1, 0], [0, -0.72]]), circle(0, 0, 0.3), circle(0, 0, 0.1),
      [[-0.3, 0.9], [0, 1.02], [0.3, 0.9]], [[-0.3, -0.9], [0, -1.02], [0.3, -0.9]],
    ],
    star: () => {
      const o = [closed([[0, 1], [0.2, 0.2], [1, 0], [0.2, -0.2], [0, -1], [-0.2, -0.2], [-1, 0], [-0.2, 0.2]]), circle(0, 0, 0.3), circle(0, 0, 0.07)];
      for (let k = 0; k < 4; k++) o.push([pol(0.55, k * 90 + 45), pol(0.78, k * 90 + 45)]);
      return o;
    },
    aperture: () => {
      const o = [circle(0, 0, 0.94)];
      const hex = [...Array(6)].map((_, k) => pol(0.34, 60 * k + 30));
      o.push(closed(hex));
      for (let k = 0; k < 6; k++) {
        // each blade edge runs along a side of the opening out to the ring, like a camera iris
        const v = hex[k], w = hex[(k + 1) % 6];
        const dx = w[0] - v[0], dy = w[1] - v[1], L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
        const vu = v[0] * ux + v[1] * uy;
        const t = vu + Math.sqrt(vu * vu - (v[0] * v[0] + v[1] * v[1]) + 0.94 * 0.94);
        o.push([v, [v[0] - t * ux, v[1] - t * uy]]);
      }
      return o;
    },
    hex: () => [closed([...Array(6)].map((_, k) => pol(0.96, 60 * k))), closed([...Array(3)].map((_, k) => pol(0.5, 90 + 120 * k))), circle(0, 0, 0.1)],
    triad: () => {
      const tri = [...Array(3)].map((_, k) => pol(0.98, 90 + 120 * k));
      return [closed(tri), circle(0, -0.08, 0.14), ...tri.map((p) => [[p[0] * 0.8, p[1] * 0.8 - 0.06], [p[0] * 0.45, p[1] * 0.45 - 0.06]])];
    },
    wave: () => [circle(-0.62, 0, 0.1), arc(-0.62, 0, 0.42, -55, 55), arc(-0.62, 0, 0.74, -55, 55), arc(-0.62, 0, 1.06, -55, 55)],
    crescent: () => [[...arc(0, 0, 0.95, 62, 298), ...arc(0.34, 0, 0.72, 288, 72).slice(1)], circle(0.52, 0, 0.1)],
  };
  const SIGN_CACHE = {};
  function signPolys(name) {
    return SIGN_CACHE[name] || (SIGN_CACHE[name] = (SIGN_DEFS[name] || SIGN_DEFS.target)());
  }
  const SIGN_NAMES = Object.keys(SIGN_DEFS);

  /** Flat sign for badges, pickers and cards. */
  function drawSign(ctx, sign, cx, cy, r, color, alpha, lw, rot) {
    const c = hex2rgb(color);
    const cs = Math.cos(rot || 0), sn = Math.sin(rot || 0);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(c, alpha === undefined ? 1 : alpha);
    ctx.lineWidth = lw || Math.max(1, r / 14);
    for (const line of signPolys(sign)) {
      ctx.beginPath();
      line.forEach((p, i) => {
        const x = cx + (p[0] * cs - p[1] * sn) * r, y = cy - (p[0] * sn + p[1] * cs) * r;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ----------------------------------------------------------------- head model ----------------------------------------------------------------- */
  const YMIN = -1.02, YC = 0.3, RY = 0.87, YMAX = YC + RY * 0.9995, ZC = -0.06;
  const JAW_PY = -0.05, JAW_PZ = -0.25; // the jaw hinges here (near the ears)

  const ell = (y, h) => { const u = (y - YC) / RY; return u <= -1 || u >= 1 ? 0 : h * Math.sqrt(1 - u * u); };
  function halfWidth(y, f) {
    const Y1 = -0.12;
    if (y >= Y1) return ell(y, f.headW);
    const w1 = ell(Y1, f.headW), k = 1 - f.jaw / w1, p = (Y1 - y) / (Y1 - YMIN);
    return w1 * (1 - k * Math.pow(clamp(p, 0, 1), 1.5));
  }
  function halfDepth(y, f) {
    const Y1 = -0.12, H = 0.92;
    if (y >= Y1) return ell(y, H);
    const d1 = ell(Y1, H), k = 1 - 0.4 / d1, p = (Y1 - y) / (Y1 - YMIN);
    return d1 * (1 - k * Math.pow(clamp(p, 0, 1), 1.3));
  }

  function faceBumps(f) {
    const B = [];
    const pair = (x, y, a, sx, sy) => { B.push([x, y, a, sx, sy]); if (x !== 0) B.push([-x, y, a, sx, sy]); };
    B.push([0, 0.3, f.brow * 0.8, 0.18, 0.06]); // between the brows
    pair(0.28, 0.3, f.brow, 0.22, 0.05); // brow ridge
    pair(0.3, 0.17, -0.05, 0.13, 0.07); // eye sockets
    B.push([0, 0.04, f.nose * 0.7, 0.07, 0.22]); // nose bridge
    B.push([0, -0.24, f.nose, 0.11, 0.09]); // nose tip
    pair(0.12, -0.3, f.nose * 0.45, 0.07, 0.06); // nostrils
    pair(0.45, -0.08, f.cheek, 0.15, 0.12); // cheekbones
    pair(0.42, -0.42, -f.cheek * 0.6, 0.14, 0.15); // cheek hollows
    B.push([0, -0.52, f.lips, 0.16, 0.035]); // upper lip
    B.push([0, -0.64, f.lips * 1.1, 0.14, 0.04]); // lower lip
    B.push([0, -0.88, 0.09, 0.16, 0.1]); // chin
    return B;
  }
  function bumpZ(x, y, B) {
    let z = 0;
    for (let i = 0; i < B.length; i++) {
      const b = B[i], dx = (x - b[0]) / b[3], dy = (y - b[1]) / b[4], e = dx * dx + dy * dy;
      if (e < 9) z += b[2] * Math.exp(-0.5 * e);
    }
    return z;
  }
  const surfZ = (x, y, f, B) => {
    const w = halfWidth(y, f), d = halfDepth(y, f), r = clamp(x / w, -0.999, 0.999);
    return ZC + d * Math.sqrt(1 - r * r) + bumpZ(x, y, B);
  };
  const jawWeightY = (y) => smooth(-0.56, -0.6, y);

  function skullPoint(th, y, off, f) {
    y = clamp(y, YMIN, YMAX);
    const w = halfWidth(y, f) + off, d = halfDepth(y, f) + off;
    return [w * Math.sin(th), y, ZC + d * Math.cos(th)];
  }
  function keyStrand(keys, m, f) {
    const pts = new Float32Array(m * 3);
    for (let k = 0; k < m; k++) {
      const t = (k / (m - 1)) * (keys.length - 1), i = Math.min(keys.length - 2, Math.floor(t)), fr = smooth(0, 1, t - i);
      const a = keys[i], b = keys[i + 1];
      const p = skullPoint(lerp(a[0], b[0], fr), lerp(a[1], b[1], fr), lerp(a[2], b[2], fr), f);
      pts[k * 3] = p[0]; pts[k * 3 + 1] = p[1]; pts[k * 3 + 2] = p[2];
    }
    return pts;
  }

  function buildHair(f) {
    const out = [];
    const r = rng(f.seed * 7919 + 13);
    const st = f.hair;
    if (st === 'swept') {
      for (let i = 0; i < 70; i++) {
        const th = lerp(-1.4, 1.4, r()), dir = th < 0 ? -1 : 1, y0 = 0.8 + 0.16 * Math.cos(th) + r() * 0.05;
        out.push(keyStrand([[th, y0, 0.015], [th, 1.08, 0.08], [lerp(th, dir * 3.0, 0.7), 0.95, 0.13], [dir * (3.0 - r() * 0.3), 0.5 - r() * 0.3, 0.26 + r() * 0.1]], 9, f));
      }
    } else if (st === 'long') {
      for (let i = 0; i < 64; i++) {
        const dir = r() < 0.5 ? -1 : 1, th = dir * lerp(0.55, 3.0, r()), sway = (r() - 0.5) * 0.25;
        out.push(keyStrand([[th, 0.9, 0.02], [th + sway, 0.35, 0.1], [th + sway * 1.6, -0.6, 0.22], [th + sway * 2, -1.7 - r() * 0.5, 0.34 + r() * 0.12]], 10, f));
      }
    } else if (st === 'spiky') {
      for (let i = 0; i < 64; i++) {
        const th = r() * TAU - Math.PI, y = 0.5 + r() * 0.62;
        if (Math.abs(th) < 1.0 && y < 0.85) continue;
        const b = skullPoint(th, y, 0.02, f), len = 0.3 + r() * 0.42;
        const nx = Math.sin(th), nz = Math.cos(th), jit = (r() - 0.5) * 0.18;
        const tip = [b[0] + (nx * 0.55 + jit) * len, b[1] + len * (0.55 + 0.5 * smooth(0.4, 1.1, y)), b[2] + (nz * 0.55 + jit) * len];
        const mid = [(b[0] + tip[0]) / 2 + jit * 0.2, (b[1] + tip[1]) / 2, (b[2] + tip[2]) / 2];
        out.push(new Float32Array([...b, ...mid, ...tip]));
      }
    } else if (st === 'side') {
      for (let i = 0; i < 36; i++) {
        const th0 = lerp(-0.2, 1.0, r()), j = r();
        out.push(keyStrand([[th0, 1.12, 0.06], [th0 - 0.6, 0.97, 0.08], [-0.8 - 0.5 * j, 0.66 + 0.1 * j, 0.1], [-1.15 - 0.5 * j, 0.4 + 0.15 * j, 0.12]], 9, f));
      }
      for (let i = 0; i < 24; i++) {
        const dir = r() < 0.5 ? -1 : 1, th = dir * lerp(1.4, 3.1, r());
        out.push(keyStrand([[th, 0.95, 0.03], [th, 0.55, 0.1], [th, 0.05, 0.14]], 7, f));
      }
    } else if (st === 'crop') {
      for (let i = 0; i < 70; i++) {
        const th = r() * TAU - Math.PI, y0 = (Math.abs(th) < 1 ? 0.86 : 0.55) + r() * 0.3;
        out.push(keyStrand([[th, y0, 0.012], [th, Math.min(YMAX, y0 + 0.14 + r() * 0.1), 0.05]], 4, f));
      }
    }
    return out;
  }

  const HORN_CURVES = {
    sweep: [[0.52, 0.75, 0.0], [1.05, 0.95, -0.1], [1.35, 1.45, -0.35], [1.05, 1.95, -0.6]],
    twin: [[0.45, 0.85, 0.1], [0.62, 1.3, 0.12], [0.5, 1.75, 0.0], [0.28, 1.98, -0.2]],
    ridge: [[0.46, 0.8, 0.12], [0.68, 0.98, 0.1], [0.8, 1.2, -0.02], [0.76, 1.42, -0.2]],
  };
  const bez = (P, t) => {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [a * P[0][0] + b * P[1][0] + c * P[2][0] + d * P[3][0], a * P[0][1] + b * P[1][1] + c * P[2][1] + d * P[3][1], a * P[0][2] + b * P[1][2] + c * P[2][2] + d * P[3][2]];
  };
  function hornTube(P, r0, m, seg) {
    // rings along the curve plus four long lines; returned as polylines (Float32Array of xyz)
    const C = [];
    for (let k = 0; k < m; k++) C.push(bez(P, k / (m - 1)));
    const lines = [];
    const ringsPts = [];
    for (let k = 0; k < m; k++) {
      const a = C[Math.max(0, k - 1)], b = C[Math.min(m - 1, k + 1)];
      let T = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const L = Math.hypot(...T); T = T.map((v) => v / L);
      const ref = Math.abs(T[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      let N = [T[1] * ref[2] - T[2] * ref[1], T[2] * ref[0] - T[0] * ref[2], T[0] * ref[1] - T[1] * ref[0]];
      const nl = Math.hypot(...N); N = N.map((v) => v / nl);
      const B = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
      const rad = r0 * Math.pow(1 - k / (m - 1), 0.85) + 0.008;
      const ring = new Float32Array((seg + 1) * 3);
      for (let i = 0; i <= seg; i++) {
        const an = (i / seg) * TAU, c = Math.cos(an) * rad, s = Math.sin(an) * rad;
        ring[i * 3] = C[k][0] + N[0] * c + B[0] * s; ring[i * 3 + 1] = C[k][1] + N[1] * c + B[1] * s; ring[i * 3 + 2] = C[k][2] + N[2] * c + B[2] * s;
      }
      ringsPts.push(ring);
      if (k % 2 === 0 || k === m - 1) lines.push(ring);
    }
    for (let i = 0; i < seg; i += seg / 4) {
      const lp = new Float32Array(m * 3);
      for (let k = 0; k < m; k++) { lp[k * 3] = ringsPts[k][i * 3]; lp[k * 3 + 1] = ringsPts[k][i * 3 + 1]; lp[k * 3 + 2] = ringsPts[k][i * 3 + 2]; }
      lines.push(lp);
    }
    return lines;
  }
  function buildHorns(f) {
    const out = [];
    const mirror = (P, s) => P.map((p) => [p[0] * s, p[1], p[2]]);
    const add = (style, s, r0, trim) => {
      let P = mirror(HORN_CURVES[style], s);
      if (trim) { // a broken horn: only the first part of the curve
        const parts = [];
        for (let k = 0; k <= 3; k++) parts.push(bez(P, (k / 3) * trim));
        P = parts;
      }
      out.push(...hornTube(P, r0, trim ? 8 : 14, 8));
    };
    switch (f.horns) {
      case 'sweep': add('sweep', 1, 0.15); add('sweep', -1, 0.15); break;
      case 'twin': add('twin', 1, 0.12); add('twin', -1, 0.12); break;
      case 'ridge': add('ridge', 1, 0.12); add('ridge', -1, 0.12); break;
      case 'single': add('sweep', 1, 0.14); add('ridge', -1, 0.12, 0.5); break;
      case 'crown': {
        for (const s of [-1, 1]) for (const [bx, by, tx, ty] of [[0.3, 1.0, 0.5, 1.7], [0.55, 0.9, 0.95, 1.5], [0.15, 1.08, 0.2, 1.85]]) {
          const P = [[bx * s, by, 0.05], [bx * s + 0.05 * s, by + (ty - by) * 0.4, 0.05], [tx * s - 0.1 * s, by + (ty - by) * 0.75, -0.02], [tx * s, ty, -0.08]];
          out.push(...hornTube(P, 0.07, 9, 8));
        }
        break;
      }
      default: break;
    }
    return out;
  }

  function buildModel(f, detail) {
    const R = detail === 'high' ? 58 : 28, S = detail === 'high' ? 76 : 40, n = R * S;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), jaw = new Float32Array(n), ringY = new Float32Array(R);
    const B = faceBumps(f);
    for (let j = 0; j < R; j++) {
      const y = YMIN + ((YMAX - YMIN) * j) / (R - 1), w = halfWidth(y, f), d = halfDepth(y, f);
      const h = 0.01, dwdy = (halfWidth(y + h, f) - halfWidth(y - h, f)) / (2 * h);
      ringY[j] = y;
      for (let i = 0; i < S; i++) {
        const th = -Math.PI + (TAU * i) / S, sx = Math.sin(th), cz = Math.cos(th), k = j * S + i;
        const x = w * sx;
        let z = ZC + d * cz;
        z += bumpZ(x, y, B) * smooth(-0.15, 0.55, cz);
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        let nx = sx / Math.max(0.05, w), ny = -dwdy, nz = cz / Math.max(0.05, d);
        const nl = Math.hypot(nx, ny, nz) || 1;
        nor[k * 3] = nx / nl; nor[k * 3 + 1] = ny / nl; nor[k * 3 + 2] = nz / nl;
        jaw[k] = jawWeightY(y) * smooth(-0.9, 0.1, cz);
      }
    }
    const P3 = (x, y, off) => [x, y, surfZ(x, y, f, B) + (off === undefined ? 0.014 : off)];
    const feat = (pts, jw) => ({ pts: Float32Array.from(pts.flat()), n: pts.length, jaw: jw });
    // brows
    const slant = f.eyes === 'sharp' ? 0.1 : f.eyes === 'wide' ? 0.04 : 0.025;
    const brows = [];
    for (const s of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 8; i++) { const x = 0.08 + (0.44 * i) / 8; pts.push(P3(s * x, 0.3 + slant * (x - 0.08) / 0.44 + 0.02 * Math.sin((i / 8) * Math.PI) * (f.eyes === 'wide' ? 1.6 : 0.6), 0.02)); }
      brows.push(feat(pts, 0));
    }
    // nose
    const nose = [];
    nose.push(feat([-0.13, -0.06, 0, 0.06, 0.13].map((x, i) => P3(x, [-0.3, -0.345, -0.335, -0.345, -0.3][i], 0.03)), 0));
    for (const s of [-1, 1]) nose.push(feat([[0.06, 0.22], [0.075, 0.05], [0.09, -0.12], [0.13, -0.28]].map(([x, y]) => P3(s * x, y, 0.02)), 0));
    // mouth: upper and lower lip edges share the corners; the lower one moves with the jaw
    const mu = [], ml = [];
    for (let i = 0; i <= 10; i++) {
      const x = -0.19 + (0.38 * i) / 10, e = (x / 0.19) * (x / 0.19);
      const yc = -0.575 + f.smile * 0.045 * e - 0.01 * (1 - e) * 0;
      mu.push(P3(x, yc + 0.004 - 0.01 * (1 - e), 0.03));
      ml.push(P3(x, yc - 0.004 - 0.012 * (1 - e) * 0.2, 0.03));
    }
    const mouthU = feat(mu, 0), mouthL = feat(ml, 1);
    // ears
    const ears = [];
    for (const s of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const a = (i / 12) * TAU, y = 0.02 + 0.2 * Math.sin(a), zz = -0.15 + 0.12 * Math.cos(a), w = halfWidth(0.02, f);
        pts.push([s * (w + 0.02 + 0.07 * (1 - Math.cos(a)) / 2), y, zz]);
      }
      ears.push(feat(pts, 0));
    }
    // scar across the left eye, headphones, gem
    let scar = null;
    if (f.extras.includes('scar')) scar = feat([[-0.4, 0.58], [-0.36, 0.38], [-0.32, 0.18], [-0.29, -0.02], [-0.27, -0.16]].map(([x, y]) => P3(x, y, 0.025)), 0);
    const cups = [];
    let band = null;
    if (f.extras.includes('headphones')) {
      for (const s of [-1, 1]) for (const r of [0.3, 0.21, 0.1]) {
        const pts = [];
        for (let i = 0; i <= 24; i++) { const a = (i / 24) * TAU; pts.push([s * (halfWidth(0.05, f) + 0.07), 0.05 + r * Math.sin(a), -0.12 + r * Math.cos(a)]); }
        cups.push(feat(pts, 0));
      }
      const bp = [];
      for (let i = 0; i <= 20; i++) { const a = (i / 20) * Math.PI; bp.push([Math.cos(a) * (halfWidth(0.05, f) + 0.07) * -1, 0.3 + 0.98 * Math.sin(a) * 0.85 + 0.0, -0.12]); }
      band = feat(bp, 0);
    }
    const gem = f.extras.includes('gem') ? P3(0, 0.64, 0.025) : null;
    const eyeZ = (x, y) => surfZ(x, y, f, B) + 0.022;
    return { R, S, n, pos, nor, jaw, ringY, brows, nose, mouthU, mouthL, ears, scar, cups, band, gem, eyeZ, hair: buildHair(f), horns: buildHorns(f) };
  }

  const MODELS = new Map();
  function getModel(f, detail) {
    const key = detail + JSON.stringify(f);
    if (!MODELS.has(key)) {
      if (MODELS.size > 40) MODELS.delete(MODELS.keys().next().value);
      MODELS.set(key, buildModel(f, detail));
    }
    return MODELS.get(key);
  }

  /* neck and shoulders */
  function buildBody(detail) {
    const K = detail === 'high' ? 16 : 8, S = detail === 'high' ? 44 : 24;
    const pos = new Float32Array(K * S * 3), alpha = new Float32Array(K);
    for (let j = 0; j < K; j++) {
      const y = -0.95 - (1.5 * j) / (K - 1), sh = smooth(-1.5, -2.35, y);
      const wx = 0.33 + 1.42 * Math.pow(sh, 1.15), wz = 0.29 + 0.5 * sh, zc = -0.05 - 0.1 * sh;
      alpha[j] = smooth(-2.5, -1.9, y);
      for (let i = 0; i < S; i++) {
        const th = -Math.PI + (TAU * i) / S;
        pos[(j * S + i) * 3] = wx * Math.sin(th); pos[(j * S + i) * 3 + 1] = y; pos[(j * S + i) * 3 + 2] = zc + wz * Math.cos(th);
      }
    }
    return { K, S, pos, alpha };
  }
  const BODIES = {};

  /* ------------------------------------------------------------------ the face ------------------------------------------------------------------ */
  function rotM(yaw, pitch, roll) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    const a = [cy, 0, sy, sp * sy, cp, -sp * cy, -cp * sy, sp, cp * cy];
    return [cr * a[0] - sr * a[3], cr * a[1] - sr * a[4], cr * a[2] - sr * a[5], sr * a[0] + cr * a[3], sr * a[1] + cr * a[4], sr * a[2] + cr * a[5], a[6], a[7], a[8]];
  }

  const NB = 8; // alpha buckets, so a whole layer is a handful of stroke calls
  const CAM_D = 6;
  const ACTIVE = new Set();
  let rafId = 0;
  function ticker(t) {
    rafId = 0;
    if (!ACTIVE.size) return;
    for (const c of ACTIVE) c._tick(t);
    rafId = requestAnimationFrame(ticker);
  }
  function startTicker() { if (!rafId && ACTIVE.size) rafId = requestAnimationFrame(ticker); }

  function reducedMotion() {
    if (window.Holo && window.Holo.still === true) return true;
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches && !(window.Holo && window.Holo.still === false); } catch { return false; }
  }

  function createFace(canvas, persona, options) {
    const opts = Object.assign({ detail: 'high', glow: true, fps: 60, interactive: true, camera: 'bust', static: false }, options || {});
    const still = !opts.static && reducedMotion(); // reduced motion: draw a calm still face and redraw only when its state changes
    if (still) opts.static = true;
    const ctx = canvas.getContext('2d');
    const ctl = { state: 'idle', levelOut: null, levelIn: null };
    const head = opts.camera === 'head';
    let model, body, col, hi, signName, W = 0, H = 0, dpr = 1, ppu = 1, cx = 0, cy = 0, wy0 = 0;
    let yaw = 0, pitch = 0, roll = 0, yawT = 0, pitchT = 0, lvOut = 0, lvIn = 0, openAmt = 0;
    let t0 = 0, last = 0, lastDraw = 0, blink = 0, nextBlink = 2 + Math.random() * 3, glitch = 0, nextGlitch = 5 + Math.random() * 6;
    let rippleAt = 0, ripples = [], paused = false, pose = null;
    const rand = Math.random;

    const verts = { sx: null, sy: null, nz: null, rz: null };
    const buckets = Array.from({ length: NB }, () => []);

    function setPersona(p) {
      persona = p;
      col = hex2rgb(p.color || '#58e6c1');
      hi = mix(col, WHITE, 0.55);
      signName = p.sign || 'target';
      model = getModel(Object.assign({ seed: 1, headW: 0.8, jaw: 0.22, cheek: 0.08, brow: 0.06, nose: 0.2, lips: 0.07, smile: 0, eyes: 'sharp', horns: 'sweep', hair: 'none', extras: [] }, p.face || {}), opts.detail);
      body = BODIES[opts.detail] || (BODIES[opts.detail] = buildBody(opts.detail));
      verts.sx = new Float32Array(model.n); verts.sy = new Float32Array(model.n); verts.nz = new Float32Array(model.n); verts.rz = new Float32Array(model.n);
    }

    function layout() {
      const r = canvas.getBoundingClientRect();
      const cw = Math.max(40, Math.round(r.width || canvas.width || 300)), ch = Math.max(40, Math.round(r.height || canvas.height || 300));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
      W = cw; H = ch;
      if (head) { // just the head and horns, for avatars
        const top = persona && persona.face && persona.face.horns !== 'none' ? 2.0 : 1.35, bottom = -1.15;
        ppu = Math.min(H / (top - bottom) * 0.96, W / 3.1);
        wy0 = (top + bottom) / 2; cx = W / 2; cy = H / 2;
      } else {
        const top = 2.2, bottom = -2.55;
        ppu = Math.min((H * 0.95) / (top - bottom), W / 3.9);
        wy0 = (top + bottom) / 2 - 0.05; cx = W / 2; cy = H / 2;
      }
    }

    /* ---- drawing helpers ---- */
    const flush = (color, lw, aMax, glowToo) => {
      for (let b = 0; b < NB; b++) {
        const arr = buckets[b];
        if (!arr.length) continue;
        const a = ((b + 1) / NB) * aMax;
        ctx.beginPath();
        for (let k = 0; k < arr.length; k += 4) { ctx.moveTo(arr[k], arr[k + 1]); ctx.lineTo(arr[k + 2], arr[k + 3]); }
        if (glowToo && opts.glow) { ctx.globalAlpha = a * 0.22; ctx.lineWidth = lw * 3.4; ctx.strokeStyle = rgba(color, 1); ctx.stroke(); }
        ctx.globalAlpha = a; ctx.lineWidth = lw; ctx.strokeStyle = rgba(color, 1); ctx.stroke();
        arr.length = 0;
      }
    };
    const seg = (x1, y1, x2, y2, a) => { const b = clamp(Math.floor(a * NB), 0, NB - 1); const arr = buckets[b]; arr.push(x1, y1, x2, y2); };

    /** Project a list of model-space xyz points with a rotation about a pivot; returns screen xy + rotated z. */
    const xf = (M, pv, src, n, out, jawArr, jawA) => {
      for (let k = 0; k < n; k++) {
        let x = src[k * 3], y = src[k * 3 + 1], z = src[k * 3 + 2];
        if (jawA && jawArr && jawArr[k] > 0) {
          const a = jawA * jawArr[k], dy = y - JAW_PY, dz = z - JAW_PZ, c = 1 - (a * a) / 2;
          y = JAW_PY + dy * c - dz * a; z = JAW_PZ + dy * a + dz * c;
        }
        x -= pv[0]; y -= pv[1]; z -= pv[2];
        const X = M[0] * x + M[1] * y + M[2] * z + pv[0], Y = M[3] * x + M[4] * y + M[5] * z + pv[1], Z = M[6] * x + M[7] * y + M[8] * z + pv[2];
        const s = (ppu * CAM_D) / (CAM_D - Z);
        out[k * 3] = cx + X * s; out[k * 3 + 1] = cy - (Y - wy0) * s; out[k * 3 + 2] = Z;
      }
    };
    const P = new Float32Array(3);
    const proj = (M, pv, x, y, z) => {
      x -= pv[0]; y -= pv[1]; z -= pv[2];
      const X = M[0] * x + M[1] * y + M[2] * z + pv[0], Y = M[3] * x + M[4] * y + M[5] * z + pv[1], Z = M[6] * x + M[7] * y + M[8] * z + pv[2];
      const s = (ppu * CAM_D) / (CAM_D - Z);
      P[0] = cx + X * s; P[1] = cy - (Y - wy0) * s; P[2] = Z;
      return s;
    };
    const polyline = (arr, n, a, lw, color) => {
      ctx.beginPath();
      for (let k = 0; k < n; k++) { const x = arr[k * 3], y = arr[k * 3 + 1]; if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.globalAlpha = a; ctx.lineWidth = lw; ctx.strokeStyle = rgba(color, 1);
      if (opts.glow) { ctx.globalAlpha = a * 0.25; ctx.lineWidth = lw * 3.2; ctx.stroke(); ctx.globalAlpha = a; ctx.lineWidth = lw; }
      ctx.stroke();
    };
    const tmp = new Float32Array(3 * 80);

    function render(t) {
      const time = (t - t0) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';

      const st = ctl.state;
      const speaking = st === 'speaking', listening = st === 'listening', thinking = st === 'thinking';
      const M = rotM(yaw, pitch, roll);
      const MB = rotM(yaw * 0.35, pitch * 0.2, roll * 0.3);
      const PVH = [0, -1.1, -0.1], PVB = [0, -2.4, 0];
      const ID = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const jawA = openAmt * 0.23;
      const lw = opts.detail === 'high' ? 1.1 : 0.9;
      const sweepY = YMIN + (YMAX - YMIN) * ((time * (thinking ? 0.5 : 0.17)) % 1);
      const flick = 0.93 + 0.07 * Math.sin(time * 37) * Math.sin(time * 11.3);

      /* emitter + beam (behind everything) */
      if (!head) {
        const ey = cy + (wy0 + 2.45) * ppu * 0.99, ex = W / 2, rx = ppu * 1.55;
        const g = ctx.createLinearGradient(0, ey, 0, cy - ppu * 1.2);
        g.addColorStop(0, rgba(col, 0.20)); g.addColorStop(1, rgba(col, 0));
        ctx.globalAlpha = 1; ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(ex - rx * 0.95, ey); ctx.lineTo(ex - ppu * 0.9, cy - ppu * 1.4); ctx.lineTo(ex + ppu * 0.9, cy - ppu * 1.4); ctx.lineTo(ex + rx * 0.95, ey); ctx.closePath(); ctx.fill();
        for (let k = 0; k < 3; k++) {
          const ph = (time * 0.45 + k / 3) % 1, rr = rx * (0.45 + 0.55 * ph);
          ctx.beginPath(); ctx.ellipse(ex, ey, rr, rr * 0.2, 0, 0, TAU); ctx.globalAlpha = (1 - ph) * 0.5; ctx.lineWidth = 1.2; ctx.strokeStyle = rgba(col, 1); ctx.stroke();
        }
        ctx.beginPath(); ctx.ellipse(ex, ey, rx, rx * 0.2, 0, 0, TAU); ctx.globalAlpha = 0.65; ctx.lineWidth = 1.6; ctx.strokeStyle = rgba(hi, 1); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(ex, ey, rx * 0.55, rx * 0.11, 0, 0, TAU); ctx.globalAlpha = 0.35; ctx.stroke();
      }

      /* halo: a ring and two orbs behind the head */
      if (!head) {
        const spin = time * (thinking ? 1.1 : 0.25);
        const MH = rotM(yaw * 0.25, pitch * 0.1, 0);
        const R1 = 1.95, hz = -0.95, hy = 0.5;
        for (let ring = 0; ring < 2; ring++) {
          const r0 = ring ? 1.78 : R1;
          const arcs = ring ? [[0.1, 1.7], [2.2, 3.5], [4.0, 5.6]] : [[0, TAU]];
          for (const [a0, a1] of arcs) {
            ctx.beginPath();
            const stp = Math.max(8, Math.round((a1 - a0) * 12));
            for (let i = 0; i <= stp; i++) {
              const a = a0 + (a1 - a0) * (i / stp) + (ring ? spin : 0);
              proj(MH, [0, 0, 0], r0 * Math.cos(a), hy + r0 * Math.sin(a), hz);
              if (i) ctx.lineTo(P[0], P[1]); else ctx.moveTo(P[0], P[1]);
            }
            ctx.globalAlpha = ring ? 0.4 : 0.7; ctx.strokeStyle = rgba(ring ? col : hi, 1);
            if (opts.glow) { ctx.lineWidth = 6; ctx.globalAlpha = ring ? 0.1 : 0.18; ctx.stroke(); ctx.globalAlpha = ring ? 0.4 : 0.7; }
            ctx.lineWidth = ring ? 1 : 1.8; ctx.stroke();
          }
        }
        for (let o = 0; o < 2; o++) {
          const a = spin * (o ? -1.3 : 1) + o * 2.4 + 0.8;
          const s = proj(MH, [0, 0, 0], R1 * 1.03 * Math.cos(a), hy + R1 * 1.03 * Math.sin(a), hz + (o ? 0.2 : 0));
          const rr = ppu * (o ? 0.1 : 0.17);
          ctx.beginPath(); ctx.arc(P[0], P[1], rr, 0, TAU); ctx.globalAlpha = 0.85; ctx.lineWidth = 1.3; ctx.strokeStyle = rgba(hi, 1); ctx.stroke();
          ctx.beginPath(); ctx.arc(P[0], P[1], rr * 0.45, 0, TAU); ctx.globalAlpha = 0.5; ctx.fillStyle = rgba(col, 1); ctx.fill();
        }
      }

      /* neck + shoulders */
      if (!head) {
        const bpos = body.pos, K = body.K, S = body.S, bs = bufBody(K * S);
        xf(MB, PVB, bpos, K * S, bs);
        for (let j = 0; j < K; j++) {
          const base = body.alpha[j];
          if (base < 0.04) continue;
          for (let i = 0; i < S; i++) {
            const a = j * S + i, b = j * S + ((i + 1) % S);
            const facing = (bs[a * 3 + 2] + bs[b * 3 + 2]) / 2; // z: front is bright
            const al = (0.1 + 0.34 * smooth(-0.6, 0.6, facing)) * base * flick;
            seg(bs[a * 3], bs[a * 3 + 1], bs[b * 3], bs[b * 3 + 1], al);
          }
          if (j + 1 < K) for (let i = 0; i < S; i += 4) {
            const a = j * S + i, b = (j + 1) * S + i;
            seg(bs[a * 3], bs[a * 3 + 1], bs[b * 3], bs[b * 3 + 1], (0.08 + 0.3 * smooth(-0.6, 0.6, bs[a * 3 + 2])) * base * flick);
          }
        }
        flush(col, lw, 1, true);
      }

      /* hair behind / around the head */
      for (const h of model.hair) {
        const n = h.length / 3;
        xf(M, PVH, h, n, tmp);
        for (let k = 0; k < n - 1; k++) {
          const z = (tmp[k * 3 + 2] + tmp[k * 3 + 5]) / 2, taper = 1 - (k / (n - 1)) * 0.35;
          seg(tmp[k * 3], tmp[k * 3 + 1], tmp[k * 3 + 3], tmp[k * 3 + 4], (0.12 + 0.2 * smooth(-1, 1, z)) * taper * flick);
        }
      }
      flush(mix(col, WHITE, 0.2), 0.9, 0.9, false);

      /* the head: contour rings + a few meridians, brighter where the surface faces you and along the rim */
      xfHead(M, PVH, jawA);
      const { R, S: SS } = model;
      const glitchBand = glitch > 0 ? sweepY - 0.3 : 9;
      for (let j = 0; j < R; j++) {
        const y = model.ringY[j];
        const boost = 0.5 * Math.max(0, 1 - Math.abs(y - sweepY) / 0.11);
        const gl = glitch > 0 && y > glitchBand && y < glitchBand + 0.22 ? (Math.sin(j * 7.1 + time * 40) * 0.05 * ppu) : 0;
        for (let i = 0; i < SS; i++) {
          const a = j * SS + i, b = j * SS + ((i + 1) % SS);
          const nz = (verts.nz[a] + verts.nz[b]) / 2, rim = 1 - Math.abs(nz);
          const al = (0.1 + 0.5 * Math.max(nz, 0) + 0.38 * rim * rim + boost) * flick;
          seg(verts.sx[a] + gl, verts.sy[a], verts.sx[b] + gl, verts.sy[b], al);
        }
      }
      const mer = Math.round(SS / 12);
      for (let j = 0; j < R - 1; j++) for (let i = 0; i < SS; i += mer) {
        const a = j * SS + i, b = (j + 1) * SS + i, nz = (verts.nz[a] + verts.nz[b]) / 2, rim = 1 - Math.abs(nz);
        seg(verts.sx[a], verts.sy[a], verts.sx[b], verts.sy[b], (0.08 + 0.4 * Math.max(nz, 0) + 0.3 * rim * rim) * flick);
      }
      flush(col, lw, 1, true);

      /* horns */
      if (model.horns.length) {
        const hc = mix(col, WHITE, 0.45);
        for (const h of model.horns) {
          const n = h.length / 3;
          xf(M, PVH, h, n, tmp);
          for (let k = 0; k < n - 1; k++) seg(tmp[k * 3], tmp[k * 3 + 1], tmp[k * 3 + 3], tmp[k * 3 + 4], (0.3 + 0.4 * smooth(-1, 1, (tmp[k * 3 + 2] + tmp[k * 3 + 5]) / 2)) * flick);
        }
        flush(hc, lw, 0.95, true);
      }

      /* features */
      const featBright = mix(col, WHITE, 0.4);
      const drawFeat = (f, a, closedLoop) => {
        const n = f.n, xx = bufTmp(n);
        // jaw weight is a single number for these lines (0 = skull, 1 = jaw)
        const src = f.pts;
        for (let k = 0; k < n; k++) { xx[k * 3] = src[k * 3]; xx[k * 3 + 1] = src[k * 3 + 1]; xx[k * 3 + 2] = src[k * 3 + 2]; }
        jawFeat(xx, n, f.jaw);
        xf(M, PVH, xx, n, tmp);
        polyline3(tmp, n, a, closedLoop);
      };
      const polyline3 = (arr, n, a, closedLoop) => {
        const facing = (arr[2] + arr[(n - 1) * 3 + 2]) / 2;
        const vis = smooth(-0.9, 0.5, facing);
        if (vis < 0.03) return;
        polyline(arr, n, a * vis * flick, 1.5, featBright);
        if (closedLoop) { ctx.beginPath(); ctx.moveTo(arr[(n - 1) * 3], arr[(n - 1) * 3 + 1]); ctx.lineTo(arr[0], arr[1]); ctx.stroke(); }
      };
      const jawFeat = (xx, n, w) => {
        if (!w || !jawA) return;
        const a = jawA * w, c = 1 - (a * a) / 2;
        for (let k = 0; k < n; k++) {
          const y = xx[k * 3 + 1], z = xx[k * 3 + 2], dy = y - JAW_PY, dz = z - JAW_PZ;
          xx[k * 3 + 1] = JAW_PY + dy * c - dz * a; xx[k * 3 + 2] = JAW_PZ + dy * a + dz * c;
        }
      };
      model.brows.forEach((f) => drawFeat(f, 0.9));
      model.nose.forEach((f) => drawFeat(f, 0.6));
      model.ears.forEach((f) => drawFeat(f, 0.45));
      if (model.scar) drawFeat(model.scar, 0.95);
      model.cups.forEach((f) => drawFeat(f, 0.8));
      if (model.band) drawFeat(model.band, 0.8);
      drawFeat(model.mouthU, 0.95);
      drawFeat(model.mouthL, 0.95);
      if (openAmt > 0.06) { // the glow inside the open mouth
        const nU = model.mouthU.n, a = bufTmp(nU * 2), b = new Float32Array(nU * 3), c = new Float32Array(nU * 3);
        for (let k = 0; k < nU; k++) for (let q = 0; q < 3; q++) { b[k * 3 + q] = model.mouthU.pts[k * 3 + q]; c[k * 3 + q] = model.mouthL.pts[k * 3 + q]; }
        jawFeat(c, nU, 1);
        const tb = new Float32Array(nU * 3), tc = new Float32Array(nU * 3);
        xf(M, PVH, b, nU, tb); xf(M, PVH, c, nU, tc);
        if (tb[2] > -0.2) {
          ctx.beginPath();
          for (let k = 0; k < nU; k++) { if (k) ctx.lineTo(tb[k * 3], tb[k * 3 + 1]); else ctx.moveTo(tb[k * 3], tb[k * 3 + 1]); }
          for (let k = nU - 1; k >= 0; k--) ctx.lineTo(tc[k * 3], tc[k * 3 + 1]);
          ctx.closePath(); ctx.globalAlpha = clamp(openAmt * 0.7, 0, 0.55); ctx.fillStyle = rgba(col, 1); ctx.fill();
        }
      }

      /* eyes */
      drawEyes(M, PVH, time, st, featBright);

      /* gem on the forehead: the sign again, small */
      if (model.gem) {
        const g = model.gem;
        proj(M, PVH, g[0], g[1], g[2]);
        const s = (ppu * CAM_D) / (CAM_D - P[2]), r = 0.08 * s;
        if (P[2] > -0.1) {
          ctx.beginPath(); ctx.arc(P[0], P[1], r * 1.5, 0, TAU); ctx.fillStyle = rgba(col, 1); ctx.globalAlpha = 0.18 + 0.1 * Math.sin(time * 2); ctx.fill();
          drawSign(ctx, signName, P[0], P[1], r, rgbHex(hi), 0.95, 1.1);
        }
      }

      /* the sign at the voice box */
      if (!head) drawVoiceBox(MB, PVB, time, st);

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    const bodyBuf = { a: null };
    const bufBody = (n) => (bodyBuf.a && bodyBuf.a.length >= n * 3 ? bodyBuf.a : (bodyBuf.a = new Float32Array(n * 3)));
    const tmpBuf = { a: new Float32Array(3 * 80) };
    const bufTmp = (n) => (tmpBuf.a.length >= n * 3 ? tmpBuf.a : (tmpBuf.a = new Float32Array(n * 3)));
    const rgbHex = (c) => '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

    function xfHead(M, pv, jawA) {
      const { pos, nor, jaw, n } = model;
      for (let k = 0; k < n; k++) {
        let x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
        const jw = jaw[k];
        if (jawA && jw > 0) {
          const a = jawA * jw, dy = y - JAW_PY, dz = z - JAW_PZ, c = 1 - (a * a) / 2;
          y = JAW_PY + dy * c - dz * a; z = JAW_PZ + dy * a + dz * c;
        }
        x -= pv[0]; y -= pv[1]; z -= pv[2];
        const X = M[0] * x + M[1] * y + M[2] * z + pv[0], Y = M[3] * x + M[4] * y + M[5] * z + pv[1], Z = M[6] * x + M[7] * y + M[8] * z + pv[2];
        const s = (ppu * CAM_D) / (CAM_D - Z);
        verts.sx[k] = cx + X * s; verts.sy[k] = cy - (Y - wy0) * s; verts.rz[k] = Z;
        verts.nz[k] = M[6] * nor[k * 3] + M[7] * nor[k * 3 + 1] + M[8] * nor[k * 3 + 2];
      }
    }

    function eyeShape(style) {
      return style === 'wide' ? { a: 0.125, b: 0.062, al: 0.12 } : style === 'calm' ? { a: 0.13, b: 0.042, al: 0.12 } : { a: 0.145, b: 0.044, al: 0.42 };
    }

    function drawEyes(M, pv, time, st, bright) {
      const f = persona.face || {};
      const sh = eyeShape(f.eyes || 'sharp');
      const lid = clamp(1 - blink, 0.04, 1) * (st === 'thinking' ? 0.72 + 0.12 * Math.sin(time * 9) : st === 'listening' ? 1.18 : 1);
      const eb = st === 'listening' ? 1 : st === 'speaking' ? 0.95 : st === 'thinking' ? 0.7 + 0.25 * Math.sin(time * 14) : 0.78;
      for (const s of [-1, 1]) {
        const ex = s * 0.3, ey = 0.17;
        const pts = [];
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * TAU, u = sh.a * Math.cos(a), v = sh.b * Math.sin(a) * lid * (1 + 0.25 * Math.max(0, Math.sin(a)) * 0);
          const px = ex + s * (u * Math.cos(sh.al) - v * Math.sin(sh.al)), py = ey + (u * Math.sin(sh.al) + v * Math.cos(sh.al));
          pts.push([px, py, model.eyeZ(px, py)]);
        }
        const flat = new Float32Array(16 * 3);
        pts.forEach((p, i) => { flat[i * 3] = p[0]; flat[i * 3 + 1] = p[1]; flat[i * 3 + 2] = p[2]; });
        const out = new Float32Array(16 * 3);
        xf(M, pv, flat, 16, out);
        const facing = out[2];
        const vis = smooth(-0.5, 0.45, (out[2] + out[3 * 8 + 2]) / 2);
        if (vis < 0.03) continue;
        ctx.beginPath();
        for (let i = 0; i < 16; i++) { if (i) ctx.lineTo(out[i * 3], out[i * 3 + 1]); else ctx.moveTo(out[i * 3], out[i * 3 + 1]); }
        ctx.closePath();
        ctx.globalAlpha = 0.22 * eb * vis; ctx.fillStyle = rgba(col, 1); ctx.fill();
        ctx.globalAlpha = 0.95 * vis; ctx.lineWidth = 1.5; ctx.strokeStyle = rgba(bright, 1); ctx.stroke();
        // iris, looking a little toward the pointer
        const gz = model.eyeZ(ex, ey);
        const s2 = proj(M, pv, ex + s * 0.0 + yaw * 0.02 * -1 + (yawT - yaw) * 0.05, ey - (pitchT - pitch) * 0.03, gz + 0.01);
        const rr = 0.052 * s2 * Math.max(0.2, lid);
        const gr = ctx.createRadialGradient(P[0], P[1], 0, P[0], P[1], rr * 2.6);
        gr.addColorStop(0, `rgba(255,255,255,${0.95 * eb * vis})`); gr.addColorStop(0.3, rgba(mix(col, WHITE, 0.4), 0.8 * eb * vis)); gr.addColorStop(1, rgba(col, 0));
        ctx.globalAlpha = 1; ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(P[0], P[1], rr * 2.6, 0, TAU); ctx.fill();
      }
    }

    function drawVoiceBox(MB, pv, time, st) {
      const cxn = 0, cyn = -1.38, czn = 0.4;
      const speaking = st === 'speaking', listening = st === 'listening', thinking = st === 'thinking';
      const pulse = 1 + lvOut * 0.28 + (listening ? lvIn * 0.12 : 0);
      const r = 0.25 * pulse;
      const base = speaking ? 0.78 + 0.22 * lvOut : listening ? 0.7 + 0.3 * lvIn : thinking ? 0.7 + 0.2 * Math.sin(time * 6) : 0.5 + 0.12 * Math.sin(time * 1.6);
      const s = proj(MB, pv, cxn, cyn, czn);
      const sx = P[0], sy = P[1];
      // soft plate behind the sign
      const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * s * 2.1);
      gr.addColorStop(0, rgba(col, 0.42 * base)); gr.addColorStop(0.55, rgba(col, 0.12 * base)); gr.addColorStop(1, rgba(col, 0));
      ctx.globalAlpha = 1; ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(sx, sy, r * s * 2.1, 0, TAU); ctx.fill();
      // ripples: sound leaving (speaking) or sound arriving (listening)
      for (const rp of ripples) {
        const age = (time - rp.t) / 1.1;
        if (age < 0 || age > 1) continue;
        const rad = rp.dir > 0 ? r * (1.25 + 3.2 * age) : r * (4.2 - 3.0 * age);
        const al = (1 - age) * 0.55 * rp.amp * (rp.dir > 0 ? 1 : 1.2);
        ctx.beginPath();
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * TAU;
          proj(MB, pv, cxn + rad * Math.cos(a), cyn + rad * Math.sin(a) * 0.62, czn + 0.0);
          if (i) ctx.lineTo(P[0], P[1]); else ctx.moveTo(P[0], P[1]);
        }
        ctx.globalAlpha = clamp(al, 0, 0.8); ctx.lineWidth = 1.4; ctx.strokeStyle = rgba(rp.dir > 0 ? col : mix(col, WHITE, 0.5), 1); ctx.stroke();
      }
      // the sign itself, in 3D on the neck (it turns a little with the body)
      const rot = thinking ? time * 1.6 : 0;
      const cs = Math.cos(rot), sn = Math.sin(rot);
      const sc = mix(col, WHITE, 0.45 + 0.3 * lvOut);
      for (const line of signPolys(signName)) {
        ctx.beginPath();
        line.forEach((p, i) => {
          const x = p[0] * cs - p[1] * sn, y = p[0] * sn + p[1] * cs;
          proj(MB, pv, cxn + x * r, cyn + y * r, czn);
          if (i) ctx.lineTo(P[0], P[1]); else ctx.moveTo(P[0], P[1]);
        });
        if (opts.glow) { ctx.globalAlpha = base * 0.3; ctx.lineWidth = 5; ctx.strokeStyle = rgba(col, 1); ctx.stroke(); }
        ctx.globalAlpha = Math.min(1, base + 0.2); ctx.lineWidth = 1.7; ctx.strokeStyle = rgba(sc, 1); ctx.stroke();
      }
    }

    /* ---- per-frame update ---- */
    function update(dt, time) {
      const st = ctl.state;
      const out = ctl.levelOut ? clamp(ctl.levelOut() || 0, 0, 1) : 0;
      const inn = ctl.levelIn ? clamp(ctl.levelIn() || 0, 0, 1) : 0;
      lvOut += (out - lvOut) * (out > lvOut ? 0.55 : 0.16);
      lvIn += (inn - lvIn) * (inn > lvIn ? 0.5 : 0.14);
      const targetOpen = st === 'speaking' ? clamp(lvOut * 1.25, 0, 1) : 0;
      openAmt += (targetOpen - openAmt) * (targetOpen > openAmt ? 0.5 : 0.25);
      if (pose) { yaw = pose.yaw; pitch = pose.pitch; roll = 0; return; }
      const sway = Math.sin(time * 0.35) * 0.1 + Math.sin(time * 0.17 + 1) * 0.04;
      const k = 1 - Math.exp(-dt * 5);
      yaw += (yawT + sway - yaw) * k;
      pitch += (pitchT + Math.sin(time * 0.5) * 0.02 + (st === 'thinking' ? -0.06 : 0) - pitch) * k;
      roll += ((st === 'listening' ? 0.07 : 0) + Math.sin(time * 0.27) * 0.015 - roll) * k;
      // blink
      nextBlink -= dt;
      if (nextBlink <= 0 && blink === 0) { blink = 0.0001; }
      if (blink > 0) { blink += dt * 9; if (blink >= 2) { blink = 0; nextBlink = 2 + rand() * 4; } }
      if (blink > 0) blink = Math.min(blink, 2);
      // glitch
      nextGlitch -= dt;
      if (nextGlitch <= 0) { glitch = 0.14; nextGlitch = 6 + rand() * 8; }
      if (glitch > 0) glitch = Math.max(0, glitch - dt);
      // ripples for sound going out / coming in
      const want = st === 'speaking' && lvOut > 0.12 ? 1 : st === 'listening' && lvIn > 0.1 ? -1 : 0;
      if (want && time - rippleAt > (want > 0 ? 0.16 : 0.2)) {
        ripples.push({ t: time, dir: want, amp: want > 0 ? lvOut : lvIn });
        rippleAt = time;
        if (ripples.length > 14) ripples.shift();
      }
      while (ripples.length && time - ripples[0].t > 1.2) ripples.shift();
    }
    // blink eases closed then open: 0 -> 1 -> 0 over 2 units; render() reads `blink` as closure amount via this mapping
    const blinkAmt = () => (blink <= 0 ? 0 : blink < 1 ? blink : 2 - blink);

    ctl._tick = (t) => {
      if (paused || document.hidden) return;
      if (!t0) { t0 = t; last = t; }
      const minGap = 1000 / opts.fps - 2;
      if (t - lastDraw < minGap) return;
      lastDraw = t;
      const dt = clamp((t - last) / 1000, 0, 0.05);
      last = t;
      if (!canvas.isConnected) return;
      update(dt, (t - t0) / 1000);
      const saved = blink; blink = blinkAmt();
      render(t);
      blink = saved;
    };

    ctl.setState = (s) => { ctl.state = s; if (still) { lvOut = s === 'speaking' ? 0.5 : 0; openAmt = s === 'speaking' ? 0.3 : 0; render(0); } };
    ctl.setPersona = (p) => { setPersona(p); layout(); };
    ctl.lookAt = (nx, ny) => { yawT = clamp(nx, -1, 1) * 0.5; pitchT = clamp(ny, -1, 1) * 0.25; };
    ctl.pause = (v) => { paused = !!v; };
    ctl.resize = () => layout();
    /** One still frame with a fixed pose (avatars, thumbnails, tests). */
    ctl.renderOnce = (p) => {
      pose = p || { yaw: 0.25, pitch: -0.03 };
      layout();
      update(0.016, 0);
      blink = 0;
      render(0);
    };
    ctl.destroy = () => {
      ACTIVE.delete(ctl);
      if (ro) ro.disconnect();
      window.removeEventListener('pointermove', onMove);
    };

    function onMove(e) {
      if (!opts.interactive) return;
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      ctl.lookAt(((e.clientX - r.left) / r.width - 0.5) * 2, ((e.clientY - r.top) / r.height - 0.5) * 2);
    }
    let ro = null;
    setPersona(persona);
    layout();
    if (!opts.static) {
      window.addEventListener('pointermove', onMove);
      if (window.ResizeObserver) { ro = new ResizeObserver(() => layout()); ro.observe(canvas); }
      ACTIVE.add(ctl);
      startTicker();
    }
    if (still) ctl.renderOnce({ yaw: 0.18, pitch: -0.02 });
    return ctl;
  }

  /* ------------------------------------------------------------ avatars + generated personas ------------------------------------------------------------ */
  const AVATARS = new Map();
  function avatar(persona, px) {
    px = px || 64;
    const key = px + '|' + persona.color + '|' + persona.sign + '|' + JSON.stringify(persona.face || {});
    if (AVATARS.has(key)) return AVATARS.get(key);
    const c = document.createElement('canvas');
    c.width = px * 2; c.height = px * 2;
    c.style.width = px + 'px'; c.style.height = px + 'px';
    document.body.appendChild(c); // getBoundingClientRect needs it in the page for a moment
    c.style.cssText = `position:fixed;left:-9999px;top:0;width:${px}px;height:${px}px`;
    let url = '';
    try {
      const f = createFace(c, persona, { detail: 'low', glow: false, interactive: false, static: true, camera: 'head' });
      f.renderOnce({ yaw: 0.28, pitch: -0.04 });
      url = c.toDataURL('image/png');
      f.destroy();
    } catch { /* a missing avatar is not worth breaking the page */ }
    c.remove();
    if (AVATARS.size > 120) AVATARS.delete(AVATARS.keys().next().value);
    AVATARS.set(key, url);
    return url;
  }

  const OMNI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  const HORNS = ['sweep', 'twin', 'single', 'ridge', 'crown', 'none'];
  const HAIRS = ['swept', 'long', 'spiky', 'side', 'crop', 'none'];
  const EYES = ['sharp', 'calm', 'wide'];
  const hsl = (h, s, l) => {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  };
  /** A stable face for any model or combo that has no persona: the same name always gives the same face. */
  function autoPersona(model) {
    const name = String(model || 'model');
    const seed = hash(name), r = rng(seed);
    const extras = [];
    if (r() < 0.45) extras.push('gem');
    if (r() < 0.25) extras.push('scar');
    if (r() < 0.12) extras.push('headphones');
    return {
      id: 'auto-' + seed.toString(36), auto: true, builtin: false, name: name.split('/').pop().slice(0, 20), tagline: '', role: 'chat', model: name,
      color: hsl(Math.floor(r() * 360), 78, 62), sign: SIGN_NAMES[Math.floor(r() * SIGN_NAMES.length)],
      face: { seed: seed % 100000, headW: 0.76 + r() * 0.1, jaw: 0.17 + r() * 0.11, cheek: 0.05 + r() * 0.08, brow: 0.04 + r() * 0.06, nose: 0.16 + r() * 0.09, lips: 0.05 + r() * 0.04, smile: r() < 0.3 ? 0.5 : 0, eyes: EYES[Math.floor(r() * 3)], horns: HORNS[Math.floor(r() * HORNS.length)], hair: HAIRS[Math.floor(r() * HAIRS.length)], extras },
      voice: { pitch: 0.85 + r() * 0.35, rate: 0.95 + r() * 0.15, volume: 1, browserVoice: '', omniVoice: OMNI_VOICES[Math.floor(r() * OMNI_VOICES.length)] },
      aliases: [], system: '',
    };
  }

  window.Holo = { createFace, avatar, autoPersona, drawSign, signNames: SIGN_NAMES, hash, rng, hsl, version: '1.4.0' };
})();
