import { themes, readTheme, saveTheme } from './theme-data.js';

const paths = {
  palette: '<circle cx="12" cy="12" r="9"/><path d="M21 12c0 3-2.8 2.1-4.2 2.1-1.8 0-2.6 1.4-1.8 2.9 1.1 2-.1 4-3 4"/><circle cx="7.5" cy="10" r=".7"/><circle cx="11" cy="6.7" r=".7"/><circle cx="16" cy="8" r=".7"/>',
  settings: '<path d="m9 3-.8 3-2.8 1-2 3.5 2 2.3-.5 3 3.2 2 2.8-1 2.2 2.2 3.8-1.1.7-3 2.7-1.4V9.3L18 8l-.6-3.1-3.8-1-2.2 2.3Z"/><circle cx="12" cy="12" r="3"/>',
  connected: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  audio: '<path d="m11 5-5 4H3v6h3l5 4V5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
  shield: '<path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.2 6.3A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.7"/>',
  link: '<path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-5-5l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-6 0"/>',
  inspect: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5M7 10h6M10 7v6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  play: '<path d="m7 4 14 8-14 8Z"/>',
  display: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  warning: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  loader: '<path d="M12 3a9 9 0 1 1-9 9"/>',
};
const icon = (name, cls = '') => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${paths[name] || paths.info}</svg>`;
const brand = `<span class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 36"><path d="M24 4A14 14 0 1 0 24 32"/><path class="play-fill" d="m13 10 13 8-13 8Z"/></svg></span><span><span class="brand-name">PotBridge</span><small class="brand-subtitle">映桥 · 为喜欢的观看方式</small></span></span>`;
const portrait = '<div class="hero-decoration" aria-hidden="true"></div><img class="luna-art" src="assets/luna-portrait.webp" alt="" width="205" height="205"><span class="theme-inscription" aria-hidden="true">SAKURAKOUJI LUNA</span>';
const params = new URLSearchParams(location.search);
let currentTheme = themes[params.get('theme')] ? params.get('theme') : readTheme();
const view = params.get('view') === 'settings' ? 'settings' : 'popup';
const scenarios = ['ready', 'empty', 'offline', 'missing', 'error', 'disabled'];
let scenario = scenarios.includes(params.get('state')) ? params.get('state') : 'ready';
let phase = 'detected', selected = '1080', timer;
const app = document.querySelector('#app');
document.documentElement.dataset.theme = currentTheme;

function header(settings = false) {
  const badge = `<span class="connection-badge ${scenario === 'offline' ? 'offline' : ''}">${icon(scenario === 'offline' ? 'warning' : 'connected')}${scenario === 'offline' ? '未连接' : '本机已连接'}</span>`;
  return `<header class="app-header">${brand}<div class="header-actions">${settings ? '<span class="setting-value">v0.3 · 设计预览</span>' : badge}<button class="icon-button" id="theme-toggle" aria-label="切换主题" aria-expanded="false" aria-controls="theme-menu">${icon('palette')}</button><button class="icon-button" id="view-toggle" aria-label="${settings ? '返回扩展弹窗预览' : '打开设置页预览'}">${icon(settings ? 'arrow' : 'settings')}</button></div></header>`;
}
function footer(settings = false) {
  return `<footer class="app-footer"><span>${icon('shield')}${settings ? '设置仅保存在这台设备上' : '本地处理 · 关闭弹窗不影响中转'}</span><span class="theme-footer-name">${themes[currentTheme].subtitle.split(' / ')[0]} / 03</span></footer>`;
}
function themeMenu() {
  return `<fieldset id="theme-menu" class="theme-menu" hidden><legend>选择界面主题</legend><div>${Object.entries(themes).map(([id, t]) => `<label><input type="radio" name="quick-theme" value="${id}" ${id === currentTheme ? 'checked' : ''}>${t.name}<small>${t.subtitle.split(' / ')[0]}</small></label>`).join('')}</div></fieldset>`;
}
function sourceRow(quality) {
  const missing = scenario === 'missing' && quality === '1080';
  return `<label class="source-row"><input type="radio" name="source" value="${quality}" ${selected === quality ? 'checked' : ''}><span class="source-content"><strong class="source-title">${quality === '1080' ? '1080P 高清' : '720P 准高清'}</strong><span class="source-subtitle">AVC <span aria-hidden="true">·</span> ${missing ? '<span class="audio-missing">尚未获得音轨</span>' : `<span class="audio-ok">${icon('audio')}AAC 音轨就绪</span>`}<span aria-hidden="true">·</span> 音视频分离</span></span><span class="source-tags"><span class="format-badge">DASH</span>${quality === '1080' ? '<span class="quality-tag">推荐画质</span>' : ''}</span>${icon('connected', 'source-selected-icon')}</label>`;
}
function feedback() {
  if (scenario === 'offline') return ['error', 'warning', '本机组件尚未连接', '打开设置，检查本机连接后重试。'];
  if (scenario === 'error') return ['error', 'warning', '媒体地址暂时无法访问', '请重新检测并发送；若仍失败，可在设置中导出诊断。'];
  if (scenario === 'disabled') return ['', 'info', '此站点尚未启用检测', '打开站点开关，刷新网页并开始播放。'];
  if (scenario === 'empty') return ['', 'info', '等待发现媒体', '先在网页开始播放，再点击重新检测。'];
  if (scenario === 'missing' && selected === '1080') return ['warning', 'warning', '尚未获得音轨', '请在网页播放后重新检测，或选择音轨完整的来源。'];
  if (phase === 'checking') return ['', 'loader', '正在检查媒体…', '演示：检查地址和音视频资源。'];
  if (phase === 'sent') return ['', 'connected', '已发送到 PotPlayer', '演示：请在播放器中确认实际画面与声音。'];
  if (phase === 'probe') return ['', 'connected', '媒体检查通过', '演示：仍需在播放器中确认实际画面与声音。'];
  if (phase === 'stopped') return ['', 'info', '中转已结束', '演示：你可以重新选择来源并发送。'];
  return ['', 'connected', '音视频已就绪', '发送前将检查媒体地址及所需资源。'];
}
function renderPopup() {
  const unavailable = ['empty', 'disabled'].includes(scenario);
  const blocked = unavailable || scenario === 'offline' || (scenario === 'missing' && selected === '1080') || phase === 'checking';
  const [tone, symbol, title, detail] = feedback();
  const sources = unavailable ? `<div class="empty-state">${icon('display')}<strong>${scenario === 'disabled' ? '为这个站点开启检测' : '还没有发现媒体'}</strong><p>${scenario === 'disabled' ? '开启上方开关，然后刷新网页。' : '先在网页播放一小段，<br>再回来重新检测。'}</p></div>` : `<div class="source-list">${sourceRow('1080')}${sourceRow('720')}</div>`;
  app.innerHTML = `<div class="app">${header()}<div class="app-scroll"><section class="hero" aria-labelledby="page-title"><div class="hero-copy"><div class="overline">${icon('display')}当前页面 / BILIBILI</div><h1 id="page-title">雨落京都，听见<br>城市的另一种节奏</h1><div class="page-meta"><span>www.bilibili.com</span><span class="divider" aria-hidden="true"></span><span>P1 · 视频</span></div></div>${portrait}</section><div class="site-control"><span class="site-label">${icon('globe')}此站点的媒体检测</span><label class="switch-label"><span>${scenario === 'disabled' ? '未启用' : '已启用'}</span><input id="site-toggle" type="checkbox" role="switch" aria-label="在此站点启用检测" ${scenario === 'disabled' ? '' : 'checked'}></label></div><section class="media-section" aria-labelledby="media-heading"><div class="section-heading"><h2 id="media-heading">选择媒体源</h2><span>${unavailable ? '0' : '2'} 个来源</span></div>${sources}</section><div class="status-line ${tone}" role="status" aria-live="polite">${icon(symbol, phase === 'checking' ? 'busy-spin' : '')}<p><span>${title}</span><small>${detail}</small></p></div></div><div class="app-actions"><button id="play" class="primary-button" ${blocked ? 'disabled' : ''}>${icon(phase === 'checking' ? 'loader' : 'play', phase === 'checking' ? 'busy-spin' : 'play')}<span class="button-label">${phase === 'checking' ? '正在检查…' : '用 PotPlayer 播放'}</span>${icon('arrow', 'button-arrow')}</button><div class="action-links"><button id="detect" class="text-button" ${phase === 'checking' ? 'disabled' : ''}>${icon('refresh')}重新检测</button><button id="refresh" class="text-button" disabled title="此项仅适用于支持重新获取地址的来源">${icon('link')}重新获取地址</button><button id="probe" class="text-button" ${blocked ? 'disabled' : ''}>${icon('inspect')}检查媒体</button>${phase === 'sent' ? `<button id="stop" class="text-button danger-action">${icon('stop')}结束中转</button>` : ''}</div></div>${footer()}${themeMenu()}</div>`;
  attachCommon();
  document.querySelectorAll('input[name=source]').forEach(input => input.addEventListener('change', () => { selected = input.value; updatePopupFeedback(); }));
  document.querySelector('#site-toggle').addEventListener('change', event => { scenario = event.target.checked ? 'ready' : 'disabled'; phase = 'detected'; renderPopup(); });
  document.querySelector('#play').addEventListener('click', () => demoCheck('sent'));
  document.querySelector('#probe').addEventListener('click', () => demoCheck('probe'));
  document.querySelector('#detect').addEventListener('click', () => { phase = 'detected'; renderPopup(); });
  document.querySelector('#stop')?.addEventListener('click', () => { clearTimeout(timer); phase = 'stopped'; renderPopup(); });
}
function updatePopupFeedback() {
  const [tone, symbol, title, detail] = feedback();
  const status = document.querySelector('.status-line'); status.className = `status-line ${tone}`;
  status.innerHTML = `${icon(symbol)}<p><span>${title}</span><small>${detail}</small></p>`;
  const disabled = ['empty', 'disabled', 'offline'].includes(scenario) || (scenario === 'missing' && selected === '1080') || phase === 'checking';
  document.querySelector('#play').disabled = disabled; document.querySelector('#probe').disabled = disabled;
}
function demoCheck(result) {
  clearTimeout(timer); phase = 'checking'; renderPopup();
  timer = setTimeout(() => { phase = result; renderPopup(); document.querySelector('#play')?.focus(); }, 800);
}
function themeCards() {
  return Object.entries(themes).map(([id, t]) => `<label class="theme-card"><input type="radio" name="settings-theme" value="${id}" ${id === currentTheme ? 'checked' : ''}><div class="thumbnail" style="--thumb-bg:${t.colors[0]};--thumb-ink:${t.colors[1]};--thumb-accent:${t.colors[2]}">${id === 'luna' ? '<img src="assets/luna-portrait.webp" alt="" width="100" height="100">' : ''}<span class="thumb-rows" aria-hidden="true"></span></div><span class="card-caption">${t.name}${icon('connected')}</span></label>`).join('');
}
function renderSettings() {
  document.body.classList.add('settings-body');
  const appearance = `<section class="settings-section" id="appearance"><div class="settings-section-title"><h2>外观与主题</h2><span>即时应用 · 自动保存</span></div><fieldset class="theme-fieldset"><legend class="sr-only">选择主题</legend><div class="settings-theme-grid">${themeCards()}</div></fieldset><p class="appearance-note">${icon('connected')}<span id="appearance-feedback" role="status">已选择「${themes[currentTheme].name}」，弹窗与设置页保持一致。</span></p></section>`;
  const connection = `<section class="settings-section" id="connection"><div class="settings-section-title"><h2>播放器连接</h2><span class="connection-state">${icon('connected')}示例状态：已连接</span></div><div class="settings-panel"><div class="setting-row"><div><div class="setting-label">${icon('display')}本机组件</div><p class="setting-help">PotBridge Host · 0.2.0 · 示例数据</p></div><button id="reconnect" class="settings-button">重新检查</button></div><div class="field-row"><label for="player-path">PotPlayer 路径</label><input id="player-path" class="field-input" type="text" value="C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe" spellcheck="false"><p class="setting-help">填写完整的 .exe 路径，不添加命令行参数。</p></div><details class="field-row settings-advanced"><summary>首次安装与扩展 ID</summary><p>正式扩展会在这里显示当前扩展 ID，以及本机组件的安装说明。</p><code class="setting-help">设计预览 · 不读取实际扩展 ID</code></details></div></section>`;
  const network = `<section class="settings-section" id="network"><div class="settings-section-title"><h2>网络与诊断</h2><span>按需调整</span></div><div class="settings-panel"><div class="field-row"><label for="proxy-mode">连接方式</label><select id="proxy-mode" class="field-input"><option value="system">跟随 Windows 系统代理（推荐）</option><option value="direct">直接连接</option><option value="manual">手动 HTTP 代理</option></select><p class="setting-help">修改网络设置前，请先结束正在进行的中转。</p></div><div id="proxy-address" class="field-row" hidden><label for="proxy-url">代理地址</label><input id="proxy-url" class="field-input" type="url" placeholder="http://127.0.0.1:7890" spellcheck="false"></div><details class="field-row settings-advanced"><summary>可选诊断工具</summary><label for="ffprobe-path">ffprobe.exe 路径</label><input id="ffprobe-path" class="field-input" type="text" placeholder="可留空" spellcheck="false"><p class="setting-help">未配置时仍可正常检测和中转。</p></details></div></section>`;
  app.innerHTML = `<div class="settings-page">${header(true)}<div class="settings-heading"><div class="overline">YOUR SPACE, YOUR WAY</div><h1>把映桥，调成你的样子。</h1><p>喜欢的主题，熟悉的播放器。<br>每一次打开，都刚刚好。</p>${portrait}</div><div class="settings-layout"><nav class="settings-nav" aria-label="设置分类"><button data-section="appearance" aria-current="true">${icon('palette')}外观与主题</button><button data-section="connection">${icon('link')}播放器连接</button><button data-section="network">${icon('globe')}网络与诊断</button><p class="nav-note">PERSONAL EDITION<br>仅为你的观看习惯</p></nav><div class="settings-content">${appearance}${connection}${network}<div class="settings-bottom"><button id="save" class="primary-button">保存设置</button><button id="export" class="settings-button">导出脱敏诊断</button><button id="stop-all" class="text-button danger-action">结束全部中转</button></div><div id="settings-feedback" class="inline-status" role="status" aria-live="polite">设计预览：操作只演示界面反馈。</div></div></div>${footer(true)}${themeMenu()}</div>`;
  attachCommon();
  document.querySelectorAll('input[name=settings-theme]').forEach(input => input.addEventListener('change', () => applyTheme(input.value)));
  document.querySelector('#proxy-mode').addEventListener('change', event => { document.querySelector('#proxy-address').hidden = event.target.value !== 'manual'; });
  const messages = { save: '演示：设置已保存。实际配置请从扩展设置页操作。', reconnect: '演示：本机组件已连接。这里没有检查真实连接。', export: '演示：正式扩展会导出脱敏诊断报告。', 'stop-all': '演示：全部中转已结束。这里没有操作真实中转。' };
  for (const [id, text] of Object.entries(messages)) document.querySelector(`#${id}`).addEventListener('click', () => { document.querySelector('#settings-feedback').textContent = text; });
  document.querySelectorAll('[data-section]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-section]').forEach(b => b.setAttribute('aria-current', String(b === button)));
    document.getElementById(button.dataset.section).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }));
}
function applyTheme(theme, notify = true) {
  if (!themes[theme]) return;
  document.documentElement.classList.add('theme-swap');
  currentTheme = theme; document.documentElement.dataset.theme = theme;
  document.title = `PotBridge · ${themes[theme].name} · 设计预览`;
  document.querySelector('.theme-footer-name').textContent = `${themes[theme].subtitle.split(' / ')[0]} / 03`;
  document.querySelectorAll('input[name=quick-theme],input[name=settings-theme]').forEach(input => { input.checked = input.value === theme; });
  const note = document.querySelector('#appearance-feedback'); if (note) note.textContent = `已选择「${themes[theme].name}」，弹窗与设置页保持一致。`;
  saveTheme(theme);
  const url = new URL(location.href); url.searchParams.set('theme', theme); history.replaceState(null, '', url);
  if (notify && parent !== window) parent.postMessage({ type: 'potbridge-design-theme', theme }, location.origin);
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('theme-swap')));
}
function attachCommon() {
  const toggle = document.querySelector('#theme-toggle'), menu = document.querySelector('#theme-menu');
  toggle.addEventListener('click', () => { menu.hidden = !menu.hidden; toggle.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('input:checked')?.focus(); });
  menu.addEventListener('change', event => applyTheme(event.target.value));
  document.querySelector('#view-toggle').addEventListener('click', () => {
    const next = view === 'popup' ? 'settings' : 'popup';
    if (parent !== window) parent.postMessage({ type: 'potbridge-design-view', view: next }, location.origin);
    else { const url = new URL(location.href); url.searchParams.set('view', next); location.href = url; }
  });
  document.title = `PotBridge · ${themes[currentTheme].name} · 设计预览`;
}
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const menu = document.querySelector('#theme-menu');
  if (menu && !menu.hidden) { menu.hidden = true; document.querySelector('#theme-toggle').setAttribute('aria-expanded', 'false'); document.querySelector('#theme-toggle').focus(); }
});
document.addEventListener('click', event => {
  const menu = document.querySelector('#theme-menu'), toggle = document.querySelector('#theme-toggle');
  if (menu && !menu.hidden && !menu.contains(event.target) && !toggle.contains(event.target)) { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
});
addEventListener('storage', event => { if (event.key === 'potbridge-design-theme' && themes[event.newValue]) applyTheme(event.newValue, false); });
if (view === 'settings') renderSettings(); else renderPopup();
