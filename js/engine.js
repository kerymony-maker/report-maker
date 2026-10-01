/* engine.js — playback loop, video element scheduling with trim/speed, seek */
import { store, segments, totalDur } from './store.js';
import { renderFrame, resetFx } from './renderer.js';
import { initAudio, resumeAudio, wireElement, musicEl, musicGainTick, gainsByEl } from './audio.js';

export const engine = {
  playing: false, playhead: 0, t0: 0, exporting: false, onEnd: null,
  loopToken: 0, scheduled: false, rafId: 0,
  onTick: null,           // ui progress hook
};

function activeVideoEls(main, next, wantNext) {
  const want = new Set();
  if (main && main.kind === 'video') want.add(main);
  if (wantNext && next && next.kind === 'video') want.add(next);
  const sg = segments();
  for (const seg of sg.list) {
    if (seg.kind !== 'video') continue;
    const a = store.media.get(seg.clip.srcId);
    if (!a || !a.el) continue;
    const el = a.el;
    if (want.has(seg)) {
      const clip = seg.clip;
      if (el.paused) {
        const srcStart = clip.srcStart || 0;
        if (!seg._started) {
          try { el.currentTime = srcStart + (seg === main ? Math.max(0, engine.playhead - segStart(seg)) : 0) * (clip.speed || 1); } catch (e) {}
          seg._started = true;
        }
        el.playbackRate = clip.speed || 1;
        el.muted = false;
        el.volume = 1;
        el.play().catch(() => {});
      }
    } else if (!el.paused) el.pause();
  }
}
function segStart(seg) {
  const sg = segments();
  const i = sg.list.indexOf(seg);
  return i >= 0 ? sg.starts[i] : 0;
}
function scheduleNext(token) {
  if (engine.scheduled) return;
  engine.scheduled = true;
  const fire = () => { engine.scheduled = false; if (token !== engine.loopToken || !engine.playing) return; frame(performance.now()); };
  if (document.hidden) setTimeout(fire, 1000 / 30);
  else engine.rafId = requestAnimationFrame(fire);
}
function frame(now) {
  if (!engine.playing) return;
  const t = (now - engine.t0) / 1000;
  if (t >= totalDur()) { engine.playhead = totalDur(); paint(); pause(); const f = engine.onEnd; engine.onEnd = null; if (f) f(); return; }
  engine.playhead = t;
  paint();
  scheduleNext(engine.loopToken);
}
function paint() {
  const cv = engine.canvas;
  if (!cv) return;
  const ctx = cv.getContext('2d');
  renderFrame(ctx, cv.width, cv.height, engine.playhead);
  if (engine.exportCanvas) {
    const iv = engine.exportFps ? 1000 / engine.exportFps : 0;
    const now = performance.now();
    if (!iv || now - (engine._lastExpPaint || 0) >= iv - 4) {
      engine._lastExpPaint = now;
      const ec = engine.exportCanvas;
      renderFrame(ec.getContext('2d'), ec.width, ec.height, engine.playhead);
      engine.onExportFrame && engine.onExportFrame();
    }
  }
  const sg = segments();
  // video scheduling
  let i = sg.list.length - 1;
  for (let k = 0; k < sg.list.length; k++) { if (engine.playhead < sg.starts[k] + sg.list[k].dur) { i = k; break; } }
  const seg = sg.list[i];
  const p = seg && (engine.playhead - sg.starts[i]) > seg.dur - (store.project.settings.transDur || 0.5);
  const next = p && i < sg.list.length - 1 ? sg.list[i + 1] : null;
  activeVideoEls(seg, next, p);
  scheduleAudioClips();
  if (engine.exporting) musicGainTick();
  if (engine.onTick) engine.onTick(engine.playhead);
}
/* audio-lane: multiple one-shot sounds, each with its own start point */
function scheduleAudioClips() {
  const p = store.project;
  const lane = p && p.audio;
  if (!lane || !lane.length) return;
  for (const a of lane) {
    const m = store.media.get(a.srcId);
    if (!m || !m.el) continue;
    const el = m.el;
    const active = engine.playing && engine.playhead >= a.startAt && engine.playhead < a.startAt + a.dur;
    const g = gainsByEl.get(el);
    if (active) {
      if (el.paused) { try { el.currentTime = engine.playhead - a.startAt; } catch (e) {} el.play().catch(() => {}); }
      if (g) {
        const fade = 0.4;
        const mul = Math.min(1, (engine.playhead - a.startAt) / fade, (a.startAt + a.dur - engine.playhead) / fade);
        try { g.gain.value = (a.volume ?? 1) * Math.max(0, mul); } catch (e) {}
      }
    } else {
      if (!el.paused) el.pause();
      if (g && g.gain.value !== 0) { try { g.gain.value = 0; } catch (e) {} }
    }
  }
}
export function attachCanvas(cv) { engine.canvas = cv; }
export function forceEnd() { const f = engine.onEnd; engine.onEnd = null; if (f) f(); }
export function play() {
  if (engine.exporting || engine.playing) return;
  if (totalDur() <= 0) return;
  initAudio(); resumeAudio();
  unlockAll();
  if (engine.playhead >= totalDur() - 0.01) { engine.playhead = 0; restartAll(); }
  engine.playing = true;
  engine.t0 = performance.now() - engine.playhead * 1000;
  engine.loopToken++; scheduleNext(engine.loopToken);
}
export function pause() {
  engine.playing = false;
  cancelAnimationFrame(engine.rafId);
  const sg = segments();
  for (const seg of sg.list) {
    if (seg.kind !== 'video') continue;
    const a = store.media.get(seg.clip.srcId);
    if (a && a.el && !a.el.paused) a.el.pause();
  }
  const lane = store.project && store.project.audio;
  if (lane) for (const a of lane) { const m = store.media.get(a.srcId); if (m && m.el && !m.el.paused) m.el.pause(); }
  const m = musicEl(); if (m && !m.paused) m.pause();
}
export function seek(t) {
  engine.playhead = Math.max(0, Math.min(totalDur(), t));
  restartAll();
  paint();
}
export function restartAll() {
  const sg = segments();
  for (const seg of sg.list) {
    seg._started = false;
    if (seg.kind === 'video') {
      const a = store.media.get(seg.clip.srcId);
      if (a && a.el) { try { a.el.currentTime = seg.clip.srcStart || 0; } catch (e) {} }
    }
  }
}
export function resetPlayhead() { engine.playhead = 0; restartAll(); paint(); }
async function unlockAll() {
  const sg = segments();
  const els = [];
  for (const seg of sg.list) if (seg.kind === 'video') { const a = store.media.get(seg.clip.srcId); if (a && a.el) els.push(a.el); }
  const lane = store.project && store.project.audio;
  if (lane) for (const a of lane) { const m = store.media.get(a.srcId); if (m && m.el) els.push(m.el); }
  const m = musicEl(); if (m) { wireElement(m); els.push(m); }
  for (const el of els) { wireElement(el); try { el.muted = false; await el.play(); el.pause(); } catch (e) {} }
}
/* start playback-driven export; resolves when timeline finishes */
export function runTo(onEnd) {
  return new Promise(res => {
    engine.onEnd = () => { const f = onEnd; f && f(); res(); };
    engine.playing = true;
    engine.t0 = performance.now();
    engine.loopToken++; scheduleNext(engine.loopToken);
  });
}
