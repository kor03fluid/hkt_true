import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// local copies (scripts/setup.mjs) are looked up next to the page, so the build works from any sub-path
const BASE = import.meta.env.BASE_URL;
// two CDNs, because some school / company networks block one of them
const CDN_WASM = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm',
];
const CDN_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

async function localExists(url) {
  if (location.protocol === 'file:') return false; // opened from disk (single-file build): no local copies
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const type = r.headers.get('content-type') || '';
    return r.ok && !type.includes('text/html');
  } catch {
    return false;
  }
}

export class HandTracker {
  constructor() {
    this.landmarker = null;
    this.ready = false;
    this.info = '';
  }

  /** Tries local files first, then CDN. GPU first, then CPU. Throws if everything fails. */
  async init() {
    let lastErr = null;
    const wasmBases = [];
    if (await localExists(`${BASE}wasm/vision_wasm_internal.js`)) wasmBases.push({ url: `${BASE}wasm`, tag: 'LOCAL' });
    for (const url of CDN_WASM) wasmBases.push({ url, tag: 'CDN' });

    const models = [];
    if (await localExists(`${BASE}models/hand_landmarker.task`)) models.push({ url: `${BASE}models/hand_landmarker.task`, tag: 'LOCAL' });
    models.push({ url: CDN_MODEL, tag: 'CDN' });

    for (const wb of wasmBases) {
      let fileset;
      try {
        fileset = await FilesetResolver.forVisionTasks(wb.url);
      } catch (e) {
        lastErr = e;
        continue;
      }
      for (const m of models) {
        for (const delegate of ['GPU', 'CPU']) {
          try {
            this.landmarker = await HandLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: m.url, delegate },
              runningMode: 'VIDEO',
              numHands: 2,
              // stricter than the MediaPipe defaults: fewer phantom hands and jitter
              minHandDetectionConfidence: 0.65,
              minHandPresenceConfidence: 0.6,
              minTrackingConfidence: 0.6,
            });
            this.ready = true;
            this.info = `${delegate} / ${m.tag}`;
            return;
          } catch (e) {
            lastErr = e;
          }
        }
      }
    }
    throw lastErr || new Error('HandLandmarker failed to initialise');
  }

  /** Returns an array of { landmarks, score, label } (0, 1 or 2 hands). Call once per new video frame. */
  detect(video, nowMs) {
    if (!this.ready) return [];
    let res;
    try {
      res = this.landmarker.detectForVideo(video, nowMs);
    } catch {
      return [];
    }
    if (!res || !res.landmarks || !res.landmarks.length) return [];
    return res.landmarks.map((landmarks, i) => ({
      landmarks,
      score: res.handedness?.[i]?.[0]?.score ?? 0.9,
      label: res.handedness?.[i]?.[0]?.categoryName || (i ? 'Left' : 'Right'),
    }));
  }
}
