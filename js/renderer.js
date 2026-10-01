/* renderer.js — deterministic frame compositor: same code renders preview & export */
import { store, segments, THEMES, FONTS, FILTER_PRESETS, MOTIONS } from './store.js';
import { ensureVideoTiny } from './media.js';
import { clamp, easeOutBack } from './util.js';

let canvasCtxRef = null;   // ctx whose canvas we size-text on (per draw call, we use passed ctx)
let fxParts = [], lastFxT = 0;

function fontStr(kind, size) {
  const f = FONTS[store.project?.settings.font] || FONTS.vazirmatn;
  const w = kind === 'cap' ? f.weight : f.weight;
  return `${w} ${size}px ${f.family}, Vazirmatn, Tahoma`;
}
function rr(x, y, w, h, r) {
  const c = canvasCtxRef; c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function wrapLines(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean); const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
function applyFilter(ctx, f) { if (f) { try { ctx.filter = f; } catch (e) {} } }
function clearFilter(ctx, f) { if (f) { try { ctx.filter = 'none'; } catch (e) {} } }

/* ---------- background fill modes (for fit/contain display) ---------- */
function drawBackdrop(ctx, W, H, asset, mode, theme) {
  const tiny = asset && (asset.tinyBitmap || ensureVideoTiny(asset));
  if (mode === 'blur' && tiny) drawCover(ctx, W, H, tiny, asset.w, asset.h, 1.12, 0, 0);
  else if (mode === 'darkblur' && tiny) {
    drawCover(ctx, W, H, tiny, asset.w, asset.h, 1.12, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.fillRect(0, 0, W, H);
  } else if (mode === 'lightblur' && tiny) {
    drawCover(ctx, W, H, tiny, asset.w, asset.h, 1.12, 0, 0);
    ctx.fillStyle = 'rgba(255,255,255,.30)'; ctx.fillRect(0, 0, W, H);
  } else if (mode === 'mirror' && (asset && (asset.mirrorBitmap || tiny))) {
    const src = asset.mirrorBitmap || asset.tinyBitmap;
    drawCover(ctx, W, H, src, asset.w, asset.h, 1.06, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(0, 0, W, H);
  } else if (mode === 'solid') {
    ctx.fillStyle = store.project.settings.bgColor; ctx.fillRect(0, 0, W, H);
  } else { // gradient (theme)
    const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
    theme.bg.forEach((c, i) => g.addColorStop(i / (theme.bg.length - 1), c));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
}
function drawCover(ctx, W, H, src, sw, sh, scale = 1, panX = 0, panY = 0, rot = 0, alpha = 1) {
  if (!src || !sw || !sh) return;
  ctx.save();
  if (alpha < 1) ctx.globalAlpha *= alpha;
  ctx.translate(W / 2 + panX, H / 2 + panY);
  if (rot) ctx.rotate(rot);
  const s = Math.max(W / sw, H / sh) * scale;
  ctx.drawImage(src, -sw * s / 2, -sh * s / 2, sw * s, sh * s);
  ctx.restore();
}
function drawContain(ctx, W, H, src, sw, sh, scale = 1, panX = 0, panY = 0, rot = 0, alpha = 1) {
  if (!src || !sw || !sh) return;
  ctx.save();
  if (alpha < 1) ctx.globalAlpha *= alpha;
  ctx.translate(W / 2 + panX, H / 2 + panY);
  if (rot) ctx.rotate(rot);
  const s = Math.min(W / sw, H / sh) * scale;
  ctx.drawImage(src, -sw * s / 2, -sh * s / 2, sw * s, sh * s);
  ctx.restore();
}

/* ---------- motion (Ken Burns presets) ---------- */
function motionTransform(seg, local, W, H) {
  const st = store.project.settings;
  const clip = seg.clip;
  const mode = clip.motion || st.motion;
  const k = st.motionIntensity || 1;
  const p = clamp(0, 1, local / Math.max(seg.dur, 0.001));
  let scale = 1.001, panX = 0, panY = 0, rot = 0;
  const A = 0.14 * k, P = 0.045 * k * W;
  let m = mode;
  if (m === 'auto') m = (segIdx(seg) % 2 === 0) ? 'zoomin' : 'zoomout';
  if (m === 'zoomin') scale = 1.03 + A * p;
  else if (m === 'zoomout') scale = 1.03 + A * (1 - p);
  else if (m === 'panlr') { scale = 1.03 + A; panX = (p - 0.5) * 2 * P; }
  else if (m === 'panud') { scale = 1.03 + A; panY = (p - 0.5) * 2 * P; }
  else if (m === 'cine') { scale = 1.02 + 0.09 * k * p; panX = (p - 0.5) * P * 0.6; panY = -(p - 0.5) * P * 0.4; }
  // manual clip transforms on top
  scale *= (clip.scale || 1);
  panX += (clip.offsetX || 0) * W;
  panY += (clip.offsetY || 0) * H;
  rot = (clip.rotation || 0) * Math.PI / 180;
  return { scale, panX, panY, rot };
}
let segIdxMap = null, segIdxVersion = -1;
function segIdx(seg) {
  const sg = segments();
  if (segIdxVersion !== sg.version) {
    segIdxMap = new Map(); sg.list.forEach((s, i) => segIdxMap.set(s, i)); segIdxVersion = sg.version;
  }
  return segIdxMap.get(seg) || 0;
}

/* ---------- text overlays ---------- */
function drawCaption(ctx, W, H, clip, local) {
  const st = store.project.settings, th = THEMES[st.theme] || THEMES.official;
  const text = clip.caption; if (!text) return;
  let fs = Math.round(W * 0.05 * (st.capSize || 1));
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const maxW = W * 0.84;
  const setF = () => ctx.font = fontStr('cap', fs); setF();
  let lines = wrapLines(ctx, text, maxW);
  while (lines.length > 3 && fs > W * 0.03) { fs -= 2; setF(); lines = wrapLines(ctx, text, maxW); }
  const lh = fs * 1.45, padX = fs * 0.75, padY = fs * 0.5;
  const wMax = Math.max(...lines.map(l => ctx.measureText(l).width));
  const bw = Math.min(maxW, wMax) + padX * 2, bh = lines.length * lh + padY * 2;
  const pos = st.textPos || 'bottom';
  const bx = (W - bw) / 2;
  const by = pos === 'top' ? H * 0.13 : pos === 'middle' ? (H - bh) / 2 + H * 0.04 : H - bh - H * 0.075;
  const pop = easeOutBack(clamp(0, 1, local / 0.35));
  ctx.save();
  ctx.translate(W / 2, by + bh / 2); ctx.scale(pop, pop); ctx.translate(-W / 2, -(by + bh / 2));
  ctx.shadowColor = 'rgba(0,0,0,.22)'; ctx.shadowBlur = 12;
  ctx.fillStyle = th.capBg; rr(bx, by, bw, bh, fs * 0.6); ctx.fill();
  ctx.shadowBlur = 0; ctx.fillStyle = '#fff';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, by + padY + lh * (i + 0.5)));
  ctx.restore();
}
function drawSub(ctx, W, H, clip, local) {
  const text = clip.sub; if (!text) return;
  const st = store.project.settings;
  let fs = Math.round(W * 0.036);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const maxW = W * 0.8;
  const setF = () => ctx.font = fontStr('cap', fs); setF();
  let lines = wrapLines(ctx, text, maxW);
  while (lines.length > 2 && fs > W * 0.024) { fs -= 2; setF(); lines = wrapLines(ctx, text, maxW); }
  const lh = fs * 1.4;
  const pos = st.textPos || 'bottom';
  const y = pos === 'top' ? H * 0.13 : pos === 'middle' ? H / 2 + H * 0.1 : H - H * 0.045;
  ctx.save();
  ctx.font = fontStr('cap', fs);
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 8;
  ctx.fillStyle = '#fff';
  lines.forEach((l, i) => {
    const yy = pos === 'top' ? y + i * lh : y - (lines.length - 1 - i) * lh;
    ctx.fillText(l, W / 2, yy);
  });
  ctx.restore();
}
function drawSticker(ctx, W, H, clip, local) {
  if (!clip.sticker) return;
  const pop = easeOutBack(clamp(0, 1, local / 0.35));
  ctx.save();
  ctx.translate(W * 0.84, H * 0.16 + Math.sin(local * 3) * 6);
  ctx.rotate(-0.15); ctx.scale(pop, pop);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(W * 0.12)}px serif`;
  ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = 10;
  ctx.fillText(clip.sticker, 0, 0);
  ctx.restore();
}
function drawTitleSlide(ctx, W, H, local, isOutro) {
  const st = store.project.settings, th = THEMES[st.theme] || THEMES.official;
  const pop = easeOutBack(clamp(0, 1, local / 0.55));
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(pop, pop);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const emoji = isOutro ? '🎬' : th.emoji[0];
  ctx.font = `${Math.round(W * 0.13)}px serif`;
  ctx.fillText(emoji, 0, -H * 0.155);
  const main = isOutro ? st.outroText : st.titleText;
  let fs = Math.round(W * (isOutro ? 0.075 : 0.082));
  const setF = () => ctx.font = fontStr('cap', fs); setF();
  let lines = wrapLines(ctx, main.trim(), W * 0.82);
  while (lines.length > 3 && fs > W * 0.05) { fs -= 2; setF(); lines = wrapLines(ctx, main.trim(), W * 0.82); }
  const lh = fs * 1.5;
  ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 16; ctx.fillStyle = '#fff';
  lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * lh));
  if (!isOutro && (st.schoolName || st.reportDate)) {
    let fs2 = Math.round(W * 0.042);
    ctx.font = fontStr('cap', fs2); ctx.shadowBlur = 10; ctx.globalAlpha = 0.95;
    const sub = [st.schoolName, st.reportDate].filter(Boolean).join('  •  ');
    ctx.fillText(sub, 0, (lines.length - 1) / 2 * lh + fs2 * 2.1);
  }
  ctx.restore();
}
function drawHeaderFooter(ctx, W, H, clip) {
  const st = store.project.settings;
  const pick = v => (v === undefined || v === null) ? null : v;
  const hOverride = clip ? pick(clip.headerText) : null;
  const fOverride = clip ? pick(clip.footerText) : null;
  const hText = hOverride !== null ? hOverride : st.headerText;
  const fText = fOverride !== null ? fOverride : st.footerText;
  const bar = (text, top) => {
    const fs = Math.round(W * 0.037), h = fs * 2.1;
    ctx.save();
    ctx.fillStyle = 'rgba(5,15,35,.55)'; ctx.fillRect(0, top ? 0 : H - h, W, h);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = fontStr('cap', fs); ctx.fillStyle = '#fff';
    ctx.fillText(text, W / 2, top ? h / 2 : H - h / 2);
    ctx.restore();
  };
  if (hText && hText.trim()) bar(hText, true);
  if (fText && fText.trim()) bar(fText, false);
}
/* متنی که در زمان مشخصی از تایم‌لاین نوشته می‌شود — با انیمیشن */
function drawTextOverlays(ctx, W, H, t) {
  const texts = store.project.texts || [];
  for (const tx of texts) {
    if (!tx || t < tx.start || t > tx.start + tx.dur) continue;
    const local = t - tx.start;
    const eIn = clamp(0, 1, local / 0.4);
    const eOut = clamp(0, 1, (tx.dur - local) / 0.35);
    let alpha = eOut, dx = 0, scale = 1, sub = null;
    if (tx.anim === 'fade') alpha = Math.min(eIn, eOut);
    else if (tx.anim === 'pop') { scale = easeOutBack(eIn); }
    else if (tx.anim === 'slide') { dx = (1 - easeOutBack(eIn)) * W * 0.28; }
    else if (tx.anim === 'type') {
      const tp = clamp(0, 1, local / Math.max(0.5, tx.dur * 0.55));
      sub = String(tx.text).slice(0, Math.ceil(tp * String(tx.text).length));
    }
    let fs = Math.round(W * 0.045 * (tx.size || 1));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(dx, 0); if (scale !== 1) { ctx.translate(W / 2, H / 2); ctx.scale(scale, scale); ctx.translate(-W / 2, -H / 2); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const maxW = W * 0.82;
    const setF = () => ctx.font = fontStr('cap', fs); setF();
    let lines = wrapLines(ctx, sub !== null ? sub : tx.text, maxW);
    while (lines.length > 3 && fs > W * 0.03) { fs -= 2; setF(); lines = wrapLines(ctx, sub !== null ? sub : tx.text, maxW); }
    const lh = fs * 1.5;
    const pos = tx.pos || 'bottom';
    const cy = pos === 'top' ? H * 0.2 : pos === 'middle' ? H / 2 : H * 0.68; /* bottom = above the caption pill zone */
    ctx.fillStyle = tx.color || '#fff';
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 10;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, cy + (i - (lines.length - 1) / 2) * lh));
    if (tx.anim === 'type' && local < tx.dur * 0.7 && Math.sin(t * 9) > 0 && lines.length) {
      const last = lines[lines.length - 1];
      const w = ctx.measureText(last).width;
      ctx.fillText('▌', W / 2 + w / 2 + fs * 0.3, cy + (lines.length - 1) / 2 * lh);
    }
    ctx.restore();
  }
}
function drawLogo(ctx, W, H) {
  const st = store.project.settings;
  const logo = st.logoId && store.media.get(st.logoId);
  if (!logo) return;
  ensureBitmap(logo);
  const src = logo.bitmap || logo.el;
  if (!src) return;
  const iw = logo.w || 1, ih = logo.h || 1;
  const target = Math.min(W, H) * (st.logoSize || 0.14);
  const s = target / Math.max(iw, ih);
  const dw = iw * s, dh = ih * s;
  const pad = W * 0.035;
  const pos = st.logoPos || 'tl';
  const x = (pos.includes('l') ? pad : W - pad - dw);
  const y = (pos.startsWith('t') ? pad : H - pad - dh);
  ctx.save(); ctx.globalAlpha = st.logoOpacity ?? 0.9;
  ctx.drawImage(src, x, y, dw, dh);
  ctx.restore();
}
function ensureBitmap(a) {
  if (a.bitmap || a.el) return;
  if (a.url && a.kind === 'photo') {
    const img = new Image(); img.src = a.url;
    img.decode().then(() => { a.bitmap = img; }).catch(() => {});
  }
}
function drawFx(ctx, W, H, t) {
  const st = store.project.settings;
  const th = THEMES[st.theme] || THEMES.official;
  const dt = clamp(0.001, 0.06, t - lastFxT); lastFxT = t;
  if (fxParts.length < 18 && Math.random() < dt * 7)
    fxParts.push({ x: Math.random() * W, y: H + 40, vy: -(H * 0.07 + Math.random() * H * 0.05),
      e: th.emoji[(Math.random() * th.emoji.length) | 0], sz: W * (0.035 + Math.random() * 0.03),
      r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 2, sw: Math.random() * 40 + 8 });
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const p of fxParts) {
    p.y += p.vy * dt; p.r += p.vr * dt;
    const x = p.x + Math.sin(t * 1.5 + p.r) * p.sw * 0.25;
    ctx.save(); ctx.globalAlpha = 0.85; ctx.translate(x, p.y); ctx.rotate(p.r);
    ctx.font = `${p.sz}px serif`; ctx.fillText(p.e, 0, 0); ctx.restore();
  }
  fxParts = fxParts.filter(p => p.y > -60);
}

/* ---------- main entry ---------- */
export function renderFrame(ctx, W, H, t, { quiet = false } = {}) {
  canvasCtxRef = ctx;
  const proj = store.project;
  const th = THEMES[proj.settings.theme] || THEMES.official;
  // base background
  const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
  th.bg.forEach((c, i) => g.addColorStop(i / (th.bg.length - 1), c));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const sg = segments();
  if (!sg.list.length) { lastFxT = t; return; }
  let i = sg.list.length - 1;
  for (let k = 0; k < sg.list.length; k++) { if (t < sg.starts[k] + sg.list[k].dur) { i = k; break; } }
  const seg = sg.list[i], local = t - sg.starts[i], dur = seg.dur;
  const st = proj.settings;
  const TD = st.transDur || 0.5;
  let next = null, p = 0;
  if (local > dur - TD && i < sg.list.length - 1) { next = sg.list[i + 1]; p = clamp(0, 1, (local - (dur - TD)) / TD); }

  drawSeg(ctx, W, H, seg, local, th, 1);

  if (next && p > 0 && st.transition !== 'cut' && st.transition !== 'none') {
    ctx.save();
    const tr = st.transition;
    if (tr === 'fade' || tr === 'blur') ctx.globalAlpha = p;
    else if (tr === 'zoom') { ctx.globalAlpha = p; const z = 1 + 0.28 * (1 - p); ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2); }
    else if (tr === 'slide') ctx.translate(-(1 - p) * W, 0);
    else if (tr === 'bounce') ctx.translate(-(1 - easeOutBack(p)) * W, 0);
    else if (tr === 'spin') { ctx.globalAlpha = p; ctx.translate(W / 2, H / 2); ctx.rotate((1 - p) * -0.35); const z = 1 + 0.4 * (1 - p); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2); }
    else if (tr === 'push') { /* both move */ }
    else if (tr === 'wipe') { ctx.beginPath(); ctx.rect(W - W * p, 0, W * p, H); ctx.clip(); }
    if (tr === 'blur') { try { ctx.filter = `blur(${((1 - p) * 12).toFixed(1)}px)`; } catch (e) {} }
    if (tr === 'push') {
      ctx.restore();
      ctx.save(); ctx.translate(p * W, 0); drawSeg(ctx, W, H, seg, local, th, 1); ctx.restore();
      ctx.save(); ctx.translate(-(1 - p) * W, 0); drawSeg(ctx, W, H, next, 0, th, 1); ctx.restore();
    } else {
      drawSeg(ctx, W, H, next, 0, th, 1);
      ctx.restore();
      if (next.clip) { /* captions of next drawn sharp */ }
    }
  }
  // global overlays (always on top, never transitioned)
  drawHeaderFooter(ctx, W, H, seg.clip || null);
  drawTextOverlays(ctx, W, H, t);
  drawLogo(ctx, W, H);
  if (st.fx) drawFx(ctx, W, H, t);
  else lastFxT = t;
}
function drawSeg(ctx, W, H, seg, local, th, alpha) {
  const st = store.project.settings;
  if (seg.kind === 'title') { drawTitleSlide(ctx, W, H, local, false); return; }
  if (seg.kind === 'outro') { drawTitleSlide(ctx, W, H, local, true); return; }
  const clip = seg.clip;
  const asset = clip.srcId ? store.media.get(clip.srcId) : null;
  if (!asset) return;
  const src = asset.bitmap || asset.el;
  if (!src) return;
  const filterKey = clip.filter || st.filter || 'none';
  const filterCss = FILTER_PRESETS[filterKey] || '';
  const mt = motionTransform(seg, local, W, H);
  const fit = clip.fit || st.fitDefault;
  const bg = clip.bg || st.bgDefault;
  applyFilter(ctx, filterCss);
  if (fit === 'fit') drawBackdrop(ctx, W, H, asset, bg, th);
  if (fit === 'fit') drawContain(ctx, W, H, src, asset.w, asset.h, mt.scale, mt.panX, mt.panY, mt.rot, alpha);
  else drawCover(ctx, W, H, src, asset.w, asset.h, mt.scale, mt.panX, mt.panY, mt.rot, alpha);
  clearFilter(ctx, filterCss);
  if (clip.caption) drawCaption(ctx, W, H, clip, local);
  if (clip.sub) drawSub(ctx, W, H, clip, local);
  if (clip.sticker) drawSticker(ctx, W, H, clip, local);
}
export function resetFx() { fxParts = []; lastFxT = 0; }
