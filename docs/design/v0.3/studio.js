import { themes, readTheme, saveTheme } from './theme-data.js';

const themeList = document.querySelector('#themes');
let selected = readTheme(), view = 'popup', state = 'ready';
for (const [id, theme] of Object.entries(themes)) {
  const label = document.createElement('label');
  label.className = 'theme-option';
  label.innerHTML = `<input type="radio" name="theme" value="${id}"><span class="theme-mini mini-${id}" aria-hidden="true" style="--mini-bg:${theme.colors[0]};--mini-ink:${theme.colors[1]};--mini-accent:${theme.colors[2]}">${id === 'luna' ? '<img src="assets/luna-portrait.webp" alt="">' : ''}</span><span><span class="theme-option-title">${theme.name}</span><span class="theme-option-subtitle">${theme.subtitle}</span></span><span class="selected-tick" aria-hidden="true">✓</span>`;
  label.querySelector('input').checked = id === selected;
  themeList.append(label);
}
function render(reload = true) {
  const theme = themes[selected];
  const query = new URLSearchParams({ theme: selected, view, state });
  const frame = document.querySelector('#preview');
  if (reload) frame.src = `screen.html?${query}`;
  frame.title = `${theme.name}主题的${view === 'popup' ? '扩展弹窗' : '设置页'}预览`;
  document.querySelector('#standalone').href = `screen.html?${query}`;
  document.querySelector('#theme-index').textContent = `THEME 0${Object.keys(themes).indexOf(selected) + 1} / 05`;
  updateSizeLabel();
  document.querySelector('#theme-name').textContent = theme.name;
  document.querySelector('#theme-description').textContent = theme.description;
  document.querySelector('#theme-swatches').innerHTML = theme.colors.map(c => `<span style="--swatch:${c}"></span>`).join('');
  document.querySelector('.preview-stage').classList.toggle('settings-preview', view === 'settings');
  document.querySelector('.studio-main').dataset.activeTheme = selected;
  document.querySelector('#popup-view').setAttribute('aria-pressed', String(view === 'popup'));
  document.querySelector('#settings-view').setAttribute('aria-pressed', String(view === 'settings'));
}
function updateSizeLabel() {
  const width = Math.round(document.querySelector('#preview').getBoundingClientRect().width);
  document.querySelector('#size-label').textContent = view === 'settings' ? '响应式设置页面' : `${width} × 600 · ${width === 560 ? '实际尺寸' : '窄屏预览'}`;
}
themeList.addEventListener('change', event => {
  selected = event.target.value; saveTheme(selected); render();
});
document.querySelector('#sample-state').addEventListener('change', event => { state = event.target.value; render(); });
for (const mode of ['popup', 'settings']) {
  document.querySelector(`#${mode}-view`).addEventListener('click', () => { view = mode; render(); });
}
addEventListener('message', event => {
  if (event.source !== document.querySelector('#preview').contentWindow || event.origin !== location.origin) return;
  if (event.data?.type === 'potbridge-design-theme' && themes[event.data.theme]) {
    selected = event.data.theme;
    document.querySelector(`input[value="${selected}"]`).checked = true;
    saveTheme(selected); render(false);
  }
  if (event.data?.type === 'potbridge-design-view' && ['popup', 'settings'].includes(event.data.view)) {
    view = event.data.view; render();
  }
});
addEventListener('storage', event => {
  if (event.key !== 'potbridge-design-theme' || !themes[event.newValue] || selected === event.newValue) return;
  selected = event.newValue;
  document.querySelector(`input[value="${selected}"]`).checked = true;
  render(false);
});
new ResizeObserver(updateSizeLabel).observe(document.querySelector('#preview'));
render();
