/* store.js — project model, command stack (undo/redo), IndexedDB persistence */
import { uid, debounce } from './util.js';

export const store = {
  project: null,          // active project {id,name,settings,items}
  media: new Map(),       // assetId -> asset {id,kind,name,type,size,w,h,dur,thumb,blob,url,bitmap,tinyBitmap}
  undoStack: [], redoStack: [],
  version: 0,             // bumped on every mutation (renderer caches invalidate)
  selectedId: null,
  listeners: new Set(),
};

export const THEMES = {
  official: { name: '🎒 رسمی اداری', bg: ['#0f2b5b', '#1e56a0'], capBg: 'rgba(10,32,70,.85)', emoji: ['📌','📋','🏛️','✅','📁'] },
  rainbow:  { name: '🌈 رنگین‌کمان', bg: ['#ff9a9e', '#fbc2eb', '#a18cd1'], capBg: 'rgba(216,27,96,.82)', emoji: ['✨','❤️','🎈','🌟','🎉'] },
  school:   { name: '🎒 مدرسه', bg: ['#2193b0', '#6dd5ed'], capBg: 'rgba(2,119,189,.85)', emoji: ['📚','✏️','🎓','⭐','🚌'] },
  nature:   { name: '🌿 طبیعت', bg: ['#134e5e', '#71b280'], capBg: 'rgba(27,94,32,.85)', emoji: ['🌿','🦋','🌞','🍀','🐝'] },
  neon:     { name: '🌌 شب نئون', bg: ['#0f0c29', '#302b63', '#24243e'], capBg: 'rgba(98,63,214,.88)', emoji: ['⚡','🌟','🎮','🔥','💫'] },
};
export const FONTS = {
  vazirmatn: { name: 'وزیرمتن', family: 'Vazirmatn', weight: 800 },
  lalezar:   { name: 'لاله‌زار', family: 'Lalezar', weight: 400 },
  markazi:   { name: 'مرکزی', family: 'Markazi Text', weight: 700 },
  gulzar:    { name: 'نستعلیق', family: 'Gulzar', weight: 400 },
};
export const ASPECTS = {
  '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080],
  '4:5': [1080, 1350], '4:3': [1440, 1080],
};
export const MOTIONS = {
  auto: 'خودکار', none: 'بدون حرکت', zoomin: 'زوم به داخل', zoomout: 'زوم به خارج',
  panlr: 'پن چپ↔راست', panud: 'پن بالا↔پایین', cine: 'سینمایی آهسته',
};
export const FITS = { fill: 'پرکردن کادر', fit: 'نمایش کامل' };
export const BGS = {
  blur: 'بلور خود عکس', darkblur: 'بلور تیره', lightblur: 'بلور روشن',
  solid: 'رنگ یکدست', gradient: 'گرادیان تم', mirror: 'آینه‌ای',
};
export const TRANSITIONS = {
  fade: 'محو', cut: 'برش', slide: 'کشویی', zoom: 'زوم', push: 'هل دادن',
  wipe: 'پرده‌ای', bounce: 'فنری', spin: 'چرخشی', blur: 'بلور',
};
export const FILTER_PRESETS = {
  none: '', warm: 'sepia(.25) saturate(1.35) hue-rotate(-8deg) brightness(1.04)',
  cool: 'saturate(1.15) hue-rotate(14deg) brightness(1.03)',
  mono: 'grayscale(1) contrast(1.12)',
  cinematic: 'contrast(1.15) saturate(1.2) brightness(.96)',
  vivid: 'saturate(1.65) contrast(1.08)',
};

export const ORG_NAME = 'کانون فرهنگی تربیتی حضرت سلمان';

export function defaultSettings() {
  return {
    aspect: '16:9', customW: 0, customH: 0,
    transition: 'fade', transDur: 0.5,
    photoDur: 3, motion: 'auto', motionIntensity: 1,
    fitDefault: 'fill', bgDefault: 'blur', bgColor: '#10254d',
    theme: 'official', font: 'vazirmatn', fx: false, filter: 'none',
    titleText: '', schoolName: ORG_NAME, reportDate: '', outroText: 'با تشکر از همراهی شما 🙏',
    headerText: '', footerText: ORG_NAME,
    logoId: null, logoPos: 'tl', logoSize: 0.14, logoOpacity: 0.9,
    musicId: null, musicVol: 0.8, musicFade: true,
    textPos: 'bottom', capSize: 1,
  };
}
export function newProject(name = 'گزارش ' + ORG_NAME) {
  return { id: uid('p'), name, settings: defaultSettings(), items: [], audio: [], texts: [], created: Date.now(), modified: Date.now() };
}
export function newAudioClip(srcId, startAt, dur) {
  return { id: uid('a'), srcId, startAt, dur, volume: 1 };
}
export const TEXT_ANIMS = { fade: 'محو', pop: 'پرش', slide: 'ورود از کنار', type: 'تایپ شدن ⌨️' };
export function newTextClip(text, start, dur) {
  return { id: uid('t'), text, start, dur, pos: 'bottom', anim: 'fade', color: '#ffffff', size: 1 };
}
export function newClip(kind, srcId = null, extra = {}) {
  const base = { id: uid('c'), kind, srcId, caption: '', sub: '', sticker: '',
    fit: null, bg: null, motion: null, filter: null,
    scale: 1, offsetX: 0, offsetY: 0, rotation: 0, ...extra };
  if (kind === 'photo') base.dur = extra.dur ?? (store.project ? store.project.settings.photoDur : 3);
  if (kind === 'video') { base.srcStart = 0; base.srcEnd = extra.srcEnd ?? 0; base.speed = 1; base.volume = 1; base.muted = false; }
  return base;
}

/* ---------- reactive plumbing ---------- */
export function notify() { store.listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }
export function onChange(fn) { store.listeners.add(fn); return () => store.listeners.delete(fn); }
function snapshot() {
  const p = store.project;
  return JSON.stringify({ name: p.name, settings: p.settings, items: p.items, audio: p.audio || [], texts: p.texts || [] });
}
export function commit(fn, { noUndo = false, silent = false } = {}) {
  if (!store.project) return;
  if (!noUndo) {
    store.undoStack.push(snapshot());
    if (store.undoStack.length > 60) store.undoStack.shift();
    store.redoStack.length = 0;
  }
  fn(store.project);
  store.project.modified = Date.now();
  store.version++;
  scheduleSave();
  if (!silent) notify();
}
export function undo() {
  const s = store.undoStack.pop();
  if (!s || !store.project) return false;
  store.redoStack.push(snapshot());
  const o = JSON.parse(s);
  store.project.name = o.name; store.project.settings = o.settings; store.project.items = o.items;
  store.project.audio = o.audio || []; store.project.texts = o.texts || [];
  store.version++; scheduleSave(); notify();
  return true;
}
export function redo() {
  const s = store.redoStack.pop();
  if (!s || !store.project) return false;
  store.undoStack.push(snapshot());
  const o = JSON.parse(s);
  store.project.name = o.name; store.project.settings = o.settings; store.project.items = o.items;
  store.project.audio = o.audio || []; store.project.texts = o.texts || [];
  store.version++; scheduleSave(); notify();
  return true;
}
export function canUndo() { return store.undoStack.length > 0; }
export function canRedo() { return store.redoStack.length > 0; }

/* ---------- timeline segments (cached) ---------- */
let segCache = { version: -1, list: [], total: 0, starts: [] };
export function segments() {
  if (segCache.version === store.version) return segCache;
  const p = store.project, list = [];
  if (p) {
    if (p.settings.titleText.trim()) list.push({ kind: 'title', dur: 3.2 });
    for (const it of p.items) {
      if (it.kind === 'video') {
        const src = store.media.get(it.srcId);
        const len = Math.max(0.2, (it.srcEnd - it.srcStart)) / (it.speed || 1);
        list.push({ kind: 'video', clip: it, dur: Math.min(len, src ? len : len) });
      } else list.push({ kind: it.kind, clip: it, dur: it.dur });
    }
    if (p.settings.outroText.trim()) list.push({ kind: 'outro', dur: 2.8 });
  }
  const starts = []; let t = 0;
  for (const s of list) { starts.push(t); t += s.dur; }
  segCache = { version: store.version, list, starts, total: t };
  return segCache;
}
export function totalDur() { return segments().total; }

/* ---------- IndexedDB persistence ---------- */
const DB_NAME = 'report-app', DB_VER = 1;
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(storeName, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  }));
}
export async function putAssetRec(rec) { return tx('assets', 'readwrite', s => s.put(rec)); }
export async function delAssetRec(id) { return tx('assets', 'readwrite', s => s.delete(id)); }
export async function allAssets() { return tx('assets', 'readonly', s => s.getAll()); }
export async function allProjects() { return tx('projects', 'readonly', s => s.getAll()); }
export async function putProjectRec(rec) { return tx('projects', 'readwrite', s => s.put(rec)); }
export async function delProjectRec(id) { return tx('projects', 'readwrite', s => s.delete(id)); }

export const scheduleSave = debounce(async () => {
  if (!store.project) return;
  try {
    await putProjectRec({ id: store.project.id, json: JSON.stringify(store.project), updatedAt: Date.now() });
    document.dispatchEvent(new CustomEvent('app:saved'));
  } catch (e) { console.warn('save failed', e); }
}, 700);

export async function loadProjectById(id, assetRecords) {
  const rec = await new Promise((res, rej) => db().then(d => {
    const t = d.transaction('projects', 'readonly');
    const r = t.objectStore('projects').get(id);
    t.oncomplete = () => res(r.result);
    t.onerror = () => rej(t.error);
  }));
  if (!rec) return null;
  const p = JSON.parse(rec.json);
  store.project = p; store.undoStack = []; store.redoStack = []; store.selectedId = null; store.version++;
  // register asset records (runtime caches rebuilt lazily by media.js)
  return p;
}
export function assetRuntime(rec) {
  if (store.media.has(rec.id)) return store.media.get(rec.id);
  const a = { ...rec, url: null, bitmap: null, tinyBitmap: null, mirrorBitmap: null };
  store.media.set(rec.id, a);
  return a;
}
