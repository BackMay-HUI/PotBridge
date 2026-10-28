// A local, CSP-safe cache prevents the wrong theme flashing before modules load.
(() => {
  let theme = 'luna';
  try {
    const saved = localStorage.getItem('potbridge-theme');
    if (['luna', 'porcelain', 'reload', 'mica', 'forest'].includes(saved)) theme = saved;
  } catch { /* Blocked cache must never stop the extension opening. */ }
  document.documentElement.dataset.theme = theme;
})();
