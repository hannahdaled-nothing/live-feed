// Lifelike 3D deep-sea creatures, rendered with three.js on a transparent
// canvas that sits over the camera feed. Every model is built procedurally:
// 1 unit tall, resting on y = 0 (the shoulder), facing -x.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const C = hex => new THREE.Color(hex);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

// ---------- 3D Perlin noise, for skin colour and shape ----------
const noise = (() => {
  const r = rng(7), perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y, z) => {
    h &= 15;
    const u = h < 8 ? x : y, v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  };
  return (x, y, z) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z, B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    return lerp(
      lerp(lerp(grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z), u), lerp(grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z), u), v),
      lerp(lerp(grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1), u), lerp(grad(p[AB + 1], x, y - 1, z - 1), grad(p[BB + 1], x - 1, y - 1, z - 1), u), v),
      w);
  };
})();
function fbm(x, y, z, oct = 4) {
  let a = 0, f = 1, amp = 0.5;
  for (let i = 0; i < oct; i++) { a += amp * noise(x * f, y * f, z * f); f *= 2.03; amp *= 0.5; }
  return a;
}

// ---------- skin material: physical shading + procedural bumps + soft rim glow ----------
const SKIN_FRAG_HEAD = /* glsl */`
varying vec3 vRest;
uniform float uScale, uBump, uFreq, uStyle, uRimPow;
uniform vec3 uRim;
float skinHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float skinNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(skinHash(i), skinHash(i + vec3(1, 0, 0)), f.x), mix(skinHash(i + vec3(0, 1, 0)), skinHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(skinHash(i + vec3(0, 0, 1)), skinHash(i + vec3(1, 0, 1)), f.x), mix(skinHash(i + vec3(0, 1, 1)), skinHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec3 skinPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = normalize(dFdx(surfPos)), sy = normalize(dFdy(surfPos));
  vec3 r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 g = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - g);
}
`;
const SKIN_NORMAL = /* glsl */`
{
  vec3 q = vRest * uFreq;
  float h;
  if (uStyle < 0.5) h = skinNoise(q) * 0.7 + skinNoise(q * 2.7) * 0.3;                          // soft and lumpy
  else if (uStyle < 1.5) h = (1.0 - abs(skinNoise(q) * 2.0 - 1.0)) * 0.6 + skinNoise(q * 3.1) * 0.4; // wrinkled
  else h = skinNoise(q) * 0.5 + skinNoise(q * 4.0) * 0.5;                                         // fine grain
  h *= uBump * uScale;
  normal = skinPerturb(-vViewPosition, normal, vec2(dFdx(h), dFdy(h)), faceDirection);
}
`;
const SKIN_RIM = /* glsl */`
totalEmissiveRadiance += uRim * pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), uRimPow);
`;

function skin(params, { bump = 0.003, freq = 50, style = 0, rim = 0x000000, rimPow = 3 } = {}) {
  const m = new THREE.MeshPhysicalMaterial(params);
  const u = {
    uScale: { value: 100 }, uBump: { value: bump }, uFreq: { value: freq },
    uStyle: { value: style }, uRim: { value: C(rim) }, uRimPow: { value: rimPow }
  };
  m.userData.skin = u;
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'attribute vec3 aRest;\nvarying vec3 vRest;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = aRest;');
    sh.fragmentShader = SKIN_FRAG_HEAD + sh.fragmentShader
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + SKIN_NORMAL)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + SKIN_RIM);
  };
  return m;
}

// Adds vertex colours (and the rest pose the skin bumps are pinned to) to a geometry.
function paint(geo, fn) {
  const p = geo.attributes.position, col = new Float32Array(p.count * 3);
  const c = new THREE.Color(), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); fn(v, c); c.toArray(col, i * 3); }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aRest', p.clone());
  return geo;
}

function eyeTexture({ iris, rim, sclera, pupil }) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = sclera; g.fillRect(0, 0, 256, 128);
  const gr = g.createRadialGradient(128, 64, 4, 128, 64, 36);
  gr.addColorStop(0, iris); gr.addColorStop(0.7, iris); gr.addColorStop(1, rim);
  g.fillStyle = gr; g.beginPath(); g.arc(128, 64, 36, 0, TAU); g.fill();
  const r = rng(3);
  for (let i = 0; i < 140; i++) {
    const a = r() * TAU;
    g.strokeStyle = `rgba(255,230,190,${r() * 0.16})`;
    g.beginPath(); g.moveTo(128 + Math.cos(a) * 10, 64 + Math.sin(a) * 10); g.lineTo(128 + Math.cos(a) * 34, 64 + Math.sin(a) * 34); g.stroke();
  }
  g.fillStyle = '#030203';
  g.beginPath();
  if (pupil === 'slit') g.ellipse(128, 64, 19, 5.5, 0, 0, TAU); else g.arc(128, 64, 12, 0, TAU);
  g.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function makeEye(radius, texOpts) {
  const geo = new THREE.SphereGeometry(radius, 40, 24);
  geo.rotateY(-Math.PI / 2); // pupil looks down +z, so lookAt() aims it
  return new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
    map: eyeTexture(texOpts), roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.03
  }));
}
function glowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,.55)');
  gr.addColorStop(0.5, 'rgba(255,255,255,.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}

// ---------- tapered tube that can be re-shaped every frame ----------
const _t = new THREE.Vector3(), _n = new THREE.Vector3(), _b = new THREE.Vector3(), _pn = new THREE.Vector3(), _o = new THREE.Vector3();
class Tube {
  constructor(segs, radial, material, { flatten = 1, color = null } = {}) {
    Object.assign(this, { segs, radial, flatten, color, first: true });
    const n = (segs + 1) * (radial + 1);
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    this.nor = new Float32Array(n * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    if (color) this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const idx = [];
    for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.pts = Array.from({ length: segs + 1 }, () => new THREE.Vector3());
    this.rad = new Float32Array(segs + 1);
  }
  update(pointAt, radiusAt) {
    const { segs, radial, pts, rad, pos, nor, flatten } = this;
    for (let i = 0; i <= segs; i++) { pointAt(i / segs, pts[i]); rad[i] = radiusAt(i / segs); }
    const col = this.first && this.color ? this.geo.attributes.color.array : null;
    const c = new THREE.Color();
    for (let i = 0; i <= segs; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(segs, i + 1);
      _t.subVectors(pts[i1], pts[i0]);
      const len = _t.length() || 1e-6;
      _t.divideScalar(len);
      const dr = (rad[i1] - rad[i0]) / len;
      if (i === 0) _n.crossVectors(_t, Math.abs(_t.y) > 0.95 ? X_AXIS : UP).normalize();
      else _n.copy(_pn).addScaledVector(_t, -_pn.dot(_t)).normalize();
      _pn.copy(_n);
      _b.crossVectors(_t, _n);
      for (let j = 0; j <= radial; j++) {
        const a = j / radial * TAU, ca = Math.cos(a), sa = Math.sin(a), r = rad[i];
        const k = (i * (radial + 1) + j) * 3;
        pos[k] = pts[i].x + (_n.x * ca + _b.x * sa * flatten) * r;
        pos[k + 1] = pts[i].y + (_n.y * ca + _b.y * sa * flatten) * r;
        pos[k + 2] = pts[i].z + (_n.z * ca + _b.z * sa * flatten) * r;
        _o.set(_n.x * ca * flatten + _b.x * sa, _n.y * ca * flatten + _b.y * sa, _n.z * ca * flatten + _b.z * sa).normalize();
        if (col) { this.color(i / segs, _o.dot(UP), c); c.toArray(col, k); }
        _o.addScaledVector(_t, -dr).normalize();
        nor[k] = _o.x; nor[k + 1] = _o.y; nor[k + 2] = _o.z;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    if (this.first) {
      this.geo.setAttribute('aRest', new THREE.BufferAttribute(pos.slice(), 3));
      this.first = false;
    }
  }
}

// ---------- closed surface over a (t = top..bottom, phi = around) grid ----------
class Surface {
  constructor(rows, cols, material) {
    this.rows = rows; this.cols = cols;
    const n = (rows + 1) * cols;
    this.count = n;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const idx = [];
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const a = i * cols + j, d = i * cols + (j + 1) % cols, b = a + cols, c = (i + 1) * cols + (j + 1) % cols;
      idx.push(a, d, b, b, d, c);
    }
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
  }
  forEach(fn) {
    let k = 0;
    for (let i = 0; i <= this.rows; i++) for (let j = 0; j < this.cols; j++, k++) fn(i / this.rows, j / this.cols * TAU, k);
  }
  commit() {
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
    if (!this.geo.attributes.aRest) this.geo.setAttribute('aRest', new THREE.BufferAttribute(this.pos.slice(), 3));
  }
}

// Fan-shaped fin with darker rays and a scalloped edge, in the xy plane pointing +x.
function finGeometry(length, spread, rays, rayCol, webCol, edgeCol) {
  const na = rays * 4, nr = 8, pos = [], col = [], idx = [];
  const c = new THREE.Color();
  for (let i = 0; i <= nr; i++) for (let j = 0; j <= na; j++) {
    const a = -spread / 2 + spread * j / na, ph = (j % 4) / 4;
    const R = length * (i / nr) * (1 - 0.16 * Math.sin(ph * Math.PI)) * (0.8 + 0.2 * Math.cos((j / na - 0.5) * Math.PI));
    pos.push(Math.cos(a) * R, Math.sin(a) * R, 0.03 * length * Math.sin(i * 1.3 + j * 0.7) * (i / nr));
    c.lerpColors(webCol, edgeCol, smooth(0.5, 1, i / nr));
    if (j % 4 === 0) c.lerp(rayCol, 0.8);
    col.push(c.r, c.g, c.b);
  }
  for (let i = 0; i < nr; i++) for (let j = 0; j < na; j++) {
    const a = i * (na + 1) + j, b = a + na + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ======================================================================
// Dumbo octopus: the yellow one sitting on the sea floor.
// ======================================================================
function makeDumbo() {
  const group = new THREE.Group();
  const mat = skin({
    vertexColors: true, roughness: 0.46, clearcoat: 0.6, clearcoatRoughness: 0.28,
    sheen: 0.35, sheenColor: C(0xffc070), sheenRoughness: 0.5
  }, { bump: 0.0035, freq: 55, style: 0, rim: 0x5a2c06, rimPow: 2.4 });

  const R = 0.27, H0 = 0.44, A0 = Math.PI * 0.56;
  const lobeAt = phi => Math.pow(0.5 + 0.5 * Math.cos(8 * (phi - Math.PI / 8)), 2.2);   // 1 along each arm
  const edgeAt = (phi, tm) => 0.55 * (0.8 + 0.22 * lobeAt(phi)) * (1 + 0.035 * Math.sin(tm * 2.2) + 0.025 * Math.sin(tm * 1.7 + phi * 2));

  function profile(t, phi, tm, out) {
    const breath = Math.sin(tm * 2.2), lobe = lobeAt(phi), edge = edgeAt(phi, tm);
    const domeRho = a => R * Math.sin(a) * (1 - 0.025 * breath);
    const domeY = a => H0 + 1.2 * R * Math.cos(a) * (1 + 0.035 * breath);
    let rho, y;
    if (t < 0.46) {                      // mantle dome
      const a = t / 0.46 * A0;
      rho = domeRho(a); y = domeY(a);
    } else if (t < 0.8) {                // webbed skirt spreading over the arms
      const s = (t - 0.46) / 0.34, r0 = domeRho(A0), y0 = domeY(A0);
      rho = r0 + (edge - r0) * (1 - (1 - s) ** 2);
      y = y0 + (0.035 - y0) * Math.pow(s, 0.75) + 0.035 * lobe * Math.sin(s * Math.PI);
    } else if (t < 0.86) {               // rolled rim
      const s = (t - 0.8) / 0.06;
      rho = edge + 0.014 * Math.sin(s * Math.PI);
      y = 0.035 - 0.028 * s;
    } else {                             // underside
      const s = (t - 0.86) / 0.14;
      rho = edge * (1 - s);
      y = 0.007 + 0.06 * s;
    }
    return out.set(rho * Math.cos(phi), y, rho * Math.sin(phi));
  }

  const body = new Surface(120, 104, mat);
  const v = new THREE.Vector3(), c = new THREE.Color();
  const deep = C(0xc9560a), gold = C(0xee9a0e), pale = C(0xf3c457), speck = C(0xa0400c), under = C(0xf0c47a);
  body.forEach((t, phi, k) => {
    profile(t, phi, 0, v).toArray(body.pos, k * 3);
    const n = fbm(v.x * 7, v.y * 7, v.z * 7, 3), sp = noise(v.x * 45 + 3, v.y * 45, v.z * 45);
    if (t < 0.46) c.lerpColors(deep, gold, 0.15 + 0.75 * smooth(0, 0.46, t));
    else if (t < 0.8) c.lerpColors(gold, pale, smooth(0.5, 0.8, t));
    else c.copy(under);
    c.lerp(deep, clamp(n * 1.1 + 0.15, 0, 0.55));
    c.lerp(speck, smooth(0.22, 0.45, sp) * (t < 0.8 ? 0.55 : 0.2));
    c.toArray(body.col, k * 3);
  });
  body.commit();
  group.add(body.mesh);

  // big glossy eyes with horizontal slit pupils, under a ring of skin
  const lidGeo = paint(new THREE.TorusGeometry(0.06, 0.022, 18, 48), (p, col) => col.lerpColors(deep, gold, 0.55));
  for (const side of [-1, 1]) {
    const a = Math.PI * 0.34, phi = Math.PI - side * 0.6;
    const surf = new THREE.Vector3(R * Math.sin(a) * Math.cos(phi), H0 + 1.2 * R * Math.cos(a), R * Math.sin(a) * Math.sin(phi));
    const nrm = new THREE.Vector3(Math.sin(a) * Math.cos(phi), Math.cos(a) / 1.2, Math.sin(a) * Math.sin(phi)).normalize();
    const eyeball = makeEye(0.064, { iris: '#7a5320', rim: '#20140a', sclera: '#1a120e', pupil: 'slit' });
    eyeball.position.copy(surf).addScaledVector(nrm, -0.018);
    group.add(eyeball);
    eyeball.lookAt(eyeball.position.clone().add(nrm).add(new THREE.Vector3(-0.35, 0, 0)));
    const lid = new THREE.Mesh(lidGeo, mat);
    lid.position.copy(surf).addScaledVector(nrm, 0.004);
    group.add(lid);
    lid.lookAt(lid.position.clone().add(nrm));
  }

  // ear-like fins
  const ears = [];
  for (const side of [-1, 1]) {
    const geo = new THREE.SphereGeometry(1, 40, 20);
    geo.scale(0.1, 0.022, 0.14);
    geo.translate(0, 0, side * 0.12);
    paint(geo, (p, col) => {
      const e = Math.hypot(p.x / 0.1, (p.z - side * 0.12) / 0.14);
      col.lerpColors(gold, pale, smooth(0.4, 1, e)).lerp(deep, 0.25 * (1 - e));
    });
    const pivot = new THREE.Group();
    const a = Math.PI * 0.2, phi = side * (Math.PI / 2 - 0.2);
    pivot.position.set(R * Math.sin(a) * Math.cos(phi) * 0.9, H0 + 1.2 * R * Math.cos(a), R * Math.sin(a) * Math.sin(phi) * 0.9);
    pivot.add(new THREE.Mesh(geo, mat));
    group.add(pivot);
    ears.push({ pivot, side });
  }

  // curled arm tips peeking out from under the web
  const arms = [];
  const armCol = (s, up, col) => col.lerpColors(C(0xf6d49a), C(0xeba33c), 0.5 + 0.5 * up);
  for (let k = 0; k < 8; k++) {
    const tube = new Tube(28, 12, mat, { color: armCol });
    group.add(tube.mesh);
    arms.push({ tube, phi: Math.PI / 8 + k * Math.PI / 4, k, pts: Array.from({ length: 29 }, () => new THREE.Vector3()) });
  }

  function update(tm) {
    body.forEach((t, phi, k) => profile(t, phi, tm, v).toArray(body.pos, k * 3));
    body.commit();
    for (const { pivot, side } of ears) pivot.rotation.x = -side * (0.2 + 0.35 * Math.sin(tm * 3.2));
    for (const arm of arms) {
      const { phi, k, pts } = arm, cp = Math.cos(phi), sp = Math.sin(phi);
      let o = edgeAt(phi, tm) - 0.1, u = 0.03, th = -0.1;
      const L = 0.24, n = pts.length - 1, curl = 3.4 + 0.5 * Math.sin(tm * 1.3 + k * 1.7);
      for (let i = 0; i <= n; i++) {
        const s = i / n;
        pts[i].set(o * cp, u, o * sp);
        th = -0.1 + curl * s * s;
        o += Math.cos(th) * L / n;
        u += Math.sin(th) * L / n;
      }
      arm.tube.update((s, out) => out.copy(pts[Math.round(s * n)]), s => 0.036 * Math.pow(1 - s, 0.9) + 0.004);
    }
    group.rotation.z = Math.sin(tm * 0.9) * 0.03;
  }
  update(0);
  return { name: 'dumbo', group, update, mats: [mat], turn: 1.2, tilt: 0.14 };
}

// ======================================================================
// Anglerfish: dark and velvety, with a gaping fanged mouth and a glowing lure.
// ======================================================================
function makeAngler() {
  const group = new THREE.Group();
  const CX = 0.02, CY = 0.45;
  const HX = -0.09, HY = 0.525;   // jaw hinge, at the corners of the mouth
  const mat = skin({
    vertexColors: true, roughness: 0.62, clearcoat: 0.35, clearcoatRoughness: 0.4,
    sheen: 0.9, sheenColor: C(0x6f5486), sheenRoughness: 0.6
  }, { bump: 0.0045, freq: 36, style: 1, rim: 0x1d1428, rimPow: 3 });

  const mouthGeom = q => ({ eLip: -0.12 + 0.35 * q * q, w: 0.26 * Math.pow(Math.max(0, 1 - q * q), 0.7) + 0.015 });
  function shape(d, out) {
    const az = Math.atan2(d.z, -d.x), el = Math.asin(clamp(d.y, -1, 1));
    const inMouth = Math.abs(az) < 1.25, q = clamp(az / 1.25, -1, 1);
    const { eLip, w } = mouthGeom(q);
    const u = (el - eLip) / w;
    const mouth = inMouth ? Math.max(0, 1 - u * u) * Math.sqrt(1 - q * q) : 0;
    const lip = inMouth ? Math.exp(-(((Math.abs(u) - 1) / 0.3) ** 2)) * (1 - q * q) : 0;
    const r = 1 - 0.42 * Math.pow(mouth, 0.8) + 0.05 * lip;
    const back = Math.max(0, d.x), shrink = 1 - 0.8 * Math.pow(back, 1.6);
    const lower = smooth(eLip + 0.05, eLip - 0.2, el) * smooth(0.15, -0.4, d.x);
    let x = 0.36 * d.x * r * (1 + back * back);
    x -= 0.07 * lower * Math.max(0, -d.x);  // underbite
    out.set(x + CX, 0.33 * d.y * r * shrink * (d.y > 0 ? 1.05 : 1) + CY, 0.27 * d.z * r * shrink);
    return { mouth, lower };
  }
  const dir = (az, el, out) => out.set(-Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));

  const body = new Surface(100, 116, mat);
  const rest = new Float32Array(body.count * 3), lowW = new Float32Array(body.count), tailW = new Float32Array(body.count);
  const d = new THREE.Vector3(), v = new THREE.Vector3(), c = new THREE.Color();
  const dark = C(0x271c1a), mid = C(0x4a3830), belly = C(0x6a5750), spot = C(0x9c8c80), mouthC = C(0x4d1016), throat = C(0x120406);
  body.forEach((t, phi, k) => {
    const th = t * Math.PI;
    d.set(Math.sin(th) * Math.cos(phi), Math.cos(th), Math.sin(th) * Math.sin(phi));
    const info = shape(d, v);
    v.toArray(rest, k * 3);
    lowW[k] = info.lower;
    tailW[k] = smooth(0.25, 0.75, v.x);
    c.lerpColors(dark, mid, clamp(0.45 + fbm(v.x * 6, v.y * 6, v.z * 6, 4) * 1.6, 0, 1));
    c.lerp(belly, smooth(-0.1, -0.8, d.y) * 0.6);
    c.lerp(spot, smooth(0.35, 0.6, noise(v.x * 18, v.y * 18 + 5, v.z * 18)) * 0.3);
    c.lerp(mouthC, smooth(0.05, 0.4, info.mouth)).lerp(throat, smooth(0.5, 0.95, info.mouth));
    c.toArray(body.col, k * 3);
  });
  rest.forEach((x, i) => { body.pos[i] = x; });
  body.commit();
  group.add(body.mesh);

  // needle teeth: upper ones hang from the snout, lower ones ride on the jaw
  const jawGroup = new THREE.Group();
  jawGroup.position.set(HX, HY, 0);
  group.add(jawGroup);
  const toothMat = new THREE.MeshPhysicalMaterial({
    color: 0xeee8d8, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08,
    transparent: true, opacity: 0.94, sheen: 0.5, sheenColor: C(0xffffff)
  });
  const r = rng(11);
  function addTeeth(count, upper) {
    for (let i = 0; i < count; i++) {
      const q = lerp(-0.86, 0.86, i / (count - 1)) + (r() - 0.5) * 0.05;
      const { eLip, w } = mouthGeom(q);
      const base = new THREE.Vector3();
      shape(dir(q * 1.25, upper ? eLip + w * 0.9 : eLip - w * 0.9, d), base);
      const inward = new THREE.Vector3(CX - base.x, 0, -base.z).normalize();
      const aim = new THREE.Vector3(0, upper ? -1 : 1, 0).addScaledVector(inward, upper ? 0.3 : -0.3).normalize();
      const L = (0.045 + 0.11 * Math.pow(1 - Math.abs(q), 1.5)) * (0.7 + 0.6 * r());
      const rb = 0.004 + 0.07 * L;
      const start = base.clone().addScaledVector(aim, -0.012);
      const bend = inward.clone().multiplyScalar(0.28 * L);
      const tooth = new Tube(10, 8, toothMat);
      tooth.update((s, o) => o.copy(start).addScaledVector(aim, L * s).addScaledVector(bend, s * s), s => rb * Math.pow(1 - s, 1.1) + 0.0006);
      if (upper) group.add(tooth.mesh);
      else { tooth.mesh.position.set(-HX, -HY, 0); jawGroup.add(tooth.mesh); }
    }
  }
  addTeeth(12, true);
  addTeeth(10, false);

  // small beady eyes
  for (const side of [-1, 1]) {
    const p = new THREE.Vector3();
    shape(dir(side * 0.62, 0.3, d), p);
    const nrm = p.clone().sub(new THREE.Vector3(CX, CY, 0)).normalize();
    const eyeball = makeEye(0.032, { iris: '#6f8a90', rim: '#1d2528', sclera: '#2a2220', pupil: 'round' });
    eyeball.position.copy(p).addScaledVector(nrm, -0.008);
    group.add(eyeball);
    eyeball.lookAt(eyeball.position.clone().add(nrm));
  }

  // fins
  const finMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.82,
    roughness: 0.5, sheen: 0.6, sheenColor: C(0x6f5486), depthWrite: false
  });
  const rayC = C(0x21181a), webC = C(0x4e3c38), edgeC = C(0x7b6660);
  const pecs = [];
  for (const side of [-1, 1]) {
    const fin = new THREE.Mesh(finGeometry(0.17, 1.3, 9, rayC, webC, edgeC), finMat);
    fin.position.set(0.1, 0.36, side * 0.23);
    group.add(fin);
    pecs.push({ fin, side });
  }
  const tail = new THREE.Mesh(finGeometry(0.26, 1.15, 12, rayC, webC, edgeC), finMat);
  tail.position.set(0.72 + CX, CY, 0);
  group.add(tail);
  const dorsal = new THREE.Mesh(finGeometry(0.11, 0.9, 6, rayC, webC, edgeC), finMat);
  dorsal.position.set(0.42, 0.6, 0);
  dorsal.rotation.z = 1.1;
  group.add(dorsal);

  // the lure: a fishing-rod spine with a glowing bulb
  const lureBase = new THREE.Vector3();
  shape(dir(0, 1.05, d), lureBase);
  const lureMat = skin({ vertexColors: true, roughness: 0.55, sheen: 0.8, sheenColor: C(0x6f5486) }, { bump: 0.002, freq: 60, style: 1 });
  const lure = new Tube(36, 8, lureMat, { color: (s, up, col) => col.lerpColors(C(0x3a2a24), C(0x9a8474), smooth(0.7, 1, s)) });
  group.add(lure.mesh);
  const esca = new THREE.Mesh(new THREE.SphereGeometry(0.03, 32, 16), new THREE.MeshPhysicalMaterial({
    color: 0xe6fff9, emissive: 0x7dffe9, emissiveIntensity: 2.2, roughness: 0.15, clearcoat: 1, transparent: true, opacity: 0.96
  }));
  group.add(esca);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: 0x86fff0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false
  }));
  group.add(glow);
  const light = new THREE.PointLight(0x8ffff0, 0, 1, 0);

  const tip = new THREE.Vector3(), ctrl = new THREE.Vector3();
  function update(tm, scalePx) {
    const jaw = 0.13 + 0.15 * Math.pow(0.5 + 0.5 * Math.sin(tm * 1.1), 3);
    for (let k = 0; k < body.count; k++) {
      let x = rest[k * 3], y = rest[k * 3 + 1], z = rest[k * 3 + 2];
      const w = lowW[k];
      if (w > 0) {
        const a = jaw * w, ca = Math.cos(a), sa = Math.sin(a), dx = x - HX, dy = y - HY;
        x = HX + dx * ca - dy * sa;
        y = HY + dx * sa + dy * ca;
      }
      z += tailW[k] * 0.055 * Math.sin(tm * 3 - rest[k * 3] * 5);
      body.pos[k * 3] = x; body.pos[k * 3 + 1] = y; body.pos[k * 3 + 2] = z;
    }
    body.commit();
    jawGroup.rotation.z = jaw;

    // the tail fin follows the body's wave: z = 0.055 sin(3t - 5x)
    tail.position.z = 0.055 * Math.sin(tm * 3 - tail.position.x * 5);
    tail.rotation.y = Math.atan(0.055 * 5 * Math.cos(tm * 3 - tail.position.x * 5)) * 1.2;
    for (const { fin, side } of pecs) fin.rotation.set(0, -side * (0.7 + 0.35 * Math.sin(tm * 4 + side)), -0.55);

    tip.set(-0.6 + 0.05 * Math.sin(tm * 1.3), 0.86 + 0.03 * Math.cos(tm * 1.7), 0.04 * Math.sin(tm * 0.9));
    ctrl.set(lureBase.x - 0.04, 1.1, 0);
    lure.update((s, o) => {
      const a = (1 - s) * (1 - s), b = 2 * s * (1 - s), cc = s * s;
      o.set(a * lureBase.x + b * ctrl.x + cc * tip.x, a * lureBase.y + b * ctrl.y + cc * tip.y, a * lureBase.z + b * ctrl.z + cc * tip.z);
    }, s => 0.014 * (1 - s) + 0.005);
    const pulse = 0.8 + 0.2 * Math.sin(tm * 3.1) + 0.08 * Math.sin(tm * 11);
    esca.position.copy(tip).y -= 0.022;
    esca.material.emissiveIntensity = 2.2 * pulse;
    glow.position.copy(esca.position);
    glow.scale.setScalar(0.32 * pulse);
    glow.material.opacity = 0.9 * pulse;
    esca.updateWorldMatrix(true, false);
    esca.getWorldPosition(light.position);
    light.intensity = 2.6 * pulse;
    light.distance = 0.9 * scalePx;
  }
  update(0, 100);
  return { name: 'angler', group, update, mats: [mat, lureMat], light, turn: 0.5, tilt: 0.1 };
}

// ======================================================================
// Blue dragon (Glaucus atlanticus): a sea slug with fans of blue fingers.
// ======================================================================
function makeGlaucus() {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  inner.scale.setScalar(0.9);
  group.add(inner);
  const mat = skin({
    vertexColors: true, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12,
    iridescence: 0.3, iridescenceIOR: 1.3, sheen: 0.15, sheenColor: C(0x9fc8ff), envMapIntensity: 0.6
  }, { bump: 0.0012, freq: 110, style: 2, rim: 0x051640, rimPow: 3 });
  const navy = C(0x071650), blue = C(0x1446d0), sky = C(0x4f93f5), silver = C(0xc9dcf2);

  const body = new Tube(96, 28, mat, {
    flatten: 0.55,
    color: (s, up, col) => {
      if (up > 0) { col.lerpColors(sky, blue, smooth(0.1, 0.6, up)); col.lerp(navy, smooth(0.8, 0.96, up)); }
      else col.lerpColors(sky, silver, smooth(0, -0.6, up));
      col.lerp(silver, smooth(0.9, 1, s) * 0.3);
    }
  });
  inner.add(body.mesh);
  const center = (s, tm, out) => out.set(-0.45 + s, 0.07 + 0.012 * Math.sin(s * Math.PI), 0.035 * Math.sin(s * 5 - tm * 1.4) * (0.25 + s));
  const radius = s => {
    const head = Math.sqrt(Math.sin(Math.min(1, s / 0.09) * Math.PI / 2));
    const tail = s < 0.62 ? 1 : Math.pow(1 - (s - 0.62) / 0.38, 1.4);
    return 0.075 * head * tail * (1 - 0.15 * s) + 0.001;
  };

  const ceratCol = (s, up, col) => {
    col.lerpColors(silver, sky, smooth(0, 0.1, s));
    col.lerp(blue, smooth(0.1, 0.4, s));
    col.lerp(navy, smooth(0.6, 1, s));
    col.lerp(silver, smooth(0.7, 0.98, up) * 0.25);
  };
  const clusters = [];
  [[0.18, 1], [0.3, 0.95], [0.42, 0.8], [0.55, 0.6]].forEach(([s, size], k) => {
    for (const side of [1, -1]) {
      const outer = new THREE.Group(), sway = new THREE.Group();
      outer.add(sway);
      inner.add(outer);
      const r = rng(k * 7 + (side > 0 ? 1 : 2));
      const stalkLen = 0.04 * size;
      const stalk = new Tube(6, 10, mat, { color: ceratCol });
      stalk.update((u, o) => o.set(stalkLen * u, 0.006 * u, 0), u => 0.024 * size * (1 - 0.3 * u));
      sway.add(stalk.mesh);
      const n = Math.round(6 + 4 * size);
      for (let i = 0; i < n; i++) {
        const al = lerp(-1.25, 1.25, i / (n - 1)) + (r() - 0.5) * 0.15;
        const e = 0.12 + 0.4 * r();
        const L = (0.16 + 0.08 * r()) * size * (1 - 0.3 * Math.abs(al));
        const D = new THREE.Vector3(Math.cos(e) * Math.cos(al), Math.sin(e), Math.cos(e) * Math.sin(al));
        const f = new Tube(12, 8, mat, { color: ceratCol });
        f.update(
          (u, o) => o.set(stalkLen * 0.9 + D.x * L * u, 0.006 + D.y * L * u - 0.15 * L * u * u, D.z * L * u),
          u => 0.017 * size * (1 - 0.55 * u) * Math.sqrt(Math.max(0, 1 - Math.pow(u, 8))) + 0.0005
        );
        sway.add(f.mesh);
      }
      clusters.push({ outer, sway, s, side, k });
    }
  });

  // rhinophores and oral tentacles on the head
  const head = new THREE.Group();
  inner.add(head);
  for (const side of [-1, 1]) {
    for (const [from, to, rr] of [
      [[0.02, 0.022, side * 0.016], [-0.014, 0.06, side * 0.03], 0.0055],
      [[-0.005, -0.004, side * 0.02], [-0.045, -0.012, side * 0.05], 0.005]
    ]) {
      const t = new Tube(8, 8, mat, { color: (s, up, col) => col.lerpColors(sky, blue, s) });
      t.update((u, o) => o.set(lerp(from[0], to[0], u), lerp(from[1], to[1], u), lerp(from[2], to[2], u)), u => rr * (1 - 0.6 * u));
      head.add(t.mesh);
    }
  }

  const P = new THREE.Vector3(), Q = new THREE.Vector3(), T = new THREE.Vector3(), S = new THREE.Vector3();
  function update(tm) {
    body.update((s, o) => center(s, tm, o), radius);
    for (const cl of clusters) {
      center(cl.s, tm, P); center(cl.s + 0.01, tm, Q);
      T.subVectors(Q, P).normalize();
      S.crossVectors(T, UP).normalize().multiplyScalar(cl.side);
      cl.outer.position.copy(P).addScaledVector(S, radius(cl.s) * 0.8).addScaledVector(UP, 0.012);
      cl.outer.rotation.y = Math.atan2(-S.z, S.x);
      cl.sway.rotation.x = 0.18 * Math.sin(tm * 1.6 + cl.k + cl.side);
      cl.sway.rotation.z = 0.08 + 0.06 * Math.sin(tm * 1.2 + cl.k * 0.7);
    }
    center(0.03, tm, head.position);
  }
  update(0);
  return { name: 'glaucus', group, update, mats: [mat], turn: 0.35, tilt: 0.7 };
}

// ======================================================================
// Barreleye fish (Macropinna microstoma): a see-through dome over its head,
// with glowing green tube eyes inside that swivel from looking up to forward.
// ======================================================================
function makeBarreleye() {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  inner.scale.setScalar(1.25);
  group.add(inner);
  const mat = skin({
    vertexColors: true, roughness: 0.36, metalness: 0.15, clearcoat: 0.8, clearcoatRoughness: 0.2,
    sheen: 0.4, sheenColor: C(0xc9a27a), iridescence: 0.25, iridescenceIOR: 1.4
  }, { bump: 0.0018, freq: 90, style: 2, rim: 0x1a120c, rimPow: 3 });
  const dark = C(0x120e0c), bronze = C(0x3e2e22), silver = C(0x6f675c), belly = C(0x9a9384);

  const Y = 0.3;
  const body = new Tube(80, 26, mat, {
    flatten: 1.45,   // taller than it is wide, like a real fish
    color: (s, up, col) => {
      col.lerpColors(belly, silver, smooth(-0.9, -0.1, up));
      col.lerp(bronze, smooth(-0.1, 0.5, up));
      col.lerp(dark, smooth(0.5, 0.95, up));
      col.lerp(dark, 0.18 * (0.5 + 0.5 * Math.sin(s * 110)) * smooth(0.15, 0.3, s));   // rows of big scales
      col.lerp(dark, smooth(0.9, 1, s) * 0.4);
    }
  });
  inner.add(body.mesh);
  const wave = (s, tm) => 0.03 * Math.sin(s * 5 - tm * 3) * (0.2 + s);
  const center = (s, tm, out) => out.set(-0.5 + s, Y + 0.02 * Math.sin(s * Math.PI), wave(s, tm));
  const radius = s => {
    const head = Math.pow(Math.sin(Math.min(1, s / 0.26) * Math.PI / 2), 0.8);
    const taper = s < 0.4 ? 1 : 1 - 0.8 * smooth(0.4, 0.97, s);
    return 0.1 * head * taper * (1 + 0.08 * Math.sin(s * Math.PI)) + 0.006;
  };

  // the transparent shield over the head
  const domeGeo = paint(new THREE.SphereGeometry(1, 56, 28, 0, TAU, 0, Math.PI / 2), (p, col) => col.setRGB(1, 1, 1));
  domeGeo.scale(0.22, 0.25, 0.12);
  const domeMat = skin({
    color: 0xdff8ff, transparent: true, opacity: 0.3, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02,
    iridescence: 0.6, iridescenceIOR: 1.35, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.6
  }, { bump: 0, rim: 0xb0f0ff, rimPow: 1.5 });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.position.set(-0.33, Y + 0.08, 0);
  dome.renderOrder = 2;

  // glowing green tube eyes inside the dome
  const eyeMat = new THREE.MeshPhysicalMaterial({ color: 0x2f7a3a, emissive: 0x2fbf45, emissiveIntensity: 0.6, roughness: 0.3, clearcoat: 1 });
  const lensMat = new THREE.MeshPhysicalMaterial({ color: 0xc8ffc0, emissive: 0x6dff70, emissiveIntensity: 1.8, roughness: 0.1, clearcoat: 1 });
  const glowTex = glowTexture();
  const eyes = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(-0.34, Y + 0.1, side * 0.036);
    const tube = new Tube(8, 14, eyeMat);
    tube.update((u, o) => o.set(0, 0.1 * u, 0), u => 0.028 + 0.006 * u);
    pivot.add(tube.mesh);
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.034, 24, 12), lensMat);
    lens.position.y = 0.1;
    pivot.add(lens);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x6dff70, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.8 }));
    glow.position.y = 0.105;
    glow.scale.setScalar(0.2);
    pivot.add(glow);
    inner.add(pivot);
    eyes.push(pivot);
  }
  inner.add(dome);

  // the "nostrils" on the snout that look like eyes
  const nostrilMat = new THREE.MeshPhysicalMaterial({ color: 0x050404, roughness: 0.2, clearcoat: 1 });
  for (const side of [-1, 1]) {
    const n = new THREE.Mesh(new THREE.SphereGeometry(0.013, 16, 8), nostrilMat);
    n.position.set(-0.47, Y + 0.04, side * 0.042);
    inner.add(n);
  }

  // big see-through fins
  const finMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.45,
    roughness: 0.4, sheen: 0.3, sheenColor: C(0xb8ab94), depthWrite: false
  });
  const rayC = C(0x2a201a), webC = C(0x5a5048), edgeC = C(0x9a9084);
  const pecs = [], pelvics = [];
  for (const side of [-1, 1]) {
    const pec = new THREE.Mesh(finGeometry(0.26, 1.1, 10, rayC, webC, edgeC), finMat);
    pec.position.set(-0.2, Y - 0.05, side * 0.08);
    inner.add(pec);
    pecs.push({ fin: pec, side });
    const pel = new THREE.Mesh(finGeometry(0.14, 0.9, 7, rayC, webC, edgeC), finMat);
    pel.position.set(0.06, Y - 0.12, side * 0.04);
    inner.add(pel);
    pelvics.push({ fin: pel, side });
  }
  const tail = new THREE.Mesh(finGeometry(0.2, 1.25, 12, rayC, webC, edgeC), finMat);
  inner.add(tail);
  const dorsal = new THREE.Mesh(finGeometry(0.1, 0.8, 6, rayC, webC, edgeC), finMat);
  dorsal.position.set(0.2, Y + 0.07, 0);
  dorsal.rotation.z = 1.2;
  inner.add(dorsal);

  function update(tm) {
    body.update((s, o) => center(s, tm, o), radius);
    tail.position.set(0.5, Y, wave(1, tm));
    tail.rotation.y = Math.atan(0.03 * 5 * 1.2 * Math.cos(5 - tm * 3)) * 1.4;
    for (const { fin, side } of pecs) fin.rotation.set(0, -side * (0.6 + 0.3 * Math.sin(tm * 2.6 + side)), -0.5);
    for (const { fin, side } of pelvics) fin.rotation.set(0, -side * (0.35 + 0.15 * Math.sin(tm * 2.6 + 1 + side)), -1.0);
    // eyes drift between looking straight up through the dome and forward
    const look = 0.95 * smooth(-0.35, 0.35, Math.sin(tm * 0.45));
    for (const e of eyes) e.rotation.z = look;
  }
  update(0);
  return { name: 'barreleye', group, update, mats: [mat, domeMat], turn: 0.5, tilt: 0.12 };
}

// ======================================================================
// Atolla jellyfish: a deep-red pulsing bell with a ring of blue lights that
// ripple round the rim (its "burglar alarm"), and one extra-long tentacle.
// ======================================================================
function makeAtolla() {
  const group = new THREE.Group();
  const bellMat = skin({
    vertexColors: true, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.1,
    transparent: true, opacity: 0.92, sheen: 0.25, sheenColor: C(0xc02030), side: THREE.DoubleSide
  }, { bump: 0.0015, freq: 70, style: 0, rim: 0x5a0418, rimPow: 2.2 });
  const tentMat = skin({
    vertexColors: true, roughness: 0.35, clearcoat: 0.6, transparent: true, opacity: 0.85
  }, { bump: 0.0008, freq: 120, style: 2, rim: 0x3a0210, rimPow: 2 });
  const R = 0.36, TOP = 0.98, H = 0.2, LOBES = 22;
  const crimson = C(0x6a0514), deep = C(0x34030b), pale = C(0xa8243a), groove = C(0x1c0206);

  const rimRho = (phi, pulse) => R * (1 - 0.09 * pulse) * (1 + 0.05 * (0.5 + 0.5 * Math.cos(LOBES * phi))) * (1 - 0.06 * pulse);
  const rimY = pulse => TOP - H * (1 + 0.15 * pulse);
  function profile(t, phi, pulse, out) {
    let rho, y;
    if (t < 0.72) {                        // outside of the bell
      const a = (t / 0.72) * Math.PI / 2, edge = smooth(0.75, 1, t / 0.72);
      const lobe = 0.5 + 0.5 * Math.cos(LOBES * phi);
      rho = R * Math.sin(a) * (1 - 0.09 * pulse) * (1 + 0.05 * lobe * edge) * (1 - 0.06 * pulse * edge);
      rho -= 0.012 * Math.exp(-(((a - 1.0) / 0.08) ** 2));   // the coronal groove
      y = TOP - H * (1 + 0.15 * pulse) * (1 - Math.cos(a));
    } else {                               // underside, curving up into the bell
      const s = (t - 0.72) / 0.28;
      rho = rimRho(phi, pulse) * (1 - s);
      y = rimY(pulse) + 0.1 * Math.sin(s * Math.PI / 2);
    }
    return out.set(rho * Math.cos(phi), y, rho * Math.sin(phi));
  }

  const bell = new Surface(72, 132, bellMat);
  const v = new THREE.Vector3(), c = new THREE.Color();
  bell.forEach((t, phi, k) => {
    profile(t, phi, 0, v).toArray(bell.pos, k * 3);
    const n = fbm(v.x * 9, v.y * 9, v.z * 9, 3);
    if (t < 0.72) {
      const a = (t / 0.72) * Math.PI / 2;
      c.lerpColors(pale, crimson, smooth(0, 0.45, a));
      c.lerp(groove, 0.7 * Math.exp(-(((a - 1.0) / 0.1) ** 2)));
      c.lerp(pale, smooth(1.3, 1.57, a) * 0.5 * (0.5 + 0.5 * Math.cos(LOBES * phi)));
    } else {
      c.lerpColors(deep, groove, smooth(0.3, 1, (t - 0.72) / 0.28));
    }
    c.lerp(deep, clamp(n + 0.2, 0, 0.4));
    c.toArray(bell.col, k * 3);
  });
  bell.commit();
  group.add(bell.mesh);

  // a dark stomach glowing faintly through the top of the bell
  const stomach = new THREE.Mesh(new THREE.SphereGeometry(0.11, 32, 16), new THREE.MeshPhysicalMaterial({
    color: 0x3a0208, emissive: 0x700018, emissiveIntensity: 0.35, roughness: 0.4, transparent: true, opacity: 0.85
  }));
  stomach.scale.y = 0.55;
  stomach.position.y = TOP - 0.1;
  group.add(stomach);

  // tentacles hanging from the notches between the lobes, plus one long trailing one
  const tentCol = (s, up, col) => col.lerpColors(pale, crimson, smooth(0, 0.6, s)).lerp(C(0xf2b0b8), smooth(0.8, 1, s) * 0.5);
  const tentacles = [];
  for (let k = 0; k < LOBES; k++) {
    const tube = new Tube(30, 6, tentMat, { color: tentCol });
    group.add(tube.mesh);
    tentacles.push({ tube, phi: (k + 0.5) * TAU / LOBES, k, L: 0.38 + 0.18 * ((k * 7) % 5) / 4, r: 0.0045 });
  }
  const longOne = new Tube(60, 8, tentMat, { color: tentCol });
  group.add(longOne.mesh);
  tentacles.push({ tube: longOne, phi: 0.3, k: 99, L: 0.8, r: 0.012, long: true });

  // the ring of blue lights
  const lights = [];
  const blueTex = glowTexture();
  for (let i = 0; i < LOBES; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: blueTex, color: 0x4fc3ff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    group.add(s);
    lights.push(s);
  }
  const anchor = new THREE.Object3D();
  anchor.position.y = TOP - 0.15;
  group.add(anchor);
  const light = new THREE.PointLight(0x5fc8ff, 0, 1, 0);

  const P = new THREE.Vector3();
  function update(tm, scalePx) {
    const pulse = Math.pow(0.5 + 0.5 * Math.sin(tm * 2.2), 2);   // quick squeeze, slow relax
    bell.forEach((t, phi, k) => profile(t, phi, pulse, v).toArray(bell.pos, k * 3));
    bell.commit();
    group.position.y = 0.03 * pulse;

    const ry = rimY(pulse);
    for (const tn of tentacles) {
      const { phi, k, L, r, long } = tn, cp = Math.cos(phi), sp = Math.sin(phi);
      const rho0 = rimRho(phi, pulse) * 0.96;
      tn.tube.update((s, o) => {
        const sway = (long ? 0.13 : 0.07) * Math.pow(s, 1.2) * Math.sin(tm * (long ? 1.1 : 1.8) + k + s * (long ? 7 : 6));
        const out = rho0 + (long ? 0.1 : 0.04) * s + 0.02 * Math.sin(tm * 1.3 + k) * s;
        o.set(cp * out - sp * sway, ry - L * s, sp * out + cp * sway);
      }, s => r * (1 - 0.75 * s) + 0.0015);
    }

    // a wave of light racing round the rim
    let total = 0;
    lights.forEach((sp, i) => {
      const phi = i * TAU / LOBES;
      const b = Math.pow(0.5 + 0.5 * Math.sin(tm * 5 - i * TAU / LOBES * 2), 4);
      total += b;
      P.set(Math.cos(phi) * rimRho(phi, pulse) * 0.97, ry - 0.01, Math.sin(phi) * rimRho(phi, pulse) * 0.97);
      sp.position.copy(P);
      sp.scale.setScalar(0.09 + 0.14 * b);
      sp.material.opacity = 0.45 + 0.55 * b;
    });
    anchor.updateWorldMatrix(true, false);
    anchor.getWorldPosition(light.position);
    light.intensity = 0.8 + 1.6 * total / LOBES;
    light.distance = 1.3 * scalePx;
  }
  update(0, 100);
  return { name: 'atolla', group, update, mats: [bellMat, tentMat], light, turn: 0, tilt: 0.35 };
}

// ======================================================================
// Stage: one renderer, a camera matched to canvas pixels, and the lights.
// ======================================================================
export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x3a2e28, 0.9));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
  key.position.set(-0.6, 1, 0.9);
  const rim = new THREE.DirectionalLight(0x9fd0ff, 1.6);
  rim.position.set(0.8, 0.6, -1);
  scene.add(key, rim);

  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 1, 10000);
  const creatures = [makeDumbo(), makeAngler(), makeGlaucus(), makeBarreleye(), makeAtolla()];
  for (const c of creatures) {
    c.root = new THREE.Group();
    c.yawGroup = new THREE.Group();
    c.root.add(c.yawGroup);
    c.yawGroup.add(c.group);
    c.root.visible = false;
    c.yaw = null;
    scene.add(c.root);
    if (c.light) scene.add(c.light);
  }

  let w = 0, h = 0;
  return {
    count: creatures.length,
    // items: [{ index, x, y, z, size, facing, scale, spin, squash }] in canvas pixels (z > 0 is towards you)
    // squash: { amount, nx, ny } flattens the creature along the screen direction (nx, ny), bulging it sideways
    render(W, H, t, items) {
      if (W !== w || H !== h) {
        w = W; h = H;
        renderer.setSize(W, H, false);
        const dist = (H / 2) / Math.tan(camera.fov * Math.PI / 360);   // 1 world unit = 1 canvas pixel at z = 0
        camera.aspect = W / H;
        camera.position.set(0, 0, dist);
        camera.near = dist * 0.05;
        camera.far = dist * 4;
        camera.updateProjectionMatrix();
      }
      for (const c of creatures) { c.root.visible = false; if (c.light) c.light.intensity = 0; }
      for (const it of items) {
        const c = creatures[it.index];
        const px = Math.max(1e-3, it.size * it.scale);
        c.root.visible = true;
        c.root.position.set(it.x - W / 2, H / 2 - it.y, it.z || 0);
        const q = it.squash;
        if (q && q.amount) {
          // squash along the contact direction, bulge across it (roughly keeping volume)
          const ax = Math.abs(q.nx), ay = Math.abs(q.ny), k = q.amount;
          c.root.scale.set(px * (1 - k * ax + 0.5 * k * ay), px * (1 - k * ay + 0.5 * k * ax), px * (1 + 0.35 * k));
        } else c.root.scale.setScalar(px);
        c.root.rotation.set(c.tilt, 0, it.spin || 0);
        const goal = it.facing < 0 ? c.turn : Math.PI - c.turn;
        c.yaw = c.yaw === null ? goal : c.yaw + (goal - c.yaw) * 0.08;
        c.yawGroup.rotation.y = c.yaw;
        c.root.updateMatrixWorld(true);
        c.update(t, px);
        for (const m of c.mats) m.userData.skin.uScale.value = px;
      }
      renderer.render(scene, camera);
    },
    clear() { renderer.clear(); }
  };
}
