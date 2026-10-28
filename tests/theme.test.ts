import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window, type HTMLInputElement, type HTMLButtonElement, type HTMLElement } from 'happy-dom';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { initializeTheme, type ThemeStorage } from '../extension/src/ui/theme.ts';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function page() {
  const win = new Window({ url: 'https://extension.example/options.html' });
  win.document.body.innerHTML = '<button id="theme-toggle" aria-expanded="false" aria-controls="theme-menu">主题</button><fieldset id="theme-menu" hidden></fieldset><div id="theme-cards"></div><p id="appearance-feedback" role="status"></p><span class="theme-footer-name"></span><input id="player-path" value="unsaved.exe"><input type="radio" name="source" value="selected" checked>';
  return win;
}
function store(value: unknown, read?: Promise<Record<string, unknown>>) {
  const listeners = new Set<(changes: Record<string, { newValue?: unknown }>, area: string) => void>();
  const data: Record<string, unknown> = { appearance: value, enabledOrigins: ['https://example.com'], config: { playerPath: 'keep.exe' } };
  const writes: Record<string, unknown>[] = [];
  const emit = (next: unknown, area = 'local') => listeners.forEach(fn => fn({ appearance: { newValue: next } }, area));
  const storage: ThemeStorage = {
    local: { get: async () => read ? await read : { appearance: data.appearance }, set: async values => { writes.push(values); Object.assign(data, values); emit(values.appearance); } },
    onChanged: { addListener: fn => { listeners.add(fn); } },
  };
  return { storage, writes, data, emit };
}
function choose(win: Window, theme: string, group = 'settings-theme') {
  const radio = win.document.querySelector<HTMLInputElement>(`input[name="${group}"][value="${theme}"]`)!;
  radio.checked = true; radio.focus(); radio.dispatchEvent(new win.Event('change', { bubbles: true }));
  return radio;
}

test('authoritative preference replaces early cache and invalid preferences safely default', async () => {
  for (const value of [{ version: 1, theme: 'porcelain' }, { version: 2, theme: 'forest' }, { version: 1, theme: '__proto__' }, null]) {
    const win = page(); win.localStorage.setItem('potbridge-theme', 'mica'); win.document.documentElement.dataset.theme = 'mica';
    const s = store(value); await initializeTheme(win.document as unknown as Document, s.storage);
    assert.equal(win.document.documentElement.dataset.theme, value?.version === 1 && value?.theme === 'porcelain' ? 'porcelain' : 'luna');
    assert.equal(s.writes.length, 0, 'opening appearance must never overwrite stored configuration'); win.close();
  }
});

test('theme changes preserve unsaved fields, source selection and focused radio while persisting only appearance', async () => {
  const win = page(), s = store({ version: 1, theme: 'luna' }); await initializeTheme(win.document as unknown as Document, s.storage);
  const path = win.document.querySelector<HTMLInputElement>('#player-path')!; path.value = 'D:\\changed-but-unsaved.exe';
  const source = win.document.querySelector('input[name=source]'); const input = choose(win, 'reload'); await settle();
  assert.equal(win.document.documentElement.dataset.theme, 'reload'); assert.equal(win.document.activeElement, input);
  assert.equal(path.value, 'D:\\changed-but-unsaved.exe'); assert.equal(win.document.querySelector('input[name=source]'), source);
  assert.deepEqual(s.writes, [{ appearance: { version: 1, theme: 'reload' } }]);
  assert.deepEqual(s.data.config, { playerPath: 'keep.exe' }); assert.deepEqual(s.data.enabledOrigins, ['https://example.com']);
  assert.equal(win.document.querySelector<HTMLInputElement>('input[name=quick-theme][value=reload]')!.checked, true); win.close();
});

test('slow startup cannot replace a selection made while loading', async () => {
  let resolveRead!: (value: Record<string, unknown>) => void;
  const pending = new Promise<Record<string, unknown>>(resolve => { resolveRead = resolve; });
  const win = page(), s = store(undefined, pending), ready = initializeTheme(win.document as unknown as Document, s.storage);
  choose(win, 'forest'); resolveRead({ appearance: { version: 1, theme: 'porcelain' } }); await ready; await settle();
  assert.equal(win.document.documentElement.dataset.theme, 'forest'); assert.deepEqual(s.data.appearance, { version: 1, theme: 'forest' }); win.close();
});

test('rapid selections stay on the newest theme and persist in order even when older writes complete later', async () => {
  const win = page(), s = store({ version: 1, theme: 'luna' }); const original = s.storage.local.set;
  let finishFirst!: () => void; let calls = 0;
  s.storage.local.set = async values => { if (++calls === 1) await new Promise<void>(resolve => { finishFirst = resolve; }); await original(values); };
  await initializeTheme(win.document as unknown as Document, s.storage); choose(win, 'mica'); await settle(); choose(win, 'forest');
  assert.equal(win.document.documentElement.dataset.theme, 'forest'); finishFirst(); await settle(); await settle();
  assert.equal(win.document.documentElement.dataset.theme, 'forest'); assert.deepEqual(s.data.appearance, { version: 1, theme: 'forest' });
  assert.equal(win.localStorage.getItem('potbridge-theme'), 'forest'); assert.equal(s.writes.length, 2); win.close();
});

test('cross-page updates and deletion synchronize controls without echo writes or resetting fields', async () => {
  const win = page(), s = store({ version: 1, theme: 'luna' }); await initializeTheme(win.document as unknown as Document, s.storage);
  const path = win.document.querySelector<HTMLInputElement>('#player-path')!; path.value = 'still-unsaved'; path.focus();
  s.emit({ version: 1, theme: 'mica' }); assert.equal(win.document.documentElement.dataset.theme, 'mica');
  assert.equal(path.value, 'still-unsaved'); assert.equal(win.document.activeElement, path); assert.equal(s.writes.length, 0);
  s.emit({ version: 1, theme: 'forest' }, 'sync'); assert.equal(win.document.documentElement.dataset.theme, 'mica');
  s.emit(undefined); assert.equal(win.document.documentElement.dataset.theme, 'luna'); win.close();
});

test('unavailable storage leaves controls usable and reports an unsaved theme', async () => {
  const win = page(), s = store(undefined);
  s.storage.local.get = async () => { throw Error('unavailable'); }; s.storage.local.set = async () => { throw Error('unavailable'); };
  await initializeTheme(win.document as unknown as Document, s.storage); choose(win, 'porcelain'); await settle();
  assert.equal(win.document.documentElement.dataset.theme, 'porcelain'); assert.match(win.document.querySelector('#appearance-feedback')!.textContent!, /未能保存|保存失败/);
  assert.equal(win.document.querySelector<HTMLInputElement>('#player-path')!.disabled, false); win.close();
});

test('Escape closes the native-radio theme menu and returns focus to its trigger', async () => {
  const win = page(); await initializeTheme(win.document as unknown as Document, store(undefined).storage);
  const toggle = win.document.querySelector<HTMLButtonElement>('#theme-toggle')!, menu = win.document.querySelector<HTMLElement>('#theme-menu')!;
  toggle.click(); assert.equal(menu.hidden, false); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(menu.hidden, true); assert.equal(win.document.activeElement, toggle); assert.equal(toggle.getAttribute('aria-expanded'), 'false'); win.close();
});

test('local early initialization accepts only supported IDs and survives blocked storage', async () => {
  const script = await readFile('extension/public/theme-init.js', 'utf8');
  for (const [saved, expected] of [['forest', 'forest'], ['__proto__', 'luna'], ['<script>', 'luna']]) {
    const root = { dataset: {} as Record<string, string> };
    vm.runInNewContext(script, { document: { documentElement: root }, localStorage: { getItem: () => saved } }); assert.equal(root.dataset.theme, expected);
  }
  const root = { dataset: {} as Record<string, string> };
  vm.runInNewContext(script, { document: { documentElement: root }, localStorage: { getItem: () => { throw Error('blocked'); } } }); assert.equal(root.dataset.theme, 'luna');
});
