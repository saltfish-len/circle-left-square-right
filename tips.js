/* ---------------------------------------------------------------
 * Index fingertips of two hands: de-duplication, left/right assignment, per-frame jump gate.
 * Pure logic with no DOM, so it can be tested directly with bun.
 *
 * Input per frame: detections [{ lm: 21 × [x, y] (screen px), score }]; output { L, R } fingertips (px or null).
 * Only landmark 8 (index tip) is used as the pen; the other points only measure hand size, find the palm centre,
 * and recover the index tip when landmark 8 is misidentified.
 * ------------------------------------------------------------- */

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const PALM = [0, 5, 9, 13, 17];
export const palmOf = lm => [0, 1].map(k => PALM.reduce((s, i) => s + lm[i][k], 0) / PALM.length);
// The larger of palm length (wrist → middle knuckle) and palm width (index → pinky knuckle):
// the palm stays roughly in the image plane even when a finger points at the camera
export const handSize = lm => Math.max(20, dist(lm[0], lm[9]), dist(lm[5], lm[17]));

export const TIP = {
  checks: true,     // false: skip the fingertip checks (swap / collapse / jump) and use the model's landmark 8 as is; assignment is unaffected
  dupe: 0.5,        // palm centres closer than dupe × hand size → the same hand detected twice
  staleMs: 400,     // a hand unseen for this long is assigned by screen half instead of by its last position
  follow: 2.5,      // with one detection, it belongs to a hand only if within follow × hand size of that hand's last palm centre
  swapRatio: 0.6,   // swapped index/thumb fits better than swapRatio × the unswapped error → labels were swapped
  swapMax: 0.35,    // …and the swapped index tip is within swapMax × hand size of the prediction
  maxSwaps: 10,     // after this many swaps in a row, trust the model again (so one bad call can't lock onto the thumb)
  collapse: 0.12,   // landmarks 8 and 4 within collapse × hand size, with 8 on the thumb side → index tip collapsed onto the thumb; drop the frame
  jumpMin: 0.25,    // only consider the two cases above when the index tip is more than jumpMin × hand size from the prediction
  gate: 0.8,        // the chosen point more than gate × hand size from the prediction is a jump; drop the frame
  relock: 4,        // if this many frames in a row land in the same new spot (not a glitch), accept it
  vKeep: 0.6,       // velocity smoothing
};

// Duplicate detections of one hand: palm centres too close, keep the higher score
export function dedupe(dets) {
  if (dets.length < 2) return dets;
  const [a, b] = dets, hs = Math.max(handSize(a.lm), handSize(b.lm));
  if (dist(palmOf(a.lm), palmOf(b.lm)) < TIP.dupe * hs) return [(a.score ?? 0) >= (b.score ?? 0) ? a : b];
  return dets;
}

/* Left/right assignment: when both hands are being tracked, by palm-centre continuity (whichever of the two
 * pairings has the smaller total distance); otherwise by screen position (the leftmost is the left hand).
 * A single detection goes to the nearest tracked hand, or else by which half of the screen it's in. */
export function assignHands(dets, tracks, t, midX) {
  dets = dedupe(dets);
  const out = { L: null, R: null }, { L, R } = tracks;
  const fresh = tr => tr.palm && t - tr.t < TIP.staleMs;
  const px = d => palmOf(d.lm);
  if (dets.length >= 2) {
    const [a, b] = dets;
    let keep;
    if (fresh(L) && fresh(R)) keep = dist(px(a), L.palm) + dist(px(b), R.palm) <= dist(px(a), R.palm) + dist(px(b), L.palm);
    else keep = px(a)[0] <= px(b)[0];
    [out.L, out.R] = keep ? [a, b] : [b, a];
  } else if (dets.length === 1) {
    const d = dets[0], p = px(d), lim = TIP.follow * handSize(d.lm);
    const cand = [L, R].filter(tr => fresh(tr) && dist(p, tr.palm) < lim).sort((x, y) => dist(p, x.palm) - dist(p, y.palm));
    out[cand.length ? cand[0].side : p[0] < midX ? "L" : "R"] = d;
  }
  return out;
}

/* Fingertip tracking for one hand. Follows both the index tip (8) and the thumb tip (4) and predicts this frame
 * from the last position plus velocity:
 * - swap: with 8 and 4 exchanged, both points fit their predictions better → the model swapped index and thumb;
 *   swap them back. Both points are checked together, so a lone landmark 8 flying near the thumb isn't a swap
 * - collapse: 8 and 4 coincide on the thumb side → no trustworthy index tip this frame; drop it
 * - the chosen point is still too far from the prediction → a glitch; drop the frame (the filter holds briefly)
 * - relock frames in a row land in the same new spot → it really moved there; accept it
 * `last` records this frame's decision (ok / swap / collapse / reject / relock / init; raw with checks off)
 * for the debug overlay and the log. */
export class TipTrack {
  constructor(side) { this.side = side; this.reset(); }
  reset() {
    this.tip = this.thumb = this.palm = null; this.v = [0, 0]; this.t = -1e9;
    this.rejects = 0; this.pending = null; this.swaps = 0; this.last = null;
    this.stats = { raw: 0, init: 0, ok: 0, swap: 0, collapse: 0, reject: 0, relock: 0 };
  }

  update(det, t) {
    if (!det) { this.last = null; return null; }
    const lm = det.lm, hs = handSize(lm), t8 = lm[8], t4 = lm[4];
    if (!TIP.checks) return this.accept(t8, t4, lm, t, "raw");
    if (!this.tip || t - this.t > TIP.staleMs) return this.accept(t8, t4, lm, t, "init");

    const dt = Math.min(0.1, (t - this.t) / 1000), dx = this.v[0] * dt, dy = this.v[1] * dt;
    const pI = [this.tip[0] + dx, this.tip[1] + dy], pT = [this.thumb[0] + dx, this.thumb[1] + dy];
    const e8 = dist(t8, pI), keep = e8 + dist(t4, pT), swap = dist(t4, pI) + dist(t8, pT);
    let idx = t8, th = t4, kind = "ok";
    if (e8 > TIP.jumpMin * hs) {
      if (swap < TIP.swapRatio * keep && dist(t4, pI) < TIP.swapMax * hs && this.swaps < TIP.maxSwaps) { idx = t4; th = t8; kind = "swap"; }
      else if (dist(t8, t4) < TIP.collapse * hs && dist(t8, pT) < e8) return this.reject(t8, pI, e8 / hs, "collapse");
    }
    const e = dist(idx, pI);
    if (e <= TIP.gate * hs) { this.rejects = 0; this.pending = null; return this.accept(idx, th, lm, t, kind); }

    this.rejects = this.pending && dist(t8, this.pending) < 0.5 * TIP.gate * hs ? this.rejects + 1 : 1;
    this.pending = t8;
    if (this.rejects >= TIP.relock) { this.rejects = 0; this.pending = null; return this.accept(t8, t4, lm, t, "relock"); }
    return this.reject(t8, pI, e / hs, "reject");
  }

  reject(raw, pred, err, kind) {
    this.stats[kind]++;
    this.last = { kind, raw, pred, err };
    return null;
  }

  accept(idx, th, lm, t, kind) {
    if (kind === "ok" || kind === "swap") {
      const dt = Math.max(1e-3, (t - this.t) / 1000), k = TIP.vKeep;
      this.v = [k * this.v[0] + (1 - k) * (idx[0] - this.tip[0]) / dt, k * this.v[1] + (1 - k) * (idx[1] - this.tip[1]) / dt];
    } else this.v = [0, 0];
    this.swaps = kind === "swap" ? this.swaps + 1 : 0;
    this.tip = idx; this.thumb = th; this.palm = palmOf(lm); this.t = t;
    this.stats[kind]++;
    this.last = { kind, raw: lm[8], used: idx };
    return idx;
  }
}
