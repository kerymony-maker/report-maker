/* media.js — import, probing, bitmap caches, blur/mirror backgrounds, frame capture */
import { uid, toast } from './util.js';
import { store, assetRuntime, putAssetRec } from './store.js';

const BITMAP_MAX = 1600;   // long edge of cached photo bitmap
const TINY_W = 28;         // width of ultra-small bitmap used as cheap blur

function loadImageEl(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('image-decode'));
    img.src = url;
  });
}
function probeVideo(url) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.playsInline = true; v.muted = true;
    const done = () => res({ w: v.videoWidth, h: v.videoHeight, dur: (isFinite(v.duration) && v.duration > 0) ? v.duration : 5, el: v });
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.1, (v.duration || 1) / 3); v.onseeked = done; setTimeout(done, 2500); };
    v.onerror = () => rej(new Error('video-decode'));
    setTimeout(() => rej(new Error('video-timeout')), 8000);
    v.src = url;
  });
}
function makeThumb(src, sw, sh) {
  const c = document.createElement('canvas'); c.width = 160; c.height = 160;
  const x = c.getContext('2d');
  const s = Math.max(160 / (sw || 1), 160 / (sh || 1));
  try { x.drawImage(src, (160 - sw * s) / 2, (160 - sh * s) / 2, sw * s, sh * s); return c.toDataURL('image/jpeg', 0.72); } catch (e) { return ''; }
}
async function photoBitmap(img) {
  const long = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(1, BITMAP_MAX / long);
  if (scale >= 1 && 'createImageBitmap' in window) { try { return await createImageBitmap(img); } catch (e) {} }
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  if ('createImageBitmap' in window) { try { return await createImageBitmap(c); } catch (e) {} }
  return c;
}
function tinyOf(bitmapOrEl, w, h) { // ultra-small copy → drawn big = natural blur
  const c = document.createElement('canvas'); c.width = TINY_W; c.height = Math.max(2, Math.round(TINY_W * h / w));
  c.getContext('2d').drawImage(bitmapOrEl, 0, 0, c.width, c.height);
  return c;
}
export function ensureVideoTiny(a) { // lazily build blur backdrop source for a video asset
  if (a.tinyBitmap || a.kind !== 'video' || !a.el) return a.tinyBitmap || null;
  if (a.el.readyState >= 2 && a.el.videoWidth) {
    try { a.tinyBitmap = tinyOf(a.el, a.w, a.h); } catch (e) {}
  }
  return a.tinyBitmap || null;
}
function mirrorOf(bitmapOrEl, w, h) {
  const long = Math.max(w, h), scale = Math.min(1, 900 / long);
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w * scale)); c.height = Math.max(2, Math.round(h * scale));
  const x = c.getContext('2d');
  x.translate(c.width, 0); x.scale(-1, 1);
  x.drawImage(bitmapOrEl, 0, 0, c.width, c.height);
  return c;
}

/** import a list of File objects; returns array of asset ids */
export async function importFiles(files, { silent = false } = {}) {
  const ids = [];
  for (const f of files) {
    try {
      const id = await importOne(f);
      if (id) ids.push(id);
    } catch (e) {
      if (!silent) toast(`«${f.name}» خوانده نشد — فرمت یا کدک پشتیبانی نمی‌شود ❌`, 'err');
      console.warn('import failed', f.name, e);
    }
  }
  return ids;
}
async function importOne(f) {
  const url = URL.createObjectURL(f);
  if (f.type.startsWith('image/')) {
    const img = await loadImageEl(url);
    const a = assetRuntime({
      id: uid('m'), kind: 'photo', name: f.name, type: f.type, size: f.size,
      w: img.naturalWidth, h: img.naturalHeight, dur: 0, thumb: makeThumb(img, img.naturalWidth, img.naturalHeight),
      blob: f,
    });
    a.url = url;
    a.bitmap = await photoBitmap(img);
    a.tinyBitmap = tinyOf(a.bitmap, a.w, a.h);
    a.mirrorBitmap = mirrorOf(a.bitmap, a.w, a.h);
    putAssetRec({ id: a.id, kind: a.kind, name: a.name, type: a.type, size: a.size, w: a.w, h: a.h, dur: 0, thumb: a.thumb, blob: f });
    return a.id;
  }
  if (f.type.startsWith('video/')) {
    const { w, h, dur, el } = await probeVideo(url);
    el.muted = false; el.playsInline = true; el.preload = 'auto';
    const a = assetRuntime({
      id: uid('m'), kind: 'video', name: f.name, type: f.type, size: f.size,
      w, h, dur, thumb: makeThumb(el, w, h), blob: f,
    });
    a.url = url; a.el = el;
    try { a.tinyBitmap = tinyOf(el, w, h); } catch (e) {} /* el already seeked by probe → frame available */
    a.el.addEventListener('loadeddata', () => {
      if (!a.tinyBitmap) { try { a.tinyBitmap = tinyOf(a.el, w, h); } catch (e) {} }
    });
    putAssetRec({ id: a.id, kind: a.kind, name: a.name, type: a.type, size: a.size, w, h, dur, thumb: a.thumb, blob: f });
    return a.id;
  }
  if (f.type.startsWith('audio/')) {
    const el = new Audio(url); el.preload = 'metadata';
    const dur = await new Promise(res => {
      el.onloadedmetadata = () => res(isFinite(el.duration) ? el.duration : 0);
      el.onerror = () => res(0);
      setTimeout(() => res(0), 5000);
    });
    const rec = { id: uid('m'), kind: 'audio', name: f.name, type: f.type, size: f.size, w: 0, h: 0, dur, thumb: '', blob: f };
    const a = assetRuntime(rec);
    a.url = url; a.el = el;
    putAssetRec(rec);
    return a.id;
  }
  URL.revokeObjectURL(url);
  throw new Error('unsupported-type');
}

/** rebuild runtime handles for an asset loaded from IndexedDB */
export async function hydrateAsset(a) {
  if (a.url) return a;
  const url = URL.createObjectURL(a.blob);
  a.url = url;
  try {
    if (a.kind === 'photo') {
      const img = await loadImageEl(url);
      a.bitmap = await photoBitmap(img);
      a.tinyBitmap = tinyOf(a.bitmap, a.w, a.h);
      a.mirrorBitmap = mirrorOf(a.bitmap, a.w, a.h);
    } else if (a.kind === 'video') {
      const v = document.createElement('video');
      v.src = url; v.playsInline = true; v.preload = 'auto';
      v.addEventListener('loadeddata', () => { try { if (!a.tinyBitmap) a.tinyBitmap = tinyOf(v, a.w, a.h); } catch (e) {} });
      a.el = v;
    } else if (a.kind === 'audio') {
      const el = new Audio(url); /* lane one-shots must not loop; exporter sets loop for background music */
      a.el = el;
    }
  } catch (e) { console.warn('hydrate failed', a.name, e); }
  return a;
}

/** capture a still from a video asset at time t → returns {file,w,h} */
export async function captureVideoFrame(asset, t) {
  const v = document.createElement('video');
  v.src = asset.url; v.muted = true; v.playsInline = true; v.preload = 'auto';
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = rej; setTimeout(rej, 6000); });
  await new Promise((res, rej) => { v.currentTime = t; v.onseeked = res; setTimeout(rej, 4000); });
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  return new File([blob], (asset.name || 'frame') + '-فریم.jpg', { type: 'image/jpeg' });
}
export function releaseAsset(a) {
  try { if (a.url) URL.revokeObjectURL(a.url); } catch (e) {}
  if (a.kind === 'video' && a.el) a.el.src = '';
  if (a.kind === 'audio' && a.el) a.el.pause();
  store.media.delete(a.id);
}
