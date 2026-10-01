/* main.js — boot: restore last project or show home */
import { store, allAssets, allProjects, assetRuntime, onChange } from './store.js';
import { hydrateAsset } from './media.js';
import { initUI, showScreen, openProject, renderProjectList } from './ui.js';
import { attachCanvas } from './engine.js';

initUI();

(async () => {
  try {
    const last = localStorage.getItem('report-app:last');
    if (last) {
      const recs = await allProjects();
      if (recs.some(r => r.id === last)) {
        const rec = recs.find(r => r.id === last);
        const p = JSON.parse(rec.json);
        const assetRecs = await allAssets();
        const need = new Set();
        p.items.forEach(it => it.srcId && need.add(it.srcId));
        (p.audio || []).forEach(a => a.srcId && need.add(a.srcId));
        if (p.settings.musicId) need.add(p.settings.musicId);
        if (p.settings.logoId) need.add(p.settings.logoId);
        const assets = assetRecs.filter(r => need.has(r.id));
        await openProject(p, assets);
        return;
      }
    }
  } catch (e) { console.warn('restore failed', e); }
  showScreen('home');
  renderProjectList();
})();

/* PWA */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* test hooks */
window.__app = { store };
import('./engine.js').then(m => { window.__app.engine = m.engine; window.__app.seek = m.seek; });
import('./store.js').then(m => { window.__app.undo = m.undo; window.__app.redo = m.redo; window.__app.commit = m.commit; window.__app.segments = m.segments; });
import('./ui.js').then(m => { window.__app.demo = m.createDemoProject; window.__app.refreshFrame = m.refreshFrame; window.__app.openProjectById = m.openProjectById; window.__app.renderAll = m.renderAll; });
