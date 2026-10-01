/* util.js — helpers shared by all modules */
export const $ = s => document.querySelector(s);
export const $$ = s => Array.from(document.querySelectorAll(s));
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const clamp = (a, b, v) => Math.max(a, Math.min(b, v));
export const uid = p => p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function easeOutBack(x) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }
export function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

export function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' کیلوبایت';
  return (bytes / 1048576).toFixed(1) + ' مگابایت';
}
export function fmtDur(s) {
  if (!isFinite(s)) return '';
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m > 0 ? `${m}:${String(sec).padStart(2, '0')} دقیقه` : `${s.toFixed(1)} ثانیه`;
}
export function todayFa() {
  try { return new Date().toLocaleDateString('fa-IR'); } catch (e) { return ''; }
}
export function toast(msg, kind = '') {
  let host = document.querySelector('#toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 3400);
}
