/* ---------------------------------------------------------------
 * Hand landmarks with MediaPipe HandLandmarker (Tasks API), camera setup, and One Euro smoothing.
 *
 *   const hands = new MediaPipeHands(); await hands.init();
 *   const found = await hands.detect(video, now);   // [{ lm, score, label }]
 *
 * lm: 21 points { x, y, z } in normalised coordinates of the raw (unmirrored) camera image,
 * numbered as in MediaPipe: 0 wrist, 1–4 thumb, 5–8 index, 9–12 middle, 13–16 ring, 17–20 pinky.
 * ------------------------------------------------------------- */
import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
// The only official hand landmarker model (float16, v1)
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let modelPromise = null, cameraPromise = null;

// VIDEO mode: the previous frame's landmarks set the next frame's crop (tracking); the palm detector only runs
// when fewer than numHands hands are being tracked. GPU delegate first, CPU as a fallback.
export function loadModel() {
  return modelPromise ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const opts = delegate => ({ baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: "VIDEO", numHands: 2,
      minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.5 });
    try { return await HandLandmarker.createFromOptions(fileset, opts("GPU")); }
    catch { return await HandLandmarker.createFromOptions(fileset, opts("CPU")); }
  })().catch(e => { modelPromise = null; throw e; });
}

export function startCamera(video) {
  return cameraPromise ??= (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: "user" } });
    video.srcObject = stream;
    await video.play();
  })().catch(e => { cameraPromise = null; throw e; });
}

export class MediaPipeHands {
  constructor() { this.timing = {}; }
  async init() { this.model = await loadModel(); }
  async detect(src, now) {
    const t0 = performance.now(), r = this.model.detectForVideo(src, now);
    this.timing = { total: performance.now() - t0 };
    return (r.landmarks ?? []).map((lm, i) => ({
      lm, score: r.handedness?.[i]?.[0]?.score ?? 0, label: r.handedness?.[i]?.[0]?.categoryName,
    }));
  }
}

/* ---------------------------------------------------------------
 * One Euro filter: smooth when slow, responsive when fast (Casiez et al. 2012)
 * ------------------------------------------------------------- */
export class OneEuro {
  constructor(minCutoff = 0.9, beta = 0.004, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff }); this.x = null; }
  static a(cut, dt) { const r = 2 * Math.PI * cut * dt; return r / (r + 1); }
  filter(v, dt) {
    if (this.x === null) { this.x = v; this.dx = 0; return v; }
    const dx = (v - this.x) / dt;
    this.dx += OneEuro.a(this.dCutoff, dt) * (dx - this.dx);
    const cut = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.a(cut, dt) * (v - this.x);
    return this.x;
  }
  reset() { this.x = null; }
}

// A 2D point through One Euro. A missing measurement holds the last point for holdMs, then resets.
export class PointEuro {
  constructor(holdMs = 200) { this.holdMs = holdMs; this.fx = new OneEuro(); this.fy = new OneEuro(); this.reset(); }
  reset() { this.fx.reset(); this.fy.reset(); this.p = null; this.t = this.lastMeas = 0; }
  get active() { return this.p !== null; }
  step(z, t) {
    if (!z) { if (this.p && t - this.lastMeas > this.holdMs) this.reset(); return; }
    const dt = Math.max(1e-3, (t - this.t) / 1000);
    this.t = this.lastMeas = t;
    this.p = [this.fx.filter(z[0], dt), this.fy.filter(z[1], dt)];
  }
  at() { return this.p; }
}
