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
