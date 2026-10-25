import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { classifyMedia, safeMediaUrl } from '../extension/src/shared/media.ts';

async function harness() {
  const sent: any[] = [], controls: any[] = [];
  const location = { href: 'https://www.cycani.org/anime/2972/play/9', origin: 'https://www.cycani.org' };
  const oldURL = 'https://cdn.example/episode9.m3u8';
  const entries = [{ name: oldURL, startTime: 5 }];
  let tick: () => void = () => {}, listener: (e: any) => void = () => {};
  const window = { addEventListener: (_: string, fn: any) => { listener = fn; }, postMessage: (m: any) => controls.push(m) };
  const context = vm.createContext({ window, location, crypto, classifyMedia, safeMediaUrl,
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
