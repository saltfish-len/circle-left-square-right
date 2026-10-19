/* ---------------------------------------------------------------
 * One-stroke shapes: definitions, progress tracking while drawing, and scoring. Pure logic with no DOM,
 * so it can be tested directly in node / bun.
 *
 * Shapes are defined in unit coordinates: centred on (0,0), half-width about 1, y pointing down (as on screen).
 * points[0] is the start. Closed shapes can be drawn either way round (the direction is detected at the start);
 * open shapes must go from start to end.
 * To add a shape: add an entry to SHAPES (points are polyline vertices; sample curves densely), then pair it in LEVELS.
 * ------------------------------------------------------------- */

const TAU = Math.PI * 2;
const loop = (n, f) => Array.from({ length: n }, (_, i) => f(i / n * TAU));          // closed: end point not repeated
const curve = (n, f) => Array.from({ length: n + 1 }, (_, i) => f(i / n));           // open: both ends included

export const SHAPES = {
  circle:   { name: "circle", closed: true, points: loop(120, a => [Math.sin(a), -Math.cos(a)]) },   // starts at 12 o'clock
  square:   { name: "square", closed: true, points: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },          // starts top left
  triangle: { name: "triangle", closed: true, points: [[0, -0.87], [1, 0.87], [-1, 0.87]] },       // starts at the apex
  star:     { name: "star", closed: true,                                                           // starts at the top, joins every other point
    points: [0, 2, 4, 1, 3].map(k => { const a = -Math.PI / 2 + k * TAU / 5; return [Math.cos(a), Math.sin(a) + 0.1]; }) },
  heart:    { name: "heart", closed: true,                                                          // starts at the top notch
    points: loop(160, t => [Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 16 - 0.15]) },
  infinity: { name: "infinity", closed: true, points: loop(160, t => [Math.sin(t), 1.3 * Math.sin(t) * Math.cos(t)]) },  // starts at the crossing
  wave:     { name: "wave", closed: false, points: curve(120, k => [2 * k - 1, -0.55 * Math.sin(k * 2 * TAU)]) },
  zigzag:   { name: "zigzag", closed: false, points: [[-1, 0.55], [-0.5, -0.55], [0, 0.55], [0.5, -0.55], [1, 0.55]] },
  spiral:   { name: "spiral", closed: false, points: curve(200, k => { const a = k * 2.25 * TAU; return [k * Math.sin(a), -k * Math.cos(a)]; }) },
};

// Levels: what the left and right hands draw. Optional mirrorLeft / mirrorRight flip that side's shape horizontally (for mirror-image movements)
export const LEVELS = [
  { left: "circle", right: "square" },
  { left: "square", right: "circle" },
  { left: "circle", right: "triangle" },
  { left: "triangle", right: "square" },
  { left: "heart", right: "circle" },
  { left: "circle", right: "star" },
  { left: "infinity", right: "square" },
  { left: "wave", right: "zigzag" },
  { left: "spiral", right: "square" },
];

export const TUNE = {
  step: 0.02,              // point spacing of the dense path
  startR: 0.16,            // radius of the start / end zones
  tol: 0.45,               // progress stops advancing when the fingertip is further than this from the path
  fwd: 0.5, back: 0.15,    // per-frame search window along the path: stops jumps at crossings and between neighbouring turns
  lockAt: 0.12,            // closed shapes: lock the direction once progress passes this
  doneAt: 0.985, doneNear: 0.93,  // done when progress ≥ doneAt, or ≥ doneNear and back in the end zone
  maxOffset: 0.2,          // how far the whole stroke may be shifted when scoring (camera mapping is never exact; don't penalise it)
  shapeK: 0.08,            // shape score: error = shapeK gives 50 points
  coverD: 0.15,            // template points further than this from the ink count as missed
  syncK: 0.07,             // sync score: mean progress gap = syncK gives 50 points
};

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function densify(points, closed) {
  const src = closed ? [...points, points[0]] : points, pts = [src[0]], cum = [0];
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i], len = dist(a, b), n = Math.max(1, Math.ceil(len / TUNE.step));
    for (let k = 1; k <= n; k++) { pts.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); cum.push(cum.at(-1) + len / n); }
  }
  return { pts, cum, L: cum.at(-1) };
}

// a closed path walked backwards, same start point
function reversePath({ pts, cum, L }) {
  return { pts: [...pts].reverse(), cum: [...cum].reverse().map(c => L - c), L };
}

export function polyLength(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }

export function resample(pts, n) {
  const L = polyLength(pts);
  if (!(L > 0)) return Array.from({ length: n }, () => pts[0]);
  const out = [pts[0]], step = L / (n - 1);
  let acc = 0, i = 1, prev = pts[0];
  while (out.length < n - 1 && i < pts.length) {
    const d = dist(prev, pts[i]);
    if (acc + d >= step) {
      const k = (step - acc) / d, q = [prev[0] + (pts[i][0] - prev[0]) * k, prev[1] + (pts[i][1] - prev[1]) * k];
      out.push(q); prev = q; acc = 0;
    } else { acc += d; prev = pts[i++]; }
  }
  while (out.length < n) out.push(pts.at(-1));
  return out;
}

function distToPoly(p, poly) {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const k = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - k * dx, p[1] - a[1] - k * dy));
  }
  return best;
}

function nearestPt(p, pts) {
  let bd = Infinity, bq = pts[0];
  for (const q of pts) { const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; if (d < bd) { bd = d; bq = q; } }
  return bq;
}

/* Progress along a path: each frame only searches a window around the current position, and doesn't advance
 * when the fingertip is too far from the path. `best` never decreases. */
class Tracker {
  constructor(path) { this.path = path; this.i = 0; this.best = 0; this.d = 0; }
  get progress() { return this.path.cum[this.best] / this.path.L; }
  update(p) {
    const { pts, cum } = this.path, s = cum[this.i];
    let bi = this.i, bd = Infinity;
    for (let j = this.i; j >= 0 && cum[j] >= s - TUNE.back; j--) { const d = dist(p, pts[j]); if (d < bd) { bd = d; bi = j; } }
    for (let j = this.i + 1; j < pts.length && cum[j] <= s + TUNE.fwd; j++) { const d = dist(p, pts[j]); if (d < bd) { bd = d; bi = j; } }
    this.d = bd;
    if (bd <= TUNE.tol) { this.i = bi; if (bi > this.best) this.best = bi; }
  }
}

/* One hand's stroke. Feed update() the fingertip in unit coordinates (skip frames where the hand is lost).
 * state: wait (still in the start zone after the start signal) → draw (left the start zone) → done */
export class Stroke {
  constructor(key, mirror = false) {
    this.key = key; this.shape = SHAPES[key];
    const fwd = densify(this.shape.points.map(([x, y]) => [mirror ? -x : x, y]), this.shape.closed);
    this.paths = this.shape.closed ? [fwd, reversePath(fwd)] : [fwd];
    this.reset();
  }
  reset() {
    this.trackers = this.paths.map(p => new Tracker(p));
    this.dir = 0; this.locked = this.paths.length === 1;
    this.trace = []; this.state = "wait"; this.tDepart = this.tDone = null;
  }
  get start() { return this.paths[0].pts[0]; }
  get end() { return this.paths[0].pts.at(-1); }
  get path() { return this.paths[this.dir]; }
  get progress() { return this.state === "done" ? 1 : this.trackers[this.dir].progress; }
  get offPath() { return this.state === "draw" ? this.trackers[this.dir].d : 0; }

  // the point at progress k along the current direction
  pointAt(k) {
    const { pts, cum, L } = this.path, s = Math.max(0, Math.min(1, k)) * L;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m; else hi = m; }
    const span = cum[hi] - cum[lo], u = span ? (s - cum[lo]) / span : 0;
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * u, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * u];
  }

  update(p, t) {
    if (this.state === "done") return;
    this.trace.push(p);
    if (this.state === "wait") { if (dist(p, this.start) <= TUNE.startR) return; this.state = "draw"; this.tDepart = t; }
    for (const tr of this.trackers) tr.update(p);
    if (!this.locked) {
      const [a, b] = this.trackers.map(tr => tr.progress);
      this.dir = b > a ? 1 : 0;
      if (Math.max(a, b) >= TUNE.lockAt) this.locked = true;
    }
    const k = this.trackers[this.dir].progress;
    if (k >= TUNE.doneAt || (k >= TUNE.doneNear && dist(p, this.end) < TUNE.startR)) { this.state = "done"; this.tDone = t; }
  }
}

/* Shape score: two-way distance between ink and template (ink → template measures wobble; template → ink
 * measures missed parts / rounded corners). A translation-only ICP runs first so a small overall offset
 * isn't penalised. Returns { score 0–100, err, fit, coverage } */
export function shapeScore(stroke) {
  const raw = stroke.trace;
  if (raw.length < 3 || polyLength(raw) < 0.3) return { score: 0, err: null, fit: 0, coverage: 0 };
  const tpl = stroke.path.pts, tr = resample(raw, 160);
  let off = [0, 0];
  for (let it = 0; it < 6; it++) {
    let mx = 0, my = 0;
    for (const p of tr) { const q = [p[0] + off[0], p[1] + off[1]], n = nearestPt(q, tpl); mx += n[0] - q[0]; my += n[1] - q[1]; }
    off = [off[0] + mx / tr.length, off[1] + my / tr.length];
    const m = Math.hypot(...off);
    if (m > TUNE.maxOffset) off = off.map(v => v * TUNE.maxOffset / m);
  }
  const T = tr.map(p => [p[0] + off[0], p[1] + off[1]]);
  const d1 = T.map(p => distToPoly(p, tpl));
  const d2 = resample(tpl, 160).map(p => distToPoly(p, T));
  const ms = a => a.reduce((s, d) => s + d * d, 0) / a.length;
  const err = Math.sqrt((ms(d1) + ms(d2)) / 2);
  const coverage = d2.filter(d => d < TUNE.coverD).length / d2.length;
  const fit = 1 / (1 + (err / TUNE.shapeK) ** 2);
  return { score: Math.round(100 * fit * coverage), err, fit, coverage, offset: off };
}

/* Sync score: time-averaged progress gap between the hands, from when the first hand leaves its start dot
 * until both are done (or the round ends). samples: [{ t, a, b }], a / b = left / right progress.
 * Returns { score, mean, lead }; lead > 0 means the left hand was ahead overall. */
export function syncScore(samples, tEnd) {
  const t0 = samples.find(s => s.a > 0 || s.b > 0)?.t;
  if (t0 == null) return { score: 0, mean: null, lead: 0 };
  let acc = 0, signed = 0, T = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], t1 = Math.min(tEnd, samples[i + 1]?.t ?? tEnd), dt = t1 - Math.max(t0, s.t);
    if (dt <= 0) continue;
    acc += Math.abs(s.a - s.b) * dt; signed += (s.a - s.b) * dt; T += dt;
  }
  const mean = T ? acc / T : 0;
  return { score: Math.round(100 / (1 + (mean / TUNE.syncK) ** 2)), mean, lead: T ? signed / T : 0 };
}

export const totalScore = (l, r, s) => Math.round(0.3 * l + 0.3 * r + 0.4 * s);
export const rank = v => v >= 90 ? "S" : v >= 80 ? "A" : v >= 65 ? "B" : v >= 50 ? "C" : "D";
