export interface ThemeStorage {
  local: { get(key: string): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> };
  onChanged: { addListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void };
}

export const themes = [
  { id: 'luna', name: '月下礼仪', subtitle: 'LUNA / 樱小路露娜' },
  { id: 'porcelain', name: '瓷白', subtitle: 'PORCELAIN / 简约通透' },
  { id: 'reload', name: '深蓝时刻', subtitle: 'RELOAD / P3R 灵感' },
  { id: 'mica', name: '云母', subtitle: 'MICA / Fluent 灵感' },
  { id: 'forest', name: '墨绿', subtitle: 'FOREST / 夜间专注' },
] as const;
type ThemeId = typeof themes[number]['id'];
const valid = (value: unknown): value is ThemeId => themes.some(theme => theme.id === value);
function preference(value: unknown): ThemeId {
  if (value && typeof value === 'object' && 'version' in value && value.version === 1 && 'theme' in value && valid(value.theme)) return value.theme;
  return 'luna';
}
function extensionStorage(): ThemeStorage | undefined {
  return typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.storage : undefined;
}

/** Appearance never uses the host configuration RPC or rebuilds user content. */
export async function initializeTheme(doc: Document, storage: ThemeStorage | undefined = extensionStorage()): Promise<void> {
  const win = doc.defaultView;
  const root = doc.documentElement;
  let current: ThemeId = valid(root.dataset.theme) ? root.dataset.theme : 'luna';
  let revision = 0, pendingWrites = 0;
  let queue = Promise.resolve();
  const note = (text: string) => { const node = doc.getElementById('appearance-feedback'); if (node) node.textContent = text; };
  const mirror = (theme: ThemeId) => { try { win?.localStorage.setItem('potbridge-theme', theme); return true; } catch { return false; } };

  for (const [id, name] of [['theme-menu', 'quick-theme'], ['theme-cards', 'settings-theme']]) {
    const container = doc.getElementById(id);
    if (!container) continue;
    for (const theme of themes) {
      const label = doc.createElement('label');
      label.className = id === 'theme-cards' ? 'theme-card' : 'theme-choice';
      label.dataset.choiceTheme = theme.id;
      const radio = doc.createElement('input'); radio.type = 'radio'; radio.name = name; radio.value = theme.id;
      const swatch = doc.createElement('span'); swatch.className = 'theme-swatch'; swatch.setAttribute('aria-hidden', 'true');
      const caption = doc.createElement('span'); caption.className = 'theme-caption';
      const title = doc.createElement('strong'); title.textContent = theme.name;
      const subtitle = doc.createElement('small'); subtitle.textContent = theme.subtitle;
      caption.append(title, subtitle); label.append(radio, swatch, caption); container.append(label);
      radio.addEventListener('change', () => { if (radio.checked) select(theme.id); });
    }
  }

  function apply(theme: ThemeId) {
    current = theme; root.dataset.theme = theme; mirror(theme);
    for (const radio of doc.querySelectorAll<HTMLInputElement>('input[name=quick-theme],input[name=settings-theme]')) radio.checked = radio.value === theme;
    for (const footer of doc.querySelectorAll('.theme-footer-name')) footer.textContent = `${theme.toUpperCase()} / 03`;
    note(`已选择「${themes.find(item => item.id === theme)!.name}」。主题自动保存，连接设置需单独保存。`);
  }
  function select(theme: ThemeId) {
    const selectedRevision = ++revision;
    apply(theme);
    if (!storage) {
      if (!mirror(theme)) note('已应用主题，但未能保存。请检查浏览器存储权限后重试。');
      return;
    }
    pendingWrites++;
    queue = queue.then(async () => {
      try { await storage.local.set({ appearance: { version: 1, theme } }); }
      catch { if (revision === selectedRevision) note('已应用主题，但未能保存。请重新选择主题重试。'); }
      finally { pendingWrites--; }
    });
  }
  const toggle = doc.getElementById('theme-toggle'), menu = doc.getElementById('theme-menu');
  function closeMenu(returnFocus = false) {
    if (!menu || !toggle) return;
    menu.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    if (returnFocus) toggle.focus();
  }
  toggle?.addEventListener('click', () => {
    if (!menu) return;
    menu.hidden = !menu.hidden; toggle.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) menu.querySelector<HTMLInputElement>('input:checked')?.focus();
  });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && menu && !menu.hidden) { event.preventDefault(); closeMenu(true); } });
  doc.addEventListener('click', event => {
    const target = event.target as Node | null;
    if (menu && !menu.hidden && target && !menu.contains(target) && !toggle?.contains(target)) closeMenu();
  });

  if (!storage) {
    try { const cached = win?.localStorage.getItem('potbridge-theme'); if (valid(cached)) current = cached; } catch {}
    apply(current);
    win?.addEventListener('storage', event => { if (event.key === 'potbridge-theme') apply(valid(event.newValue) ? event.newValue : 'luna'); });
    return;
  }
  apply(current);
  storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, 'appearance') || pendingWrites) return;
    revision++; apply(preference(changes.appearance.newValue));
  });
  const readRevision = revision;
  try {
    const values = await storage.local.get('appearance');
    if (readRevision === revision) apply(preference(values.appearance));
  } catch { note('主题偏好暂时无法读取，仍可切换主题并使用播放器功能。'); }
}
