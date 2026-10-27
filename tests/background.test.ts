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

for (const command of ['stop', 'stopAll']) for (const replacement of [false, true]) {
  test(`${command} cancels ${replacement ? 'replacement' : 'initial'} pending play and stops its late session`, async () => {
    let release = () => {}, entered = () => {};
    let hold = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const h = setup(undefined, async type => { if (type === 'play' && hold) { entered(); await new Promise<void>(resolve => { release = resolve; }); } });
    const info = await h.controller.handle({ type: 'pageHello', pageUrl: h.tab.url, nonce: 'doc1' }, h.page);
    await h.controller.handle({ type: 'pageCandidate', pageKey: info.pageKey, pageUrl: h.tab.url, url: 'https://cdn.example/master.m3u8', source: 'cycani', sectionId: '40246' }, h.page);
    const state = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
    const play = { type: 'play', tabId: 1, candidateId: state.candidates[0].id };
    if (replacement) await h.controller.handle(play, h.ui);
    hold = true;
    const pending = h.controller.handle(play, h.ui);
    await started;
    await h.controller.handle({ type: command, tabId: 1 }, h.ui);
    const rejected = assert.rejects(pending, (e: any) => e.code === 'PLAY_CANCELLED');
    release(); await rejected;
    const after = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
    assert.equal(after.sessionId, undefined); assert.equal(after.status, 'detected');
    assert.equal(h.calls.at(-1).type, 'stop'); assert.equal(h.calls.at(-1).payload.sessionId, 's1');
    const pendingCall = h.calls.filter(c => c.type === 'play').at(-1);
    assert.equal(typeof pendingCall.payload.operationId, 'string');
    if (command === 'stop') assert.equal(h.calls.filter(c => c.type === 'stop')[0].payload.operationId, pendingCall.payload.operationId);
  });
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
    if (type === 'play') await controller.onNativeEvent({ protocolVersion: 2, type: 'mediaRequested', sessionId: 's1' });
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
    assert.deepEqual(h.calls.map(c => [c.type, c.payload?.sessionId]), [['play', undefined], ['stop', undefined], ['stop', 's1']]);
    assert.equal(h.calls[1].payload.operationId, h.calls[0].payload.operationId);
    assert.equal((await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui)).sessionId, undefined);
  });
}

test('Bilibili paired candidates use observed media origins and never page-supplied headers', async () => {
  const h = setup(); h.navigate('https://www.bilibili.com/video/BV1234567890/'); h.page.url = h.tab.url;
  h.controller.settings.enabledOrigins.push('https://www.bilibili.com');
  const info = await h.controller.handle({ type: 'pageHello', pageUrl: h.tab.url, nonce: 'doc1' }, h.page);
  h.controller.observeNetwork(1, 0, info.pageKey, 'https://video.example/video.m4s', 'video/mp4', { Cookie: 'video=1', Referer: h.tab.url });
  h.controller.observeNetwork(1, 0, info.pageKey, 'https://audio.example/audio.m4s', 'audio/mp4', { Cookie: 'audio=1', Referer: h.tab.url });
  await h.controller.handle({ type: 'pageCandidate', source: 'bilibili', pageUrl: h.tab.url, pageKey: info.pageKey, contentId: 'cid:99', url: 'https://video.example/video.m4s', format: 'dash', video: { url: 'https://video.example/video.m4s', id: '80', codecs: 'avc1.640028' }, audio: { url: 'https://audio.example/audio.m4s', codecs: 'mp4a.40.2' }, headersByOrigin: { 'https://video.example': { cookie: 'injected' } } }, h.page);
  const state = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
  assert.equal(state.candidates.length, 1);
  assert.equal(state.candidates[0].source, 'bilibili');
  assert.equal(state.candidates[0].audio.url, 'https://audio.example/audio.m4s');
  assert.equal(state.candidates[0].headersByOrigin['https://video.example'].cookie, 'video=1');
  assert.equal(state.candidates[0].headersByOrigin['https://audio.example'].cookie, 'audio=1');
  assert.ok(!JSON.stringify(state).includes('injected'));
});

test('Bilibili top-frame tracks cannot inherit an iframe media request cookie', async () => {
  const h=setup();h.navigate('https://www.bilibili.com/video/BV1234567890/');h.page.url=h.tab.url;h.controller.settings.enabledOrigins.push('https://www.bilibili.com');
  const info=await h.controller.handle({type:'pageHello',pageUrl:h.tab.url,nonce:'doc1'},h.page);
  h.controller.observeNetwork(1,7,info.pageKey,'https://video.example/v.m4s','video/mp4',{Cookie:'iframe-only',Referer:'https://other.example/iframe'});
  await h.controller.handle({type:'pageCandidate',source:'bilibili',contentId:'cid:99',pageUrl:h.tab.url,pageKey:info.pageKey,url:'https://video.example/v.m4s',video:{url:'https://video.example/v.m4s'},audio:{url:'https://audio.example/a.m4s'}},h.page);
  const state=await h.controller.handle({type:'getState',tabId:1},h.ui);
  assert.equal(state.candidates[0].headersByOrigin['https://video.example'].cookie,undefined);
  assert.equal(state.candidates[0].headersByOrigin['https://video.example'].referer,'https://www.bilibili.com/');
});

test('a later iframe request for the same paired URL cannot replace its frame or headers', async () => {
  const h = setup(); h.navigate('https://www.bilibili.com/video/BV1234567890/'); h.page.url = h.tab.url;
  h.controller.settings.enabledOrigins.push('https://www.bilibili.com');
  const info = await h.controller.handle({ type: 'pageHello', pageUrl: h.tab.url, nonce: 'doc1' }, h.page);
  const url = 'https://video.example/stream.mp4';
  await h.controller.handle({ type: 'pageCandidate', source: 'bilibili', contentId: 'cid:99', pageUrl: h.tab.url, pageKey: info.pageKey, url, video: { url }, audio: { url: 'https://audio.example/audio.m4s' } }, h.page);
  h.controller.observeNetwork(1, 7, info.pageKey, url, 'video/mp4', { Cookie: 'iframe-only', Referer: 'https://other.example/iframe' });
  const state = await h.controller.handle({ type: 'getState', tabId: 1 }, h.ui);
  const paired = state.candidates.find((candidate: any) => candidate.video);
  assert.equal(paired.frameId, 0);
  assert.equal(paired.headersByOrigin['https://video.example'].cookie, undefined);
  assert.equal(paired.headersByOrigin['https://video.example'].referer, 'https://www.bilibili.com/');
  assert.equal(state.candidates.find((candidate: any) => candidate.frameId === 7).headersByOrigin['https://video.example'].cookie, 'iframe-only');
});
