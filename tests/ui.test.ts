import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { statusView, renderCandidates } from '../extension/src/ui/view.ts';

test('launch and network request states never claim successful decoded playback', () => {
  for (const status of ['sent', 'requested']) {
    const view = statusView({ pageUrl: '', enabled: true, candidates: [], status }, false, true);
    assert.ok(!view.label.includes('播放成功') && !view.label.includes('正在播放'));
  }
});
test('play is disabled while busy, disconnected or without a candidate', () => {
  const state: any = { pageUrl: '', enabled: true, candidates: [{ id: '1' }], status: 'detected' };
  assert.equal(statusView(state, true, true).canPlay, false);
  assert.equal(statusView(state, false, false).canPlay, false);
  assert.equal(statusView({ ...state, candidates: [] }, false, true).canPlay, false);
  assert.equal(statusView(state, false, true).canPlay, true);
});
test('candidate titles remain text and signed addresses are not displayed', () => {
  const win = new Window(); const container = win.document.createElement('div');
  renderCandidates(container as unknown as HTMLElement, [{ id: 'one', title: '<img src=x onerror=alert(1)>', url: 'https://cdn.example/private/signature.m3u8?token=secret', format: 'hls', source: 'cycani' }] as any, 'one');
  assert.equal(container.querySelector('img'), null);
  assert.ok(container.textContent?.includes('<img'));
  assert.ok(!container.textContent?.includes('secret') && !container.innerHTML.includes('signature'));
  win.close();
});

test('Bilibili source rows show quality, codecs and paired audio without signed addresses', () => {
  const win=new Window(), container=win.document.createElement('div');
  renderCandidates(container as unknown as HTMLElement,[{id:'pair',title:'Video title',quality:'1080P 高清',source:'bilibili',format:'dash',url:'https://video.example/private.m4s?secret=1',video:{url:'https://video.example/private.m4s?secret=1',codecs:'avc1.640028'},audio:{url:'https://audio.example/private.m4s?secret=2',codecs:'mp4a.40.2'}}] as any,'pair');
  const text=container.textContent ?? '';
  for(const value of ['1080P','AVC','AAC','音视频分离']) assert.ok(text.includes(value),value);
  assert.ok(!container.innerHTML.includes('secret')&&!container.innerHTML.includes('private.m4s'));
  win.close();
});

test('missing audio cannot be sent as a complete Bilibili video and disabled sites explain how to enable', () => {
  const state:any={pageUrl:'https://www.bilibili.com/video/BV123/',enabled:true,candidates:[{id:'one',video:{url:'https://video.example/v.m4s'}}],status:'detected'};
  const missing=statusView(state,false,true);
  assert.equal(missing.canPlay,false); assert.match(missing.detail,/音轨/);
  const disabled=statusView({...state,enabled:false,candidates:[]},false,true);
  assert.match(disabled.detail,/开关|启用/);
});
