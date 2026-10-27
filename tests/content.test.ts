import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { classifyMedia, safeMediaUrl, sanitizeTrack } from '../extension/src/shared/media.ts';

async function harness() {
  const sent: any[] = [], controls: any[] = [];
  const location = { href: 'https://www.cycani.org/anime/2972/play/9', origin: 'https://www.cycani.org' };
  const oldURL = 'https://cdn.example/episode9.m3u8';
  const entries = [{ name: oldURL, startTime: 5 }];
  let tick: () => void = () => {}, listener: (e: any) => void = () => {};
  const window = { addEventListener: (_: string, fn: any) => { listener = fn; }, postMessage: (m: any) => controls.push(m) };
  const context = vm.createContext({ window, location, crypto, classifyMedia, safeMediaUrl, sanitizeTrack,
    document: { querySelectorAll: () => [{ src: oldURL }], addEventListener: () => {} }, HTMLMediaElement: class {},
    performance: { getEntriesByType: () => entries, now: () => 10 }, setTimeout, clearTimeout,
    setInterval: (fn: () => void) => { tick = fn; },
    chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: async (m: any) => {
      sent.push(m); return { result: { enabled: true, pageKey: location.href, pageUrl: location.href } };
    } } },
  });
  const source = (await readFile('extension/src/content.ts', 'utf8')).replace(/^import .*;\r?\n/, '');
  vm.runInContext(stripTypeScriptTypes(source), context);
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  await settle();
  return { sent, controls, location, tick: () => tick(), settle, message: (data: object) => listener({ source: window, origin: location.origin, data: { channel: 'potbridge:page', ...data } }) };
}

test('SPA navigation never relabels previous DOM or performance media as the new episode', async () => {
  const h = await harness();
  assert.equal(h.sent.filter(m => m.type === 'pageCandidate').length, 1);
  h.location.href = 'https://www.cycani.org/anime/2972/play/10'; h.tick(); await h.settle();
  assert.equal(h.sent.filter(m => m.type === 'pageCandidate').length, 1);
});

test('fast SPA adapter responses synchronize the page generation before forwarding', async () => {
  const h = await harness();
  h.location.href = 'https://www.cycani.org/anime/2972/play/10';
  h.message({ type: 'candidate', source: 'cycani', pageUrl: h.location.href, sectionId: '40247', url: 'https://cdn.example/episode10.m3u8' });
  await h.settle();
  const latest = h.sent.filter(m => m.type === 'pageCandidate').at(-1);
  assert.equal(latest.pageUrl, h.location.href); assert.equal(latest.pageKey, h.location.href);
  assert.equal(latest.url, 'https://cdn.example/episode10.m3u8');
  assert.ok(h.controls.filter(m => m.type === 'clear').every(m => m.pageUrl !== undefined));
});

test('structured Bilibili pairs survive isolated-world forwarding without accepting bare m4s fragments', async () => {
  const h = await harness();
  const video = { url: 'https://video.example/v.m4s', codecs: 'avc1.640028', id: '80' };
  const audio = { url: 'https://audio.example/a.m4s', codecs: 'mp4a.40.2' };
  h.message({ type: 'candidate', source: 'bilibili', pageUrl: h.location.href, url: video.url, video, audio, quality: '1080P', contentId: 'cid:99' });
  await h.settle();
  const latest = h.sent.filter(m => m.type === 'pageCandidate').at(-1);
  assert.deepEqual(latest.video, video); assert.deepEqual(latest.audio, audio); assert.equal(latest.contentId, 'cid:99');
});

test('structured forwarding keeps later audio, changed audio and backup metadata for one video URL', async () => {
  const h = await harness();
  const video = { url: 'https://video.example/v.m4s', codecs: 'avc1.640028' };
  const base = { type: 'candidate', source: 'bilibili', pageUrl: h.location.href, url: video.url, video, contentId: 'cid:99' };
  const updates = [base, { ...base, audio: { url: 'https://audio.example/a.m4s' } }, { ...base, audio: { url: 'https://audio.example/b.m4s' } }, { ...base, video: { ...video, backupUrls: ['https://backup.example/v.m4s'], bandwidth: 9000 }, audio: { url: 'https://audio.example/b.m4s' }, quality: '1080P' }];
  for (const update of updates) { h.message(update); await h.settle(); h.message(update); await h.settle(); }
  const forwarded = h.sent.filter(m => m.type === 'pageCandidate' && m.source === 'bilibili');
  assert.equal(forwarded.length, 4);
  assert.equal(forwarded[1].audio.url, 'https://audio.example/a.m4s');
  assert.equal(forwarded[2].audio.url, 'https://audio.example/b.m4s');
  assert.equal(forwarded[3].video.bandwidth, 9000);
});
