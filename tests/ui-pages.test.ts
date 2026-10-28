import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { Window, type HTMLElement as HappyHTMLElement } from 'happy-dom';
import { initializeTheme, type ThemeStorage } from '../extension/src/ui/theme.ts';
import { renderCandidates, statusView } from '../extension/src/ui/view.ts';
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

async function harness(page: 'popup' | 'options', rejectHost = false) {
  const win = new Window({ url: `https://extension.example/${page}.html` });
  win.document.write(await readFile(`extension/${page}.html`, 'utf8'));
  const calls: { type: string; payload?: any }[] = [], downloads: string[] = [];
  let change!: (changes: Record<string, { newValue?: unknown }>, area: string) => void;
  let appearance: unknown = { version: 1, theme: 'luna' };
  const storage: ThemeStorage = {
    local: { get: async () => ({ appearance }), set: async values => { appearance = values.appearance; change?.({ appearance: { newValue: appearance } }, 'local'); } },
    onChanged: { addListener: fn => { change = fn; } },
  };
  const config = { playerPath: 'D:\\Application\\PotPlayer\\PotPlayer.exe', proxyMode: 'system', proxyUrl: '', ffprobePath: '' };
  let state: any = { pageUrl: 'https://www.bilibili.com/video/BVtest/', enabled: true, candidates: [
    { id: 'full', title: 'example', url: 'https://cdn.example/v.mpd?token=secret', quality: '1080P', source: 'bilibili', format: 'dash', video: { url: 'https://cdn.example/v.m4s', codecs: 'avc1' }, audio: { url: 'https://cdn.example/a.m4s', codecs: 'mp4a' } },
    { id: 'second', title: 'example', url: 'https://cdn.example/s.m3u8', quality: '720P', source: 'network', format: 'hls' },
  ], status: 'detected' };
  const rpc = async (type: string, payload?: any) => {
    calls.push({ type, payload });
    if (rejectHost && type === 'hello') throw { message: 'Edge 拒绝访问本机组件 [NATIVE_HOST_FORBIDDEN]' };
    if (type === 'hello') return { version: '0.2.0', config };
    if (type === 'getState') return state;
    if (type === 'play') { state = { ...state, status: 'sent', sessionId: 'session-test' }; return {}; }
    if (type === 'stop') { state = { ...state, status: 'detected', sessionId: undefined }; return {}; }
    if (type === 'probe') return { probe: { format: 'dash', checks: [{}] } };
    if (type === 'diagnostics') return { host: { connected: true } };
    return {};
  };
  const element = (id: string) => win.document.getElementById(id)! as HappyHTMLElement;
  const tabs = { query: async () => [{ id: 19, title: '<script>not markup</script> 长标题 '.repeat(5), url: state.pageUrl }] };
  win.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  const context = vm.createContext({ document: win.document, window: win, location: win.location, navigator: win.navigator,
    HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement, URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }, Blob,
    setInterval: () => 0, setTimeout: () => 0, isExtension: true, chrome: { runtime: { id: 'example-id', openOptionsPage: async () => {} }, tabs },
    rpc, element, errorMessage: (error: any) => error.message, renderCandidates, statusView,
    initializeTheme: (doc: Document) => initializeTheme(doc, storage),
  });
  const source = (await readFile(`extension/src/ui/${page}.ts`, 'utf8')).replace(/^import .*\r?\n/gm, '');
  vm.runInContext(stripTypeScriptTypes(source), context); await settle();
  function theme(value: string) {
    const input = win.document.querySelector(`input[name="${page === 'popup' ? 'quick-theme' : 'settings-theme'}"][value="${value}"]`);
    assert.ok(input, 'production theme control must exist'); (input as any).checked = true;
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
  }
  return { win, calls, downloads, element, theme, externalTheme: (theme: string) => change({ appearance: { newValue: { version: 1, theme } } }, 'local') };
}

test('real popup keeps its chosen media and RPC actions through theme switching', async () => {
  const h = await harness('popup');
  try {
    const source = h.win.document.querySelector('input[name=source][value=second]')!;
    (source as any).checked = true; source.dispatchEvent(new h.win.Event('change', { bubbles: true }));
    const before = h.calls.length; h.theme('forest'); await settle(); assert.equal(h.calls.length, before, 'changing appearance cannot send native RPCs');
    assert.equal(h.win.document.documentElement.dataset.theme, 'forest'); assert.equal((h.win.document.querySelector('input[name=source]:checked') as any).value, 'second');
    h.element('play').click(); h.theme('mica'); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(call => call.type === 'play')?.payload)), { tabId: 19, candidateId: 'second' });
    assert.equal(h.element('status-label').textContent, '已发送到 PotPlayer'); assert.equal(h.element('stop').hidden, false);
    h.element('stop').click(); await settle(); assert.equal(h.element('stop').hidden, true);
    assert.ok(!h.element('sources').innerHTML.includes('secret')); assert.equal(h.element('page-title').querySelector('script'), null);
    assert.ok(h.element('page-title').textContent!.includes('<script>')); assert.equal(h.element('refresh').hasAttribute('disabled'), true);
  } finally { h.win.close(); }
});

test('real settings preserve unsaved configuration across local and remote themes and save only on submit', async () => {
  const h = await harness('options');
  try {
    const path = h.element('player-path') as any; path.value = 'D:\\Edited\\PotPlayer.exe'; path.focus();
    (h.element('proxy-mode') as any).value = 'manual'; h.element('proxy-mode').dispatchEvent(new h.win.Event('change'));
    (h.element('proxy-url') as any).value = 'http://127.0.0.1:7890';
    h.theme('porcelain'); await settle(); h.externalTheme('reload');
    assert.equal(path.value, 'D:\\Edited\\PotPlayer.exe'); assert.equal(h.element('proxy-url-wrap').hidden, false);
    assert.equal(h.win.document.activeElement, path); assert.equal(h.calls.filter(c => c.type === 'saveConfig').length, 0);
    assert.equal(h.win.document.documentElement.dataset.theme, 'reload');
    h.element('settings-form').dispatchEvent(new h.win.Event('submit', { bubbles: true, cancelable: true })); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c.type === 'saveConfig')?.payload.config)), { playerPath: 'D:\\Edited\\PotPlayer.exe', proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:7890', ffprobePath: '' });
    h.element('export').click(); await settle(); assert.match(h.downloads[0], /^potbridge-diagnostics-\d+\.json$/);
    h.element('stop-all').click(); await settle(); assert.equal(h.calls.at(-1)?.type, 'stopAll');
  } finally { h.win.close(); }
});

test('native connection errors remain visible and appearance stays usable in both real pages', async () => {
  for (const page of ['popup', 'options'] as const) {
    const h = await harness(page, true);
    try {
      h.theme('mica'); await settle(); assert.equal(h.win.document.documentElement.dataset.theme, 'mica');
      assert.match(h.element(page === 'popup' ? 'notice' : 'settings-feedback').textContent!, /NATIVE_HOST_FORBIDDEN/);
      if (page === 'popup') assert.equal((h.element('play') as any).disabled, true);
      else assert.equal(h.element('install-guide').hasAttribute('open'), true);
    } finally { h.win.close(); }
  }
});
