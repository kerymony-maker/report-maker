/* audio.js — WebAudio graph: video sounds, background music, fades */
import { store } from './store.js';

let AC = null, streamDest = null, master = null;
const wired = new WeakMap();   // el -> gain
export const allGains = [];

export function initAudio() {
  if (AC) return true;
  try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return false; }
  master = AC.createGain();
  streamDest = AC.createMediaStreamDestination();
  master.connect(AC.destination);
  master.connect(streamDest);
  return true;
}
export function audioCtx() { return AC; }
export function streamDestination() { return streamDest; }
export function wireElement(el) {
  if (!AC || !el || wired.has(el)) return null;
  try {
    const src = AC.createMediaElementSource(el);
    const g = AC.createGain(); g.gain.value = 0;
    src.connect(g); g.connect(master);
    wired.set(el, g); allGains.push(g);
    return g;
  } catch (e) { return null; }
}
export function resumeAudio() { if (AC && AC.state === 'suspended') AC.resume().catch(() => {}); }
export function setAudible(on) {
  allGains.forEach(g => { try { g.gain.value = on ? 1 : 0; } catch (e) {} });
  musicGainTick();
}
export function musicGainTick() {
  // music element gain handled via wireElement gain; apply volume + fades here
  const el = musicEl();
  if (!el) return;
  const g = wired.get(el);
  if (!g) return;
  const st = store.project.settings;
  let v = exporting() ? (st.musicVol ?? 0.8) : 0;
  if (exporting() && st.musicFade) {
    const { totalDur, playhead } = engineRef();
    const remain = totalDur - playhead;
    v *= clamp01(remain / 1.5);           // fade out
    v *= clamp01(playhead / 0.8);         // fade in
  }
  try { g.gain.value = v; } catch (e) {}
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
let _exporting = () => false, _engineRef = () => ({ totalDur: 0 });
export function bindExportFlags(exportingFn, engineRefFn) { _exporting = exportingFn; _engineRef = engineRefFn; }
function exporting() { return _exporting(); }
function engineRef() { return _engineRef(); }
export function musicEl() {
  const id = store.project?.settings.musicId;
  const a = id && store.media.get(id);
  return a && a.el ? a.el : null;
}
export { wired as gainsByEl };
