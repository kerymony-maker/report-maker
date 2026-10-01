/* exporter.js — canvas recorder with resolution/fps/quality presets */
import { store, segments } from './store.js';
import { renderFrame, resetFx } from './renderer.js';
import { initAudio, resumeAudio, streamDestination, setAudible, musicEl, wireElement } from './audio.js';
import { engine, runTo, restartAll, forceEnd, pause } from './engine.js';

export const QUALITIES = {
  normal: { name: 'معمولی', mul: 1 },
  high: { name: 'کیفیت بالا', mul: 1.8 },
  social: { name: 'شبکه اجتماعی', mul: 0.8 },
  small: { name: 'حجم کم', mul: 0.45 },
};
const BASE_DIMS = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080], '4:5': [1080, 1350], '4:3': [1440, 1080] };
export function baseDims() {
  const st = store.project.settings;
  if (st.aspect === 'custom' && st.customW > 0 && st.customH > 0) return [st.customW, st.customH];
  return BASE_DIMS[st.aspect] || [1080, 1920];
}
export function previewDims() {
  const [W, H] = baseDims();
  const scale = Math.min(1, 860 / Math.max(W, H));
  return [Math.round(W * scale), Math.round(H * scale)];
}
export function exportDims(resMin) {
  const [W, H] = baseDims();
  const scale = resMin / Math.min(W, H);
  return { W: Math.round(W * scale / 2) * 2, H: Math.round(H * scale / 2) * 2 };
}
export function bitrateFor(W, H, fps, quality) {
  const base = W * H * fps * 0.09;
  return Math.round(Math.min(40e6, Math.max(2.5e6, base * (QUALITIES[quality]?.mul || 1))));
}
/* ---------- target-size mode: pick res/fps/bitrate to hit a file size ---------- */
export const SIZE_LADDER = [];
for (const r of [1080, 720, 480]) for (const f of [30, 25, 24]) SIZE_LADDER.push({ resMin: r, fps: f });
export const AUDIO_KBPS = 128;
export function computeForSize(targetMB) {
  const dur = Math.max(0.5, segments().total);
  const totalBits = targetMB * 1048576 * 8;
  const videoBps = Math.max(150000, (totalBits - AUDIO_KBPS * 1000 * dur) / dur);
  let best = null;
  for (const { resMin, fps } of SIZE_LADDER) {
    const { W, H } = exportDims(resMin);
    const bpp = videoBps / (W * H * fps);
    if (bpp >= 0.07) { best = { resMin, fps, bpp, level: 'good' }; break; }
  }
  if (!best) {
    for (const { resMin, fps } of SIZE_LADDER) {
      const { W, H } = exportDims(resMin);
      const bpp = videoBps / (W * H * fps);
      if (!best || bpp > best.bpp) best = { resMin, fps, bpp };
    }
    best.level = best.bpp >= 0.04 ? 'ok' : 'low';
  }
  return { ...best, videoBps, dur, estMB: targetMB };
}
function pickMime() {
  const cands = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const c of cands) { try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (e) {} }
  return '';
}
async function preloadFonts() {
  if (!document.fonts || !document.fonts.load) return;
  try { await Promise.all([document.fonts.load('800 60px Vazirmatn'), document.fonts.load('400 60px Lalezar')]); } catch (e) {}
}

let cancelRequested = false;
export function cancelExport() { cancelRequested = true; forceEnd(); }

export async function exportVideo({ resMin = 1080, fps = 30, quality = 'normal', bitrate = 0 } = {}) {
  if (!store.project) throw new Error('no-project');
  if (segments().total <= 0) throw new Error('empty');
  if (!window.MediaRecorder) throw new Error('no-recorder');
  cancelRequested = false;
  const { W, H } = exportDims(resMin);
  const vBitrate = bitrate > 0 ? Math.round(bitrate) : bitrateFor(W, H, fps, quality);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  try { ctx.direction = 'rtl'; } catch (e) {}
  pause(); engine.exporting = true; engine.playhead = 0;
  engine.exportCanvas = cv; engine.exportFps = fps;
  resetFx(); restartAll();
  renderFrame(ctx, W, H, 0);
  let captureTrack = null;
  engine.onExportFrame = () => { if (captureTrack) { try { captureTrack.requestFrame(); } catch (e) {} } };
  initAudio(); resumeAudio();
  // unlock media elements inside this user-gesture call stack
  const sg = segments();
  for (const seg of sg.list) {
    if (seg.kind !== 'video') continue;
    const a = store.media.get(seg.clip.srcId);
    if (a && a.el) { try { a.el.muted = false; await a.el.play(); a.el.pause(); } catch (e) {} }
  }
  const lane = store.project.audio || [];
  for (const a of lane) {
    const m = store.media.get(a.srcId);
    if (m && m.el) { wireElement(m.el); try { m.el.muted = false; await m.el.play(); m.el.pause(); } catch (e) {} }
  }
  const m = musicEl();
  if (m) { try { m.muted = false; m.loop = true; await m.play(); m.pause(); m.currentTime = 0; } catch (e) {} }
  await preloadFonts();
  let stream;
  try {
    stream = cv.captureStream(0);
    const tr = stream.getVideoTracks()[0];
    if (tr && typeof tr.requestFrame === 'function') captureTrack = tr;
    else stream = cv.captureStream(fps);
  } catch (e) { stream = cv.captureStream(fps); }
  const sd = streamDestination();
  if (sd) sd.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const mime = pickMime();
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: vBitrate, audioBitsPerSecond: AUDIO_KBPS * 1000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => rec.onstop = r);
  const total = segments().total;
  setAudible(true);
  rec.start(250);
  if (m) { try { m.currentTime = 0; m.play(); } catch (e) {} }
  engine.onExportFrame();
  await runTo(() => {});
  await new Promise(r => setTimeout(r, 220));
  engine.onExportFrame();
  rec.stop(); await stopped;
  if (m) m.pause();
  engine.exporting = false; engine.exportCanvas = null; engine.onExportFrame = null; engine.exportFps = 0;
  setAudible(false);
  if (cancelRequested) { chunks.length = 0; throw new Error('cancelled'); }
  const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
  chunks.length = 0;
  const ext = (blob.type || '').includes('mp4') ? 'mp4' : 'webm';
  return { blob, ext, W, H, dur: total };
}
