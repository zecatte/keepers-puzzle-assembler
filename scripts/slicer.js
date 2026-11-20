/**
 * Keeper's Puzzle Assembler - slicing engine.
 * Pure geometry + offscreen <canvas> rendering. No Foundry document access.
 * All geometry lives in "work space": the image scaled so its longest side is WORK_SIZE px.
 */

export const WORK_SIZE = 720;
const STEP = 6; // jagged-edge sampling step in px

export const PATTERNS = [
  { value: "grid", label: "Standard Grid" },
  { value: "bsp", label: "Random-Sized Rectangles" },
  { value: "torn", label: "Torn Document / Jagged Paper" },
  { value: "voronoi", label: "Shattered / Voronoi Shards" },
  { value: "tornshards", label: "Torn Shards (Voronoi + Mixed Tear Edges)" }
];

/* ------------------------------------------------------------------ */
/*  Utilities                                                          */
/* ------------------------------------------------------------------ */

export function makeRng(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function workSize(imgW, imgH) {
  const s = WORK_SIZE / Math.max(imgW, imgH);
  return { width: Math.max(1, Math.round(imgW * s)), height: Math.max(1, Math.round(imgH * s)) };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ------------------------------------------------------------------ */
/*  Pattern generators - each returns an array of polygons [[x,y],...] */
/* ------------------------------------------------------------------ */

function layoutRows(n, W, H) {
  let rows = Math.round(Math.sqrt((n * H) / W));
  rows = Math.min(n, Math.max(1, rows));
  const base = Math.floor(n / rows);
  const extra = n % rows;
  const ys = [];
  const xs = [];
  for (let r = 0; r <= rows; r++) ys.push((H * r) / rows);
  for (let r = 0; r < rows; r++) {
    // spread the longer rows through the grid rather than stacking them
    const c = base + (Math.floor(((r + 1) * extra) / rows) - Math.floor((r * extra) / rows));
    const row = [];
    for (let j = 0; j <= c; j++) row.push((W * j) / c);
    xs.push(row);
  }
  return { rows, ys, xs };
}

function gridPolys(n, W, H) {
  const L = layoutRows(n, W, H);
  const polys = [];
  for (let r = 0; r < L.rows; r++) {
    const xs = L.xs[r];
    for (let j = 0; j < xs.length - 1; j++) {
      polys.push([[xs[j], L.ys[r]], [xs[j + 1], L.ys[r]], [xs[j + 1], L.ys[r + 1]], [xs[j], L.ys[r + 1]]]);
    }
  }
  return polys;
}

function bspPolys(n, W, H, rng) {
  const rects = [{ x: 0, y: 0, w: W, h: H }];
  let guard = 0;
  while (rects.length < n && guard++ < 1000) {
    const total = rects.reduce((s, r) => s + r.w * r.h, 0);
    let pick = rng() * total;
    let idx = 0;
    for (let i = 0; i < rects.length; i++) {
      pick -= rects[i].w * rects[i].h;
      if (pick <= 0) { idx = i; break; }
    }
    const r = rects[idx];
    const ratio = 0.3 + rng() * 0.4;
    let vertical;
    if (r.w / r.h > 1.25) vertical = true;
    else if (r.h / r.w > 1.25) vertical = false;
    else vertical = rng() < 0.5;
    if (vertical && r.w < 24) vertical = false;
    if (!vertical && r.h < 24) vertical = true;
    let a, b;
    if (vertical) {
      const w1 = r.w * ratio;
      a = { x: r.x, y: r.y, w: w1, h: r.h };
      b = { x: r.x + w1, y: r.y, w: r.w - w1, h: r.h };
    } else {
      const h1 = r.h * ratio;
      a = { x: r.x, y: r.y, w: r.w, h: h1 };
      b = { x: r.x, y: r.y + h1, w: r.w, h: r.h - h1 };
    }
    rects.splice(idx, 1, a, b);
  }
  return rects.map(r => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]);
}

/** Smooth-plus-rough random series (zero amplitude is applied by the caller at the ends). */
function roughSeries(rng, n, amp) {
  const out = new Array(n).fill(0);
  const cn = Math.ceil(n / 4) + 2;
  const coarse = [];
  for (let i = 0; i < cn; i++) coarse.push((rng() * 2 - 1) * amp * 0.8);
  for (let i = 0; i < n; i++) {
    const u = i / 4;
    const a = Math.floor(u);
    const f = u - a;
    out[i] = coarse[a] * (1 - f) + coarse[a + 1] * f + (rng() * 2 - 1) * amp * 0.35;
  }
  out[0] = 0;
  out[n - 1] = 0;
  return out;
}

function interpIdx(arr, u) {
  const i = Math.min(Math.max(Math.floor(u), 0), arr.length - 2);
  const f = Math.min(Math.max(u - i, 0), 1);
  return arr[i] * (1 - f) + arr[i + 1] * f;
}

function tornPolys(n, W, H, rng) {
  const L = layoutRows(n, W, H);
  const rows = L.rows;
  const cellH = H / rows;
  const minCellW = Math.min(...L.xs.map(r => W / (r.length - 1)));
  const ampH = Math.min(cellH, minCellW) * 0.09;
  const ampV = Math.min(cellH, minCellW) * 0.09;
  const gridN = Math.ceil(W / STEP) + 1;
  const spacing = W / (gridN - 1);

  const hl = [null];
  for (let k = 1; k < rows; k++) hl[k] = roughSeries(rng, gridN, ampH);
  const lineY = (k, x) => L.ys[k] + (k === 0 || k === rows ? 0 : interpIdx(hl[k], x / spacing));

  const sampleXs = (a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const pts = [lo];
    for (let i = Math.floor(lo / spacing) + 1; i * spacing < hi - 1e-6; i++) pts.push(i * spacing);
    pts.push(hi);
    return a <= b ? pts : pts.reverse();
  };

  const vN = Math.ceil((cellH * 1.6) / STEP) + 2;
  const vArr = {};
  const vert = (r, j, c, x, y0, y1) => {
    if (j === 0 || j === c) return [[x, y0], [x, y1]];
    const key = `${r}:${j}`;
    if (!vArr[key]) vArr[key] = roughSeries(rng, vN, ampV);
    const m = Math.max(2, Math.ceil(Math.abs(y1 - y0) / STEP));
    const pts = [];
    for (let i = 0; i <= m; i++) {
      const t = i / m;
      pts.push([x + interpIdx(vArr[key], t * (vN - 1)), y0 + (y1 - y0) * t]);
    }
    return pts;
  };

  const polys = [];
  for (let r = 0; r < rows; r++) {
    const xs = L.xs[r];
    const c = xs.length - 1;
    for (let j = 0; j < c; j++) {
      const xa = xs[j];
      const xb = xs[j + 1];
      const pts = [];
      for (const x of sampleXs(xa, xb)) pts.push([x, lineY(r, x)]);
      const right = vert(r, j + 1, c, xb, lineY(r, xb), lineY(r + 1, xb));
      for (let i = 1; i < right.length; i++) pts.push(right[i]);
      const bottom = sampleXs(xb, xa);
      for (let i = 1; i < bottom.length; i++) pts.push([bottom[i], lineY(r + 1, bottom[i])]);
      const left = vert(r, j, c, xa, lineY(r, xa), lineY(r + 1, xa)).reverse();
      for (let i = 1; i < left.length - 1; i++) pts.push(left[i]);
      polys.push(pts);
    }
  }
  return polys;
}

function clipPoly(poly, d, c) {
  // keep the half-plane where 2*(x . d) - c <= 0
  const out = [];
  const f = p => 2 * (p[0] * d[0] + p[1] * d[1]) - c;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a);
    const fb = f(b);
    if (fa <= 0) out.push(a);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function voronoiCells(points, W, H) {
  return points.map((p, i) => {
    let poly = [[0, 0], [W, 0], [W, H], [0, H]];
    for (let k = 0; k < points.length && poly.length; k++) {
      if (k === i) continue;
      const q = points[k];
      const d = [q[0] - p[0], q[1] - p[1]];
      const c = q[0] * q[0] + q[1] * q[1] - p[0] * p[0] - p[1] * p[1];
      poly = clipPoly(poly, d, c);
    }
    return poly;
  });
}

function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const cr = x0 * y1 - x1 * y0;
    a += cr;
    cx += (x0 + x1) * cr;
    cy += (y0 + y1) * cr;
  }
  if (Math.abs(a) < 1e-6) return poly[0] ?? [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

function voronoiPolys(n, W, H, rng) {
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * W) / H)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cw = W / cols;
  const ch = H / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
  shuffle(cells, rng);
  let pts = cells.slice(0, n).map(([r, c]) => [
    (c + 0.5 + (rng() - 0.5) * 0.7) * cw,
    (r + 0.5 + (rng() - 0.5) * 0.7) * ch
  ]);
  // one light Lloyd relaxation keeps shards from becoming slivers while staying angular
  const relaxed = voronoiCells(pts, W, H);
  pts = pts.map((p, i) => (relaxed[i].length >= 3 ? centroid(relaxed[i]).map((v, k) => v * 0.6 + p[k] * 0.4) : p));
  return voronoiCells(pts, W, H).filter(p => p.length >= 3);
}

/**
 * Voronoi layout with irregular piece sizes, where every shared edge is replaced by its own
 * tear: ragged, wavy, stepped (notched) or sawtooth, each with a random amplitude and grain.
 * Both neighbours build the edge from the same canonical points, so they fit exactly.
 */
function tearEdge(rng, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 8) return [];
  const nx = -dy / len;
  const ny = dx / len;
  const amp = Math.min(14, len * (0.04 + rng() * 0.1));
  const step = 3 + rng() * 6;
  const m = Math.max(3, Math.ceil(len / step));
  const type = Math.floor(rng() * 4);
  const offs = []; // [t, offset]
  if (type === 0) { // ragged
    const ser = roughSeries(rng, m + 1, amp);
    ser.forEach((o, i) => offs.push([i / m, o]));
  } else if (type === 1) { // wavy with light fibre noise
    const waves = 1 + rng() * 3;
    const ph = rng() * 6.28;
    for (let i = 0; i <= m; i++) {
      const t = i / m;
      offs.push([t, Math.sin(ph + t * waves * 6.283) * amp * Math.sin(t * Math.PI) + (rng() - 0.5) * amp * 0.25 * (i > 0 && i < m)]);
    }
  } else if (type === 2) { // stepped notches
    const k = 3 + Math.floor(rng() * 6);
    const ts = [0];
    for (let i = 1; i < k; i++) ts.push(i / k + (rng() - 0.5) * 0.5 / k);
    ts.push(1);
    ts.sort((u, v) => u - v);
    for (let i = 0; i < ts.length - 1; i++) {
      const o = i === 0 || i === ts.length - 2 ? 0 : (rng() * 2 - 1) * amp;
      offs.push([ts[i], o], [ts[i + 1], o]);
    }
  } else { // sawtooth
    const teeth = 3 + Math.floor(rng() * 7);
    for (let i = 0; i <= teeth; i++) {
      const t = i / teeth;
      const edgeFade = i === 0 || i === teeth ? 0 : 1;
      offs.push([t, (i % 2 ? 1 : -1) * amp * edgeFade * (0.6 + rng() * 0.4)]);
    }
  }
  offs[0][1] = 0;
  offs[offs.length - 1][1] = 0;
  return offs.map(([t, o]) => [a[0] + dx * t + nx * o, a[1] + dy * t + ny * o]);
}

function tornShardPolys(n, W, H, rng, seed) {
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * W) / H)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cw = W / cols;
  const ch = H / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
  shuffle(cells, rng);
  const pts = cells.slice(0, n).map(([r, c]) => [(c + 0.5 + (rng() - 0.5) * 1.1) * cw, (r + 0.5 + (rng() - 0.5) * 1.1) * ch]
    .map((v, k) => Math.min(k ? H : W, Math.max(0, v))));
  const polys = voronoiCells(pts, W, H).filter(p => p.length >= 3);
  const key = (a, b) => {
    const ka = `${Math.round(a[0] * 5)},${Math.round(a[1] * 5)}`;
    const kb = `${Math.round(b[0] * 5)},${Math.round(b[1] * 5)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const count = new Map();
  for (const poly of polys) for (let i = 0; i < poly.length; i++) {
    const k = key(poly[i], poly[(i + 1) % poly.length]);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const cache = new Map();
  return polys.map(poly => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      out.push(a);
      const k = key(a, b);
      if (count.get(k) !== 2) continue; // outer border stays straight
      const forward = `${Math.round(a[0] * 5)},${Math.round(a[1] * 5)}` < `${Math.round(b[0] * 5)},${Math.round(b[1] * 5)}`;
      if (!cache.has(k)) {
        const [ca, cb] = forward ? [a, b] : [b, a];
        let h = (Number(seed) || 1) >>> 0;
        for (const ch2 of k) h = Math.imul(h ^ ch2.charCodeAt(0), 16777619) >>> 0;
        cache.set(k, tearEdge(makeRng(h), ca, cb));
      }
      const pts2 = cache.get(k);
      const mid = pts2.slice(1, -1);
      out.push(...(forward ? mid : mid.slice().reverse()));
    }
    return out;
  });
}

/* ------------------------------------------------------------------ */
/*  Public slicing API                                                 */
/* ------------------------------------------------------------------ */

/**
 * @param {{pattern:string,count:number,width:number,height:number,seed:number}} opts
 * @returns {{id:string,polygon:number[][],bbox:{x:number,y:number,w:number,h:number}}[]}
 */
export function slicePuzzle({ pattern, count, width, height, seed }) {
  const n = Math.min(64, Math.max(2, Math.round(count)));
  const rng = makeRng(seed);
  let polys;
  switch (pattern) {
    case "bsp": polys = bspPolys(n, width, height, rng); break;
    case "torn": polys = tornPolys(n, width, height, rng); break;
    case "voronoi": polys = voronoiPolys(n, width, height, rng); break;
    case "tornshards": polys = tornShardPolys(n, width, height, rng, seed); break;
    default: polys = gridPolys(n, width, height);
  }
  const clamp = (v, max) => Math.round(Math.min(max, Math.max(0, v)) * 10) / 10;
  return polys.map((poly, i) => {
    const polygon = poly.map(([x, y]) => [clamp(x, width), clamp(y, height)]);
    const xsv = polygon.map(p => p[0]);
    const ysv = polygon.map(p => p[1]);
    const x = Math.floor(Math.min(...xsv));
    const y = Math.floor(Math.min(...ysv));
    const w = Math.max(1, Math.ceil(Math.max(...xsv)) - x);
    const h = Math.max(1, Math.ceil(Math.max(...ysv)) - y);
    return { id: `p${i}`, polygon, bbox: { x, y, w, h } };
  });
}

/* ------------------------------------------------------------------ */
/*  Image loading + canvas rendering                                   */
/* ------------------------------------------------------------------ */

export function resolveImageUrl(src) {
  if (!src) return "";
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  let url = globalThis.foundry?.utils?.getRoute ? foundry.utils.getRoute(src) : src;
  try { url = encodeURI(decodeURI(url)); } catch (e) { /* keep as is */ }
  return url;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image: ${src}`));
    img.src = resolveImageUrl(src);
  });
}

function tracePolygon(ctx, polygon, dx = 0, dy = 0) {
  ctx.beginPath();
  polygon.forEach(([x, y], i) => (i ? ctx.lineTo(x - dx, y - dy) : ctx.moveTo(x - dx, y - dy)));
  ctx.closePath();
}

/** Render a transparent-background texture for every piece. Returns {pieceId: dataUrl}. */
export async function renderPieceTextures(img, pieces, width, height, pattern = "grid") {
  const out = {};
  for (const p of pieces) {
    const { x, y, w, h } = p.bbox;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.save();
    tracePolygon(ctx, p.polygon, x, y);
    ctx.clip();
    ctx.drawImage(img, -x, -y, width, height);
    if (pattern === "torn" || pattern === "tornshards") {
      // pale fibrous paper edge
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(245,235,215,0.35)";
      tracePolygon(ctx, p.polygon, x, y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = pattern === "voronoi" ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.45)";
    tracePolygon(ctx, p.polygon, x, y);
    ctx.stroke();
    let url = canvas.toDataURL("image/webp", 0.92);
    if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/png");
    out[p.id] = url;
  }
  return out;
}

/** Live cut-line preview for the Keeper's creator window. */
export function drawPreview(canvas, img, pieces, width, height) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, width, height);
  if (img) {
    ctx.globalAlpha = 0.6;
    ctx.drawImage(img, 0, 0, width, height);
    ctx.globalAlpha = 1;
  }
  ctx.lineJoin = "round";
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#ffbf47";
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 3;
  for (const p of pieces) {
    tracePolygon(ctx, p.polygon);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineWidth = 3;
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  pieces.forEach((p, i) => {
    const [cx, cy] = centroid(p.polygon);
    ctx.strokeText(String(i + 1), cx, cy);
    ctx.fillText(String(i + 1), cx, cy);
  });
}
