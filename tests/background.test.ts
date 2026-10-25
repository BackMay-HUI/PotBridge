import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeController } from '../extension/src/shared/controller.ts';

function setup(refreshURL?: string, onNative?: (type: string, controller: BridgeController) => Promise<void>) {
  const calls: any[] = [];
  let tab = { id: 1, url: 'https://www.cycani.org/anime/2972/play/9', title: 'Episode 9' };
  const base = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
  const controller: BridgeController = new BridgeController({ extensionBase: base, getTab: async () => tab, sendToTab: async () => ({ ok: true, url: refreshURL }), native: async (type, payload) => { calls.push({ type, payload }); await onNative?.(type, controller); return { session: { id: 's1' } }; }, saveSettings: async () => {} });
  const ui = { url: base + 'popup.html' };
  const page = { tab: { id: 1 }, frameId: 0, url: tab.url };
  return { controller, calls, ui, page, navigate: (url: string) => { tab = { ...tab, url }; }, get tab() { return tab; } };
}

test('web page messages cannot launch a process or configure executable paths', async () => {
  const h = setup();
  for (const type of ['play', 'saveConfig', 'stop', 'hello']) {
    await assert.rejects(h.controller.handle({ type, tabId: 1 }, h.page), (e: any) => e.code === 'FORBIDDEN');
  }
  assert.equal(h.calls.length, 0);
});

test('refresh replaces the selected source so the next play cannot reuse an expired URL', async () => {
  const h = setup('https://cdn.example/a.m3u8?token=new');
  const info = await h.controller.handle({ type: 'pageHello', pageUrl: h.tab.url, nonce: 'doc1' }, h.page);
  await h.controller.handle({ type: 'pageCandidate', pageKey: info.pageKey, pageUrl: h.tab.url, url: 'https://cdn.example/a.m3u8?token=old', source: 'cycani', sectionId: '40246' }, h.page);
  const state = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
  const selected = state.candidates[0].id;
  await h.controller.handle({ type: 'refresh', tabId: 1, candidateId: selected }, h.ui);
  await h.controller.handle({ type: 'play', tabId: 1, candidateId: selected }, h.ui);
  assert.equal(h.calls[0].payload.candidate.url, 'https://cdn.example/a.m3u8?token=new');
  const after = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
  assert.equal(after.candidates.length, 1);
});

test('only the current page candidate can be sent and page-supplied credentials are discarded', async () => {
  const h = setup();
  const info = await h.controller.handle({ type: 'pageHello', pageUrl: h.tab.url, nonce: 'doc1' }, h.page);
  await h.controller.handle({ type: 'pageCandidate', pageKey: info.pageKey, pageUrl: h.tab.url, url: 'https://cdn.example/a.m3u8?s=123', source: 'cycani', sectionId: '40246', headersByOrigin: { 'https://cdn.example': { authorization: 'secret' } } }, h.page);
  const state = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
  assert.equal(state.candidates.length, 1);
  assert.deepEqual(state.candidates[0].headersByOrigin, {});
  await h.controller.handle({ type: 'play', tabId: 1, candidateId: state.candidates[0].id }, h.ui);
  assert.equal(h.calls[0].type, 'play');
  h.navigate('https://www.cycani.org/anime/2972/play/10');
  await assert.rejects(h.controller.handle({ type: 'play', tabId: 1, candidateId: state.candidates[0].id }, h.ui), (e: any) => e.code === 'NO_MEDIA');
  assert.equal(h.calls.length, 1);
});

test('disabled sites do not retain observed network candidates', async () => {
  const h = setup(); h.navigate('https://unrelated.example/watch'); h.page.url = h.tab.url;
  const info = await h.controller.handle({ type: 'pageHello', pageUrl: h.tab.url, nonce: 'doc1' }, h.page);
  assert.equal(info.enabled, false);
  h.controller.observeNetwork(1, 0, info.pageKey, 'https://cdn.example/a.m3u8', 'application/vnd.apple.mpegurl', {});
  const state = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
  assert.deepEqual(state.candidates, []);
});

test('fMP4 fragments never displace the logical HLS playback source', async () => {
  const h = setup();
  const info = await h.controller.handle({ type: 'pageHello', pageUrl: h.tab.url, nonce: 'doc1' }, h.page);
  await h.controller.handle({ type: 'pageCandidate', pageKey: info.pageKey, pageUrl: h.tab.url, url: 'https://cdn.example/master.m3u8', source: 'cycani', sectionId: '40246' }, h.page);
  for (let i = 0; i < 25; i++) h.controller.observeNetwork(1, 0, info.pageKey, `https://cdn.example/seg${i}.m4s`, 'video/mp4', { cookie: 'media=allowed' });
  const state = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
  assert.equal(state.candidates.length, 1);
  assert.equal(state.candidates[0].source, 'cycani');
  assert.equal(state.candidates[0].headersByOrigin['https://cdn.example'].cookie, 'media=allowed');
  for (let i = 0; i < 25; i++) h.controller.observeNetwork(1, 0, info.pageKey, `https://cdn.example/noisy${i}`, 'video/mp4', {});
  const noisy = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
  assert.ok(noisy.candidates.some((c: any) => c.source === 'cycani'));
});

test('a player request arriving before the play reply is reflected in final state', async () => {
  const h = setup(undefined, async (type, controller) => {
    if (type === 'play') await controller.onNativeEvent({ protocolVersion: 1, type: 'mediaRequested', sessionId: 's1' });
  });
  const info = await h.controller.handle({ type: 'pageHello', pageUrl: h.tab.url, nonce: 'doc1' }, h.page);
  await h.controller.handle({ type: 'pageCandidate', pageKey: info.pageKey, pageUrl: h.tab.url, url: 'https://cdn.example/master.m3u8', source: 'cycani', sectionId: '40246' }, h.page);
  const state = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
  await h.controller.handle({ type: 'play', tabId: 1, candidateId: state.candidates[0].id }, h.ui);
  assert.equal((await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui)).status, 'requested');
});

test('disconnected host diagnostics still export browser evidence', async () => {
  const h = setup(undefined, async type => { if (type === 'diagnostics') throw { code: 'NATIVE_DISCONNECTED', message: '连接未建立' }; });
  const report = await h.controller.handle({ type: 'diagnostics' }, h.ui);
  assert.equal(report.host.error.code, 'NATIVE_DISCONNECTED');
  assert.ok(Array.isArray(report.currentPages));
});

for (const change of ['navigate', 'reload', 'close'] as const) {
  test(`a play reply after ${change} stops the new session instead of losing its controls`, async () => {
    const h = setup(undefined, async type => {
      if (type !== 'play') return;
      if (change === 'navigate') {
        h.navigate('https://www.cycani.org/anime/2972/play/10');
        h.controller.invalidate(1, h.tab.url);
      } else if (change === 'reload') {
        await h.controller.handle({ type: 'pageHello', pageUrl: h.tab.url, nonce: 'doc2' }, h.page);
      } else h.controller.remove(1);
    });
    const info = await h.controller.handle({ type: 'pageHello', pageUrl: h.tab.url, nonce: 'doc1' }, h.page);
    await h.controller.handle({ type: 'pageCandidate', pageKey: info.pageKey, pageUrl: h.tab.url, url: 'https://cdn.example/master.m3u8', source: 'cycani', sectionId: '40246' }, h.page);
    const state = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
    await assert.rejects(h.controller.handle({ type: 'play', tabId: 1, candidateId: state.candidates[0].id }, h.ui), (e: any) => e.code === 'CONTENT_CHANGED');
    assert.deepEqual(h.calls.map(c => [c.type, c.payload?.sessionId]), [['play', undefined], ['stop', 's1']]);
    assert.equal((await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui)).sessionId, undefined);
  });
}
