/* ui.js — all screens, timeline cards, library, wizard, settings, export flow, shortcuts */
import { $, esc, clamp, toast, todayFa, fmtSize, fmtDur } from './util.js';
import {
  store, commit, undo, redo, canUndo, canRedo, notify, onChange,
  newProject, newClip, newAudioClip, newTextClip, TEXT_ANIMS, segments, totalDur, ORG_NAME,
  THEMES, FONTS, ASPECTS, MOTIONS, FITS, BGS, TRANSITIONS,
  allProjects, putProjectRec, delProjectRec, allAssets, loadProjectById, assetRuntime, scheduleSave,
} from './store.js';
import { importFiles, hydrateAsset, captureVideoFrame } from './media.js';
import { renderFrame } from './renderer.js';
import { engine, attachCanvas, play, pause, seek, restartAll, resetPlayhead } from './engine.js';
import { exportVideo, cancelExport, exportDims, previewDims, QUALITIES, computeForSize, bitrateFor } from './exporter.js';
import { initAudio, resumeAudio, setAudible, bindExportFlags, wireElement, musicEl } from './audio.js';

bindExportFlags(() => engine.exporting, () => ({ totalDur: totalDur(), playhead: engine.playhead }));

let expRes = 1080, expFps = 30, expQ = 'normal';
let expMode = 'quality', expSizeMB = 15;
let lastAspectKey = '';

/* ================= boot & screens ================= */
export function initUI() {
  attachCanvas($('#cv'));
  engine.onTick = t => {
    const tot = totalDur() || 0.001;
    $('#pbFill').style.width = (t / tot * 100).toFixed(1) + '%';
    $('#timeLbl').textContent = `${t.toFixed(1)} / ${tot.toFixed(1)} ثانیه`;
    const ph = $('#tlPH');
    if (ph && mtlPx > 0) { ph.style.display = 'block'; ph.style.left = (t * mtlPx) + 'px'; }
    if (engine.exporting) {
      $('#exFill').style.width = (t / tot * 100).toFixed(1) + '%';
      $('#exText').textContent = `در حال ساخت… ${Math.round(t / tot * 100)}٪`;
    }
  };
  document.addEventListener('app:saved', () => {
    const d = $('#saveDot'); if (!d) return;
    d.textContent = '✅'; d.classList.add('ok');
    setTimeout(() => { d.textContent = '💾'; d.classList.remove('ok'); }, 1200);
  });
  onChange(() => renderAll());
  wireGlobalControls();
  wireShortcuts();
  window.addEventListener('resize', debounceResize);
  renderAll();
}
const debounceResize = (() => { let t; return () => { clearTimeout(t); t = setTimeout(sizeCanvas, 200); }; })();

export function showScreen(which) {
  $('#scrHome').hidden = which !== 'home';
  $('#scrEdit').hidden = which !== 'edit';
}
export async function openProject(p, assets) {
  store.project = p;
  if (!p.audio) p.audio = [];
  if (!p.texts) p.texts = [];
  store.undoStack = []; store.redoStack = []; store.selectedId = null; store.version++;
  if (assets) for (const rec of assets) { assetRuntime(rec); await hydrateAsset(assetRuntime(rec)); }
  lastAspectKey = '';
  try { localStorage.setItem('report-app:last', p.id); } catch (e) {}
  scheduleSave();
  showScreen('edit');
  renderAll();
  resetPlayhead();
}
export function closeToHome() {
  engine.pause();
  showScreen('home');
  renderProjectList();
}
export async function startNewProject(name) {
  const p = newProject(name || ('گزارش ' + ORG_NAME));
  await openProject(p, []);
}
export async function openProjectById(id) {
  const recs = await allProjects();
  const rec = recs.find(r => r.id === id);
  if (!rec) return toast('پروژه پیدا نشد', 'err');
  const p = JSON.parse(rec.json);
  const assetRecs = await allAssets();
  const need = new Set();
  p.items.forEach(it => it.srcId && need.add(it.srcId));
  (p.audio || []).forEach(a => a.srcId && need.add(a.srcId));
  if (p.settings.musicId) need.add(p.settings.musicId);
  if (p.settings.logoId) need.add(p.settings.logoId);
  const assets = assetRecs.filter(r => need.has(r.id));
  await openProject(p, assets);
}
export async function deleteProjectById(id) {
  if (!confirm('این پروژه برای همیشه حذف شود؟')) return;
  await delProjectRec(id);
  renderProjectList();
}
export function renderProjectList() {
  const host = $('#projList'); if (!host) return;
  allProjects().then(recs => {
    recs.sort((a, b) => b.updatedAt - a.updatedAt);
    host.innerHTML = recs.length ? recs.map(r => {
      let meta = '';
      try { const p = JSON.parse(r.json); meta = `${p.items.length} کلیپ • ${new Date(r.updatedAt).toLocaleDateString('fa-IR')}`; } catch (e) {}
      return `<div class="proj-row">
        <div class="proj-info"><b>${esc(JSON.parse(r.json).name || 'بی‌نام')}</b><span class="hint">${meta}</span></div>
        <div class="row" style="gap:4px">
          <button class="btn ghost small" data-open="${r.id}">باز کردن</button>
          <button class="btn danger small" data-del="${r.id}">🗑️</button>
        </div></div>`;
    }).join('') : '<p class="hint">هنوز پروژه‌ای ذخیره نشده.</p>';
  }).catch(() => { host.innerHTML = '<p class="hint">دسترسی به حافظه ممکن نشد.</p>'; });
}

/* ================= render everything ================= */
export function renderAll() {
  const p = store.project;
  $('#projName').value = p ? p.name : '';
  $('#undoBtn').disabled = !canUndo();
  $('#redoBtn').disabled = !canRedo();
  if (!p) { showScreen('home'); renderProjectList(); return; }
  sizeCanvasIfNeeded();
  renderClips();
  renderAudioLane();
  renderMTL();
  renderLibrary();
  syncSettingControls();
  if (!engine.playing) refreshFrame();
}
function sizeCanvasIfNeeded() {
  const key = aspectKey();
  if (key === lastAspectKey) return;
  lastAspectKey = key;
  sizeCanvas();
}
export function sizeCanvas() {
  const cv = $('#cv');
  const [w, h] = previewDims();
  cv.width = w; cv.height = h;
  try { cv.getContext('2d').direction = 'rtl'; } catch (e) {}
  refreshFrame();
}
function aspectKey() {
  const st = store.project.settings;
  return st.aspect === 'custom' ? `custom:${st.customW}x${st.customH}` : st.aspect;
}
export function refreshFrame() {
  const cv = $('#cv');
  renderFrame(cv.getContext('2d'), cv.width, cv.height, engine.playhead);
  const tot = totalDur();
  $('#timeLbl').textContent = `${engine.playhead.toFixed(1)} / ${tot.toFixed(1)} ثانیه`;
  $('#pbFill').style.width = (tot ? engine.playhead / tot * 100 : 0) + '%';
}

/* ================= timeline cards ================= */
function selOptions(map, defLabel, cur) {
  return `<option value="" ${cur ? '' : 'selected'}>${defLabel || 'همان پیش‌فرض'}</option>` +
    Object.entries(map).map(([k, v]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${v}</option>`).join('');
}
export function renderClips() {
  const host = $('#clipList');
  const p = store.project;
  const sg = segments();
  const badge = c => {
    if (c.kind === 'photo') return `<span class="stepper"><button data-act="minus">−</button><b>${c.dur.toFixed(1)}s</b><button data-act="plus">+</button></span>`;
    if (c.kind === 'video') return `<span class="len">🎬 ${c.srcStart.toFixed(1)}–${c.srcEnd.toFixed(1)}s${c.speed !== 1 ? ` ×${c.speed}` : ''}${c.muted ? ' 🔇' : ''}</span>`;
    return '';
  };
  host.innerHTML = p.items.map((c, i) => {
    const a = store.media.get(c.srcId);
    const name = a ? a.name : '?';
    return `<div class="clip ${store.selectedId === c.id ? 'sel' : ''}" data-id="${c.id}" data-i="${i}">
      <img class="thumb" src="${a ? a.thumb : ''}" alt="">
      <div class="meta">
        <div class="clip-name" title="${esc(name)}">${esc(name)}</div>
        <input class="cap" data-act="cap" placeholder="متن روی این بخش…" value="${esc(c.caption)}">
        <input class="cap sub" data-act="sub" placeholder="زیرمتن (اسم افراد، مکان، تاریخ…)" value="${esc(c.sub)}">
        <div class="row" style="justify-content:flex-start;gap:4px">
          <input class="cap sub" data-act="chdr" placeholder="سرصفحهٔ این بخش (خالی = پیش‌فرض)" value="${esc(c.headerText ?? '')}" title="اگر خالی باشد سرصفحهٔ کلی استفاده می‌شود">
          <input class="cap sub" data-act="cftr" placeholder="پاصفحهٔ این بخش — مثلاً نام مدرسه (خالی = پیش‌فرض)" value="${esc(c.footerText ?? '')}" title="اگر خالی باشد پاصفحهٔ کلی استفاده می‌شود">
        </div>
        <div class="row" style="justify-content:flex-start;gap:6px">
          ${badge(c)}
          <select data-act="fit" title="نحوهٔ نمایش">${selOptions(FITS, '✓ پیش‌فرض', c.fit)}</select>
          <select data-act="bg" title="پس‌زمینهٔ فضای خالی">${selOptions(BGS, '✓ پیش‌فرض', c.bg)}</select>
          <select data-act="motion" title="حرکت">${selOptions(MOTIONS, '✓ پیش‌فرض', c.motion)}</select>
          <select data-act="sticker">${['', '⭐', '❤️', '🔥', '🎯', '🎓', '📌', '✅'].map(s => `<option value="${s}" ${c.sticker === s ? 'selected' : ''}>${s || 'بدون برچسب'}</option>`).join('')}</select>
        </div>
        ${c.kind === 'video' ? videoRow(c) : ''}
      </div>
      <div class="ops">
        <button data-act="up" title="جابه‌جایی به عقب">⬆️</button>
        <button data-act="down" title="جابه‌جایی به جلو">⬇️</button>
        <button data-act="dup" title="تکثیر">⧉</button>
        <button data-act="del" title="حذف">🗑️</button>
      </div>
    </div>`;
  }).join('') || '<p class="hint">هنوز کلیپی نیست — از «رسانه‌ها» اضافه کن یا ویزارد گزارش سریع را اجرا کن.</p>';
  $('#tlMeta').textContent = p.items.length ? `${p.items.length} کلیپ • ${fmtDur(totalDur())}` : '';
}
function videoRow(c) {
  const a = store.media.get(c.srcId);
  const max = a ? a.dur : 0;
  return `<div class="row video-tools" style="justify-content:flex-start;gap:6px;flex-wrap:wrap">
    <label class="hint">شروع <input type="number" data-act="vstart" min="0" max="${max.toFixed(1)}" step="0.1" value="${c.srcStart.toFixed(1)}"></label>
    <label class="hint">پایان <input type="number" data-act="vend" min="0.2" max="${max.toFixed(1)}" step="0.1" value="${c.srcEnd.toFixed(1)}"></label>
    <select data-act="vspeed" title="سرعت">${[0.5, 0.75, 1, 1.5, 2].map(s => `<option value="${s}" ${c.speed === s ? 'selected' : ''}>${s}×</option>`).join('')}</select>
    <label class="hint">صدا <input type="range" data-act="vvol" min="0" max="1" step="0.05" value="${c.volume ?? 1}" style="width:70px"></label>
    <label class="chk hint"><input type="checkbox" data-act="vmute" ${c.muted ? 'checked' : ''}> بی‌صدا</label>
    <button class="btn ghost small" data-act="split" style="margin:0">✂️ برش اینجا</button>
    <button class="btn ghost small" data-act="snap" style="margin:0">📸 عکس از این ویدئو</button>
  </div>`;
}

function markSelection() {
  document.querySelectorAll('#clipList .clip').forEach(el => el.classList.toggle('sel', el.dataset.id === store.selectedId));
}
function clipById(id) { return store.project.items.find(c => c.id === id); }
function wireClips() {
  const host = $('#clipList');
  host.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    const card = e.target.closest('.clip'); if (!card) return;
    const id = card.dataset.id;
    const c = clipById(id); if (!c) return;
    /* clicking selects/inputs/labels must NEVER rebuild the list (would kill open dropdowns) */
    if (e.target.closest('select,input,label') && !btn) { store.selectedId = id; markSelection(); return; }
    store.selectedId = id;
    if (btn) {
      const act = btn.dataset.act;
      const i = store.project.items.indexOf(c);
      if (act === 'up' && i > 0) commit(p => { [p.items[i - 1], p.items[i]] = [p.items[i], p.items[i - 1]]; });
      else if (act === 'down' && i < p.items.length - 1) commit(p => { [p.items[i + 1], p.items[i]] = [p.items[i], p.items[i + 1]]; });
      else if (act === 'del') commit(p => { p.items.splice(i, 1); });
      else if (act === 'dup') commit(p => { p.items.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(c)), id: c.id + '_c' + Math.random().toString(36).slice(2, 5) }); });
      else if (act === 'minus') commit(p => { c.dur = clamp(0.5, 30, +(c.dur - 0.5).toFixed(1)); });
      else if (act === 'plus') commit(p => { c.dur = clamp(0.5, 30, +(c.dur + 0.5).toFixed(1)); });
      else if (act === 'split') await splitClip(c);
      else if (act === 'snap') await snapClip(c);
      renderAll();
    } else {
      markSelection();
    }
  });
  host.addEventListener('change', e => {
    const el = e.target; const act = el.dataset.act; if (!act) return;
    const card = el.closest('.clip'); if (!card) return;
    const c = clipById(card.dataset.id); if (!c) return;
    const v = el.value;
    if (act === 'fit') commit(() => { c.fit = v || null; });
    else if (act === 'bg') commit(() => { c.bg = v || null; });
    else if (act === 'motion') commit(() => { c.motion = v || null; });
    else if (act === 'sticker') commit(() => { c.sticker = v; });
    else if (act === 'vspeed') commit(() => { c.speed = +v; });
    else if (act === 'vstart') commit(() => { c.srcStart = clamp(0, c.srcEnd - 0.3, +v); });
    else if (act === 'vend') commit(() => { c.srcEnd = clamp(c.srcStart + 0.3, 1e9, +v); });
    else if (act === 'vmute') commit(() => { c.muted = el.checked; });
    renderAll();
  });
  host.addEventListener('input', e => {
    const el = e.target; const act = el.dataset.act; if (!act) return;
    const card = el.closest('.clip'); if (!card) return;
    const c = clipById(card.dataset.id); if (!c) return;
    if (act === 'cap') commit(() => { c.caption = el.value; }, { noUndo: true, silent: true });
    else if (act === 'sub') commit(() => { c.sub = el.value; }, { noUndo: true, silent: true });
    else if (act === 'chdr') commit(() => { c.headerText = el.value === '' ? null : el.value; }, { noUndo: true, silent: true });
    else if (act === 'cftr') commit(() => { c.footerText = el.value === '' ? null : el.value; }, { noUndo: true, silent: true });
    else if (act === 'vvol') commit(() => { c.volume = +el.value; }, { noUndo: true, silent: true });
    refreshFrame();
  });
}
async function splitClip(c) {
  if (c.kind !== 'video') return toast('برش فقط برای ویدئو است', 'err');
  const a = store.media.get(c.srcId);
  const srcT = (c.srcStart + c.srcEnd) / 2; // split at middle when not playing near it
  let cut = srcT;
  // prefer playhead if inside this clip
  const sg = segments();
  const idx = sg.list.findIndex(s => s.clip === c);
  if (idx >= 0) {
    const s0 = sg.starts[idx], d = sg.list[idx].dur;
    if (engine.playhead > s0 + 0.25 && engine.playhead < s0 + d - 0.25) cut = c.srcStart + (engine.playhead - s0) * (c.speed || 1);
  }
  if (cut - c.srcStart < 0.3 || c.srcEnd - cut < 0.3) return toast('نقطهٔ برش باید داخل بازه باشد', 'err');
  commit(p => {
    const i = p.items.indexOf(c);
    const second = { ...JSON.parse(JSON.stringify(c)), id: c.id + '_s' + Math.random().toString(36).slice(2, 5), srcStart: cut, caption: '', sub: '' };
    c.srcEnd = cut;
    p.items.splice(i + 1, 0, second);
  });
  toast('ویدئو برش خورد ✂️');
}
async function snapClip(c) {
  if (c.kind !== 'video') return;
  const a = store.media.get(c.srcId);
  if (!a) return;
  toast('در حال گرفتن فریم… 📸');
  try {
    const file = await captureVideoFrame(a, (c.srcStart + c.srcEnd) / 2);
    const ids = await importFiles([file], { silent: true });
    if (ids.length) commit(p => {
      const i = p.items.indexOf(c);
      p.items.splice(i + 1, 0, newClip('photo', ids[0]));
    });
    toast('عکس به تایم‌لاین اضافه شد ✅');
  } catch (e) { toast('گرفتن فریم ممکن نشد', 'err'); }
}

/* ================= audio lane (صدای تایم‌لاینی) ================= */
function renderAudioLane() {
  const host = $('#audioLane'); if (!host) return;
  const p = store.project;
  host.innerHTML = (p.audio || []).map(a => {
    const m = store.media.get(a.srcId);
    return `<div class="clip lane" data-aid="${a.id}">
      <div class="meta">
        <div class="clip-name">🎵 ${esc(m ? m.name : '?')}</div>
        <div class="row" style="justify-content:flex-start;gap:6px">
          <label class="hint">شروع(ثانیه) <input type="number" data-lane="start" min="0" step="0.5" value="${a.startAt.toFixed(1)}"></label>
          <label class="hint">مدت <input type="number" data-lane="dur" min="0.2" step="0.5" value="${a.dur.toFixed(1)}"></label>
          <label class="hint">ولوم <input type="range" data-lane="vol" min="0" max="1" step="0.05" value="${a.volume}" style="width:70px"></label>
        </div>
      </div>
      <div class="ops"><button data-laneact="del" title="حذف">🗑️</button></div>
    </div>`;
  }).join('') || '<p class="hint">صدایی روی تایم‌لاین نیست — با دکمهٔ بالا اضافه کن.</p>';
}
function wireAudioLane() {
  const host = $('#audioLane');
  host.addEventListener('click', e => {
    const b = e.target.closest('button[data-laneact="del"]'); if (!b) return;
    if (e.target.closest('input,select')) return;
    const id = b.closest('.lane').dataset.aid;
    commit(p => { p.audio = (p.audio || []).filter(a => a.id !== id); });
    renderAll();
  });
  host.addEventListener('change', e => {
    const el = e.target; const act = el.dataset.lane; if (!act) return;
    const id = el.closest('.lane').dataset.aid;
    const row = (store.project.audio || []).find(a => a.id === id); if (!row) return;
    if (act === 'start') commit(() => { row.startAt = Math.max(0, +el.value || 0); });
    else if (act === 'dur') commit(() => { row.dur = Math.max(0.2, +el.value || 1); });
    renderAll();
  });
  host.addEventListener('input', e => {
    const el = e.target; if (el.dataset.lane !== 'vol') return;
    const id = el.closest('.lane').dataset.aid;
    const row = (store.project.audio || []).find(a => a.id === id); if (!row) return;
    commit(() => { row.volume = +el.value; }, { noUndo: true, silent: true });
  });
  $('#laneAudioIn').addEventListener('change', async e => {
    const files = Array.from(e.target.files); e.target.value = '';
    if (!files.length) return;
    toast('در حال خواندن فایل صوتی…');
    const ids = await importFiles(files, { silent: true });
    if (ids.length) commit(p => {
      if (!p.audio) p.audio = [];
      for (const id of ids) {
        const a = store.media.get(id);
        p.audio.push(newAudioClip(id, engine.playhead, Math.max(0.5, a.dur || 10)));
      }
    }, { noUndo: true });
    renderAll();
    toast('صدا روی تایم‌لاین قرار گرفت 🎵');
  });
}

/* ================= multi-track timeline (چندلایه) ================= */
let mtlPx = 0, editingTextId = null;
function renderMTL() {
  const body = $('#mtlBody'); if (!body || !store.project) return;
  const tot = totalDur();
  const width = Math.max(300, body.clientWidth - 6);
  mtlPx = tot > 0 ? Math.max(6, width / tot) : width;
  const wpx = Math.max(width, tot * mtlPx);
  $('#tlRuler').style.width = wpx + 'px';
  for (const id of ['laneTexts', 'laneVisual', 'laneAudioTl', 'laneMusic']) $('#' + id).style.width = wpx + 'px';
  // ruler ticks
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = candidates.find(s => s * mtlPx >= 46) || 600;
  let ticks = '';
  for (let t = 0; t <= tot + 0.01; t += step) ticks += `<div class="tick" style="right:${t * mtlPx}px">${Math.round(t)}</div>`;
  $('#tlRuler').innerHTML = ticks;
  // text lane
  $('#laneTexts').innerHTML = (store.project.texts || []).map(tx =>
    `<div class="blk k-text ${editingTextId === tx.id ? 'sel' : ''}" data-txid="${tx.id}" style="right:${tx.start * mtlPx}px;width:${Math.max(26, tx.dur * mtlPx - 2)}px" title="${esc(tx.text)}">📝 ${esc(tx.text)}</div>`
  ).join('') || '<span class="hint" style="position:absolute;top:6px;right:8px">—</span>';
  // visual lane (segments incl title/outro)
  const sg = segments();
  $('#laneVisual').innerHTML = sg.list.map((s, i) => {
    const label = s.kind === 'title' ? '🎬 عنوان' : s.kind === 'outro' ? '🔚 پایان' :
      (s.clip.kind === 'photo' ? '🖼️ ' : '🎞️ ') + (() => { const a = store.media.get(s.clip.srcId); return a ? a.name : '?'; })();
    const cls = s.kind === 'title' || s.kind === 'outro' ? 'k-' + s.kind : 'k-' + s.clip.kind;
    const sel = s.clip && s.clip.id === store.selectedId ? ' sel' : '';
    return `<div class="blk ${cls}${sel}" data-seg="${i}" style="right:${sg.starts[i] * mtlPx}px;width:${Math.max(22, s.dur * mtlPx - 2)}px" title="${esc(label)}">${esc(label)}</div>`;
  }).join('');
  // audio lane
  $('#laneAudioTl').innerHTML = (store.project.audio || []).map(a => {
    const m = store.media.get(a.srcId);
    return `<div class="blk k-audio" data-laneid="${a.id}" style="right:${a.startAt * mtlPx}px;width:${Math.max(22, a.dur * mtlPx - 2)}px" title="${esc(m ? m.name : '?')}">🎵 ${esc(m ? m.name : '?')}</div>`;
  }).join('') || '<span class="hint" style="position:absolute;top:6px;right:8px">—</span>';
  // music lane
  const mus = store.project.settings.musicId && store.media.get(store.project.settings.musicId);
  $('#laneMusic').innerHTML = mus
    ? `<div class="blk k-music" style="right:0;width:${wpx - 4}px">🎼 موزیک زمینه — ${esc(mus.name)}</div>`
    : '<span class="hint" style="position:absolute;top:6px;right:8px">—</span>';
  const ph = $('#tlPH');
  ph.style.display = totalDur() > 0 ? 'block' : 'none';
  ph.style.left = (engine.playhead * mtlPx) + 'px';
}
function wireMTL() {
  const ruler = $('#tlRuler');
  const seekFromEvent = e => {
    const rect = ruler.getBoundingClientRect();
    const x = rect.right - e.clientX; /* RTL: right edge = 0s */
    seek(clamp(0, totalDur(), x / mtlPx));
  };
  let down = false;
  ruler.addEventListener('pointerdown', e => { down = true; ruler.setPointerCapture(e.pointerId); seekFromEvent(e); });
  ruler.addEventListener('pointermove', e => { if (down) seekFromEvent(e); });
  ruler.addEventListener('pointerup', () => { down = false; });
  $('#laneTexts').addEventListener('click', e => {
    const b = e.target.closest('.blk'); if (!b) return;
    editingTextId = b.dataset.txid;
    const tx = (store.project.texts || []).find(x => x.id === editingTextId);
    if (!tx) return;
    $('#textEdit').hidden = false;
    $('#txTextInput').value = tx.text; $('#txStart').value = tx.start.toFixed(1);
    $('#txDur').value = tx.dur.toFixed(1); $('#txPos').value = tx.pos;
    $('#txAnim').value = tx.anim; $('#txColor').value = tx.color || '#ffffff';
    renderMTL();
  });
  $('#addTextBtn').addEventListener('click', () => {
    if (totalDur() <= 0) return toast('اول چند عکس/فیلم اضافه کن 🙂', 'err');
    let id;
    commit(p => {
      const tx = newTextClip('متن جدید', Math.min(engine.playhead, Math.max(0, totalDur() - 2)), 3);
      id = tx.id;
      if (!p.texts) p.texts = [];
      p.texts.push(tx);
    });
    editingTextId = id;
    $('#textEdit').hidden = false;
    $('#txTextInput').value = 'متن جدید';
    $('#txStart').value = Math.min(engine.playhead, Math.max(0, totalDur() - 2)).toFixed(1);
    $('#txDur').value = '3.0';
    renderAll();
    $('#txTextInput').focus();
  });
  $('#txClose').addEventListener('click', () => { $('#textEdit').hidden = true; editingTextId = null; renderMTL(); });
  $('#txDel').addEventListener('click', () => {
    if (!editingTextId) return;
    commit(p => { p.texts = (p.texts || []).filter(x => x.id !== editingTextId); });
    editingTextId = null; $('#textEdit').hidden = true; renderAll();
  });
  const bindTx = (id, act) => $(id).addEventListener('input', e => {
    const tx = (store.project.texts || []).find(x => x.id === editingTextId); if (!tx) return;
    commit(() => { act(tx, e.target); }, { noUndo: true, silent: true });
    refreshFrame(); renderMTL();
  });
  bindTx('#txTextInput', (tx, el) => { tx.text = el.value; });
  bindTx('#txStart', (tx, el) => { tx.start = Math.max(0, +el.value || 0); });
  bindTx('#txDur', (tx, el) => { tx.dur = Math.max(0.5, +el.value || 1); });
  bindTx('#txPos', (tx, el) => { tx.pos = el.value; });
  bindTx('#txAnim', (tx, el) => { tx.anim = el.value; });
  bindTx('#txColor', (tx, el) => { tx.color = el.value; });
  $('#laneVisual').addEventListener('click', e => {
    const b = e.target.closest('.blk'); if (!b) return;
    const sg = segments();
    const seg = sg.list[+b.dataset.seg];
    if (seg && seg.clip) {
      store.selectedId = seg.clip.id;
      markSelection();
      const card = document.querySelector(`.clip[data-id="${seg.clip.id}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
  window.addEventListener('resize', debounceMTL);
}
const debounceMTL = (() => { let t; return () => { clearTimeout(t); t = setTimeout(renderMTL, 250); }; })();

/* ================= media library ================= */
export function renderLibrary() {
  const host = $('#libGrid');
  const items = Array.from(store.media.values()).filter(a => a.kind === 'photo' || a.kind === 'video');
  const audios = Array.from(store.media.values()).filter(a => a.kind === 'audio');
  host.innerHTML = items.map(a => `
    <div class="lib-item" data-id="${a.id}">
      <img src="${a.thumb}" alt="">
      <div class="lib-meta">
        <div class="lib-name" title="${esc(a.name)}">${esc(a.name)}</div>
        <span class="hint">${a.kind === 'video' ? '🎬 ' : '🖼️ '}${a.w}×${a.h}${a.kind === 'video' ? ' • ' + fmtDur(a.dur) : ''}<br>${fmtSize(a.size)}</span>
      </div>
      <div class="lib-ops">
        <button data-lact="add" title="افزودن به تایم‌لاین">➕</button>
        <button data-lact="del" title="حذف از پروژه">🗑️</button>
      </div>
    </div>`).join('') || '<p class="hint">رسانه‌ای نیست.</p>';
  $('#audioLine').innerHTML = audios.length
    ? audios.map(a => `<span class="hint">🎵 ${esc(a.name)} (${fmtDur(a.dur)})</span>`).join(' ') : '';
}
function wireLibrary() {
  $('#libGrid').addEventListener('click', e => {
    const b = e.target.closest('button[data-lact]'); if (!b) return;
    const id = b.closest('.lib-item').dataset.id;
    const a = store.media.get(id); if (!a) return;
    if (b.dataset.lact === 'add') {
      commit(p => { p.items.push(newClip(a.kind, a.id, a.kind === 'video' ? { srcEnd: Math.min(a.dur, 3600) } : {})); });
      toast('به تایم‌لاین اضافه شد ➕');
    } else if (b.dataset.lact === 'del') {
      if (!confirm(`«${a.name}» از پروژه حذف شود؟`)) return;
      commit(p => { p.items = p.items.filter(c => c.srcId !== id); if (p.settings.musicId === id) p.settings.musicId = null; if (p.settings.logoId === id) p.settings.logoId = null; });
    }
    renderAll();
  });
  $('#addMediaIn').addEventListener('change', async e => {
    const files = Array.from(e.target.files); e.target.value = '';
    await addFilesToProject(files);
  });
}
export async function addFilesToProject(files, { silent = false } = {}) {
  toast('در حال خواندن فایل‌ها…');
  const ids = await importFiles(files, { silent });
  if (ids.length) {
    commit(p => {
      for (const id of ids) {
        const a = store.media.get(id);
        p.items.push(newClip(a.kind, id, a.kind === 'video' ? { srcEnd: Math.min(a.dur, 3600) } : {}));
      }
    }, { noUndo: true });
  }
  renderAll();
  return ids;
}

/* ================= global settings ================= */
function chipsHTML(map, cur, attr) {
  return Object.entries(map).map(([k, v]) => `<button data-${attr}="${k}" class="${cur === k ? 'on' : ''}">${typeof v === 'string' ? v : v.name}</button>`).join('');
}
function syncSettingControls() {
  const st = store.project.settings;
  $('#aspectChips').innerHTML = chipsHTML(ASPECTS, st.aspect, 'a') + `<button data-a="custom" class="${st.aspect === 'custom' ? 'on' : ''}">⚙️ سفارشی</button>`;
  $('#customDims').style.display = st.aspect === 'custom' ? 'flex' : 'none';
  $('#cw').value = st.customW || 1920; $('#ch').value = st.customH || 1080;
  $('#transSel').value = st.transition;
  $('#transDurR').value = st.transDur; $('#transDurLbl').textContent = st.transDur.toFixed(1) + 's';
  $('#photoDurR').value = st.photoDur; $('#photoDurLbl').textContent = st.photoDur.toFixed(1) + 's';
  $('#fitSel').value = st.fitDefault;
  $('#bgSel').value = st.bgDefault;
  $('#bgColorIn').value = st.bgColor;
  $('#motionSel').value = st.motion;
  $('#motionIntR').value = st.motionIntensity; $('#motionIntLbl').textContent = '×' + (+st.motionIntensity).toFixed(1);
  $('#filterSel').value = st.filter || 'none';
  $('#fxChk').checked = !!st.fx;
  $('#themeChips').innerHTML = chipsHTML(THEMES, st.theme, 't');
  $('#fontChips').innerHTML = chipsHTML(FONTS, st.font, 'f');
  $('#textPosSel').value = st.textPos;
  $('#capSizeR').value = st.capSize || 1;
  $('#titleIn').value = st.titleText; $('#schoolIn').value = st.schoolName;
  $('#dateIn').value = st.reportDate; $('#outroIn').value = st.outroText;
  $('#headerIn').value = st.headerText; $('#footerIn').value = st.footerText;
  const logo = st.logoId && store.media.get(st.logoId);
  $('#logoPrev').innerHTML = logo ? `<img src="${logo.thumb}" alt="">` : '<span class="hint">لوگویی انتخاب نشده</span>';
  $('#logoPosSel').value = st.logoPos;
  $('#logoSizeR').value = st.logoSize; $('#logoOpR').value = st.logoOpacity;
  const music = st.musicId && store.media.get(st.musicId);
  $('#musicName').textContent = music ? '🎵 ' + music.name : '';
  $('#musicVolR').value = st.musicVol; $('#musicFadeChk').checked = !!st.musicFade;
  $('#resChips').innerHTML = [720, 1080, 1440].map(r => `<button data-res="${r}" class="${expRes === r ? 'on' : ''}">${r}p</button>`).join('');
  $('#fpsChips').innerHTML = [24, 25, 30].map(r => `<button data-fps="${r}" class="${expFps === r ? 'on' : ''}">${r}</button>`).join('');
  $('#qChips').innerHTML = Object.entries(QUALITIES).map(([k, q]) => `<button data-q="${k}" class="${expQ === k ? 'on' : ''}">${q.name}</button>`).join('');
  $('#expModeChips').innerHTML = `<button data-em="quality" class="${expMode === 'quality' ? 'on' : ''}">🎚️ کیفیت دلخواه</button>
    <button data-em="size" class="${expMode === 'size' ? 'on' : ''}">📦 حجم مشخص</button>`;
  $('#sizeModeBox').style.display = expMode === 'size' ? 'flex' : 'none';
  $('#qualityModeBox').style.display = expMode === 'quality' ? 'block' : 'none';
  updateExportButtonLabel();
}
function updateExportButtonLabel() {
  const tot = totalDur();
  if (expMode === 'size') {
    if (tot > 0) {
      const c = computeForSize(expSizeMB);
      $('#sizeCalc').textContent = `برای ${tot.toFixed(0)} ثانیه ویدیو: ${c.resMin}p • ${c.fps} فریم • بیت‌ریت ${(c.videoBps / 1e6).toFixed(1)}Mbps`;
      $('#sizeWarn').textContent = c.level === 'good' ? '✅ کیفیت خوب قابل دستیابی است' :
        c.level === 'ok' ? '⚠️ برای این حجم، کیفیت متوسط در دسترس است' :
        '⚠️ حجم کم است؛ وضوح پایین‌تر از حد مطلوب خواهد بود — مدت را کمتر یا حجم را بیشتر کنید';
    } else { $('#sizeCalc').textContent = ''; $('#sizeWarn').textContent = ''; }
    $('#expPreset').textContent = `حجم ~${expSizeMB} مگابایت`;
  } else {
    $('#sizeCalc').textContent = ''; $('#sizeWarn').textContent = '';
    if (tot > 0) {
      const { W, H } = exportDims(expRes);
      const estMB = bitrateFor(W, H, expFps, expQ) * tot / 8 / 1048576;
      $('#manualEst').textContent = `≈ حجم تقریبی این تنظیم: ${estMB.toFixed(1)} مگابایت برای ${tot.toFixed(0)} ثانیه`;
    } else $('#manualEst').textContent = '';
    $('#expPreset').textContent = `${expRes}p • ${expFps}fps`;
  }
}
function wireGlobalControls() {
  $('#homeBtn').addEventListener('click', closeToHome);
  $('#projName').addEventListener('change', e => commit(p => { p.name = e.target.value || 'گزارش بدون نام'; }));
  $('#undoBtn').addEventListener('click', () => { undo(); });
  $('#redoBtn').addEventListener('click', () => { redo(); });
  $('#newProjBtn').addEventListener('click', () => { const n = prompt('نام پروژه:', 'گزارش ' + ORG_NAME); if (n === null) return; startNewProject(n); });
  $('#demoBtn').addEventListener('click', () => createDemoProject());
  $('#wizardBtn').addEventListener('click', () => { $('#wizardCard').hidden = !$('#wizardCard').hidden; $('#wDate').value = todayFa(); });
  $('#wCancel').addEventListener('click', () => { $('#wizardCard').hidden = true; });
  $('#wFiles').addEventListener('change', e => {
    const n = e.target.files.length;
    $('#wFilesName').textContent = n ? `${n} فایل انتخاب شد ✅` : '';
  });
  $('#wGo').addEventListener('click', () => runWizard());
  $('#projList').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.open) openProjectById(b.dataset.open);
    if (b.dataset.del) deleteProjectById(b.dataset.del);
  });
  const ed = $('#scrEdit');
  ed.addEventListener('click', e => {
    const b = e.target.closest('button[data-a],button[data-t],button[data-f],button[data-res],button[data-fps],button[data-q],button[data-em]');
    if (!b) return;
    const st = store.project.settings;
    if (b.dataset.a) commit(p => { p.settings.aspect = b.dataset.a; }, { noUndo: true });
    else if (b.dataset.t) commit(p => { p.settings.theme = b.dataset.t; }, { noUndo: true });
    else if (b.dataset.f) { commit(p => { p.settings.font = b.dataset.f; }, { noUndo: true }); const f = FONTS[b.dataset.f]; document.fonts && document.fonts.load(`${f.weight} 48px ${f.family}`).catch(() => {}); }
    else if (b.dataset.res) { expRes = +b.dataset.res; }
    else if (b.dataset.fps) { expFps = +b.dataset.fps; }
    else if (b.dataset.q) { expQ = b.dataset.q; }
    else if (b.dataset.em) { expMode = b.dataset.em; }
    syncSettingControls();
    renderAll();
  });
  $('#cwApply').addEventListener('click', () => { commit(p => { p.settings.aspect = 'custom'; p.settings.customW = clamp(240, 2160, +$('#cw').value || 1920); p.settings.customH = clamp(240, 2160, +$('#ch').value || 1080); }, { noUndo: true }); renderAll(); });
  const S = sel => $(sel);
  $('#transSel').addEventListener('change', e => { commit(p => { p.settings.transition = e.target.value; }, { noUndo: true }); renderAll(); });
  $('#transDurR').addEventListener('input', e => { commit(p => { p.settings.transDur = +e.target.value; }, { noUndo: true, silent: true }); $('#transDurLbl').textContent = (+e.target.value).toFixed(1) + 's'; refreshFrame(); });
  $('#photoDurR').addEventListener('input', e => { commit(p => { p.settings.photoDur = +e.target.value; }, { noUndo: true, silent: true }); $('#photoDurLbl').textContent = (+e.target.value).toFixed(1) + 's'; });
  $('#applyDurAll').addEventListener('click', () => { commit(p => p.items.forEach(c => { if (c.kind === 'photo') c.dur = p.settings.photoDur; })); toast('مدت به همهٔ عکس‌ها اعمال شد ✅'); });
  $('#fitSel').addEventListener('change', e => { commit(p => { p.settings.fitDefault = e.target.value; }, { noUndo: true }); renderAll(); });
  $('#bgSel').addEventListener('change', e => { commit(p => { p.settings.bgDefault = e.target.value; }, { noUndo: true }); renderAll(); });
  $('#bgColorIn').addEventListener('input', e => { commit(p => { p.settings.bgColor = e.target.value; }, { noUndo: true, silent: true }); refreshFrame(); });
  $('#applyFitAll').addEventListener('click', () => { commit(p => p.items.forEach(c => { c.fit = p.settings.fitDefault; c.bg = p.settings.bgDefault; })); toast('نمایش و پس‌زمینه به همه اعمال شد ✅'); });
  $('#motionSel').addEventListener('change', e => { commit(p => { p.settings.motion = e.target.value; }, { noUndo: true }); renderAll(); });
  $('#motionIntR').addEventListener('input', e => { commit(p => { p.settings.motionIntensity = +e.target.value; }, { noUndo: true, silent: true }); $('#motionIntLbl').textContent = '×' + (+e.target.value).toFixed(1); refreshFrame(); });
  $('#applyMotionAll').addEventListener('click', () => { commit(p => p.items.forEach(c => { c.motion = null; })); toast('حرکت خودکار روی همه اعمال شد ✅'); });
  $('#filterSel').addEventListener('change', e => { commit(p => { p.settings.filter = e.target.value; }, { noUndo: true }); renderAll(); });
  $('#fxChk').addEventListener('change', e => { commit(p => { p.settings.fx = e.target.checked; }, { noUndo: true }); renderAll(); });
  $('#textPosSel').addEventListener('change', e => { commit(p => { p.settings.textPos = e.target.value; }, { noUndo: true }); renderAll(); });
  $('#capSizeR').addEventListener('input', e => { commit(p => { p.settings.capSize = +e.target.value; }, { noUndo: true, silent: true }); refreshFrame(); });
  $('#titleIn').addEventListener('input', e => { commit(p => { p.settings.titleText = e.target.value; }, { noUndo: true, silent: true }); refreshFrame(); });
  $('#schoolIn').addEventListener('input', e => { commit(p => { p.settings.schoolName = e.target.value; }, { noUndo: true, silent: true }); refreshFrame(); });
  $('#dateIn').addEventListener('input', e => { commit(p => { p.settings.reportDate = e.target.value; }, { noUndo: true, silent: true }); refreshFrame(); });
  $('#outroIn').addEventListener('input', e => { commit(p => { p.settings.outroText = e.target.value; }, { noUndo: true, silent: true }); refreshFrame(); });
  $('#headerIn').addEventListener('input', e => { commit(p => { p.settings.headerText = e.target.value; }, { noUndo: true, silent: true }); refreshFrame(); });
  $('#footerIn').addEventListener('input', e => { commit(p => { p.settings.footerText = e.target.value; }, { noUndo: true, silent: true }); refreshFrame(); });
  $('#logoIn').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const ids = await importFiles([f], { silent: true });
    if (ids.length) commit(p => { p.settings.logoId = ids[0]; }, { noUndo: true });
    renderAll();
  });
  $('#logoRm').addEventListener('click', () => { commit(p => { p.settings.logoId = null; }, { noUndo: true }); renderAll(); });
  $('#logoPosSel').addEventListener('change', e => { commit(p => { p.settings.logoPos = e.target.value; }, { noUndo: true }); renderAll(); });
  $('#logoSizeR').addEventListener('input', e => { commit(p => { p.settings.logoSize = +e.target.value; }, { noUndo: true, silent: true }); refreshFrame(); });
  $('#logoOpR').addEventListener('input', e => { commit(p => { p.settings.logoOpacity = +e.target.value; }, { noUndo: true, silent: true }); refreshFrame(); });
  $('#musicIn').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const ids = await importFiles([f], { silent: true });
    if (ids.length) {
      const a = store.media.get(ids[0]);
      initAudio(); wireElement(a.el);
      commit(p => { p.settings.musicId = ids[0]; }, { noUndo: true });
    }
    renderAll();
  });
  $('#musicVolR').addEventListener('input', e => { commit(p => { p.settings.musicVol = +e.target.value; }, { noUndo: true, silent: true }); });
  $('#musicFadeChk').addEventListener('change', e => { commit(p => { p.settings.musicFade = e.target.checked; }, { noUndo: true }); });
  $('#expSizeMB').addEventListener('input', e => { expSizeMB = clamp(0.5, 4096, +e.target.value || 15); updateExportButtonLabel(); });
  $('#playBtn').addEventListener('click', () => { engine.playing ? pause() : play(); updatePlayBtn(); });
  $('#exportBtn').addEventListener('click', () => doExport());
  $('#cancelBtn').addEventListener('click', () => { cancelExport(); });
  $('#shareBtn').addEventListener('click', shareClip);
  $('#againBtn').addEventListener('click', () => { $('#result').hidden = true; });
  wireClips();
  wireLibrary();
  wireAudioLane();
  wireMTL();
}
function updatePlayBtn() { $('#playBtn').textContent = engine.playing ? '⏸ توقف' : '▶️ پخش'; }
setInterval(updatePlayBtn, 500);

/* ================= wizard (ساخت گزارش سریع) ================= */
async function runWizard() {
  const title = $('#wTitle').value.trim();
  const school = $('#wSchool').value.trim();
  const date = $('#wDate').value.trim() || todayFa();
  const targetMin = clamp(0.5, 30, +$('#wTarget').value || 2);
  const aspect = $('#wAspect').value;
  const files = Array.from($('#wFiles').files);
  if (!files.length) return toast('چند عکس یا فیلم انتخاب کن', 'err');
  const p = newProject(title || ('گزارش ' + (school || ORG_NAME)));
  const st = p.settings;
  st.aspect = aspect;
  st.titleText = title || 'گزارش تصویری';
  st.schoolName = school || ORG_NAME;
  st.reportDate = date;
  st.footerText = school ? school + (date ? '  •  ' + date : '') : ORG_NAME + (date ? '  •  ' + date : '');
  st.outroText = 'با تشکر از همراهی شما 🙏';
  toast('در حال ساخت تایم‌لاین…');
  const ids = await importFiles(files, { silent: true });
  const photos = ids.filter(id => store.media.get(id).kind === 'photo');
  const videos = ids.filter(id => store.media.get(id).kind === 'video');
  const n = photos.length || 1;
  st.photoDur = clamp(1.5, 8, Math.round(((targetMin * 60 - videos.reduce((s, v) => s + Math.min(store.media.get(v).dur, 20), 0) - 6) / n) * 10) / 10);
  for (const id of photos) p.items.push(newClip('photo', id, { dur: st.photoDur }));
  for (const id of videos) {
    const a = store.media.get(id);
    p.items.push(newClip('video', id, { srcEnd: Math.min(a.dur, 20) }));
  }
  // optional logo & music
  const logoF = $('#wLogo').files[0];
  if (logoF) {
    const lid = (await importFiles([logoF], { silent: true }))[0];
    if (lid) st.logoId = lid;
  }
  const musicF = $('#wMusic').files[0];
  if (musicF) {
    const mid = (await importFiles([musicF], { silent: true }))[0];
    if (mid) { st.musicId = mid; initAudio(); wireElement(store.media.get(mid).el); }
  }
  store.undoStack = []; store.redoStack = [];
  await openProject(p, []);
  $('#wizardCard').hidden = true;
  toast('تایم‌لاین اولیه آماده شد — می‌تونی هر بخش رو ویرایش کنی ✅');
}
/* demo project (automation & first-run try) */
export async function createDemoProject() {
  const defs = [['🚀', '#ff9966', '#ff5e62', 'ورودی مدرسه'], ['📚', '#42e695', '#3bb2b8', 'کلاس درس'],
    ['⚽', '#f83600', '#f9d423', 'زنگ تفریح'], ['🎨', '#fc00ff', '#00dbde', 'کارگاه هنری'], ['🏅', '#00c6ff', '#0072ff', 'مراسم اختتامیه']];
  const jobs = defs.map((d, i) => new Promise(res => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 960;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1280, 960);
    g.addColorStop(0, d[1]); g.addColorStop(1, d[2]);
    x.fillStyle = g; x.fillRect(0, 0, 1280, 960);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = 'rgba(255,255,255,.92)'; x.font = '280px serif'; x.fillText(d[0], 640, 420);
    x.font = '900 84px Vazirmatn, Tahoma'; x.fillText(d[3], 640, 760);
    c.toBlob(b => res(new File([b], 'نمونه' + (i + 1) + '.jpg', { type: 'image/jpeg' })), 'image/jpeg', 0.9);
  }));
  const files = await Promise.all(jobs);
  const p = newProject('گزارش نمونه — بازدید از مدرسه');
  p.settings.titleText = 'گزارش تصویری بازدید از مدرسه';
  p.settings.schoolName = ORG_NAME;
  p.settings.reportDate = todayFa();
  p.settings.footerText = ORG_NAME + '  •  ' + todayFa();
  p.settings.photoDur = 2.5;
  const ids = await importFiles(files, { silent: true });
  for (const id of ids) p.items.push(newClip('photo', id, { dur: p.settings.photoDur }));
  store.undoStack = []; store.redoStack = [];
  await openProject(p, []);
  toast('پروژهٔ نمونه ساخته شد ✨');
}

/* ================= export flow ================= */
async function doExport() {
  if (engine.exporting) return;
  let opts;
  if (expMode === 'size') {
    const c = computeForSize(expSizeMB);
    opts = { resMin: c.resMin, fps: c.fps, bitrate: c.videoBps };
    toast(`تنظیم خودکار: ${c.resMin}p • ${c.fps}fps • ${(c.videoBps / 1e6).toFixed(1)}Mbps ⚙️`);
  } else {
    opts = { resMin: expRes, fps: expFps, quality: expQ };
  }
  const btn = $('#exportBtn');
  btn.hidden = true; $('#cancelBtn').hidden = false; $('#exBox').hidden = false; $('#result').hidden = true;
  try {
    const { blob, ext, W, H } = await exportVideo(opts);
    state_last = { blob, ext };
    const url = URL.createObjectURL(blob);
    const v = $('#resVid');
    if (v.src) URL.revokeObjectURL(v.src);
    v.src = url;
    $('#resSize').textContent = `${W}×${H} • ${fmtSize(blob.size)}`;
    const dl = $('#dlBtn');
    dl.href = url;
    dl.download = (store.project.name || 'report').replace(/[\\/:*?"<>|]/g, '-') + '.' + ext;
    $('#result').hidden = false;
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('ویدیو آماده شد 🎉');
  } catch (e) {
    if (e.message === 'cancelled') toast('ضبط لغو شد', 'err');
    else if (e.message === 'empty') toast('اول چند عکس/فیلم اضافه کن 🙂', 'err');
    else { console.error(e); toast('ساخت ویدیو ممکن نشد: ' + e.message, 'err'); }
  } finally {
    btn.hidden = false; $('#cancelBtn').hidden = true; $('#exBox').hidden = true;
  }
}
let state_last = null;
async function shareClip() {
  const b = state_last; if (!b) return;
  const f = new File([b.blob], (store.project.name || 'report') + '.' + b.ext, { type: b.blob.type || 'video/webm' });
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f], title: store.project.name }); } catch (e) {}
  } else toast('اشتراک‌گذاری مستقیم اینجا نیست؛ اول دانلود کن 📤', 'err');
}

/* ================= keyboard shortcuts ================= */
function wireShortcuts() {
  document.addEventListener('keydown', e => {
    if (!store.project || $('#scrEdit').hidden) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { e.preventDefault(); engine.playing ? pause() : play(); updatePlayBtn(); }
    else if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (store.selectedId) { const i = store.project.items.findIndex(c => c.id === store.selectedId); if (i >= 0) { commit(p => p.items.splice(i, 1)); renderAll(); } }
    } else if (e.key.toLowerCase() === 'd' && !ctrl) {
      if (store.selectedId) { const i = store.project.items.findIndex(c => c.id === store.selectedId); if (i >= 0) { commit(p => p.items.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(p.items[i])), id: p.items[i].id + '_c' + Math.random().toString(36).slice(2, 5) })); renderAll(); } }
    } else if (e.key.toLowerCase() === 's' && !ctrl) {
      const c = store.project.items.find(x => x.id === store.selectedId);
      if (c && c.kind === 'video') splitClip(c);
    } else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(engine.playhead - 0.5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(engine.playhead + 0.5); }
    else if (e.key === 'Home') { seek(0); }
    else if (e.key === 'End') { seek(totalDur()); }
  });
}
