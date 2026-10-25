import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandidateStore, classifyMedia, sanitizeHeaders, safeMediaUrl, describeUrl } from '../extension/src/shared/media.ts';

test('detects signed HLS and MIME-based media without rewriting the URL', () => {
  const url = 'https://cdn.example/video.m3u8?sign=a%2Bb%3D&expires=123';
  assert.equal(classifyMedia(url), 'hls');
  assert.equal(safeMediaUrl(url), url);
  assert.equal(classifyMedia('https://cdn.example/stream?id=1', 'application/vnd.apple.mpegurl; charset=utf-8'), 'hls');
  assert.equal(classifyMedia('https://cdn.example/a.mpd'), 'dash');
  assert.equal(classifyMedia('https://cdn.example/a', 'video/mp4'), 'mp4');
  assert.equal(classifyMedia('https://cdn.example/a.m3u8', 'text/html'), null);
});

test('rejects browser objects, credentials, non-http URLs and fragments', () => {
  for (const url of ['blob:https://site.example/123', 'file:///c:/test.mp4', 'javascript:alert(1)', 'https://user:pass@cdn.example/a.mp4']) {
    assert.equal(safeMediaUrl(url), null);
  }
  assert.equal(safeMediaUrl('https://cdn.example/a.mp4#t=12'), 'https://cdn.example/a.mp4');
});

const candidate = (url: string, pageKey = 'page-1', capturedAt = 1) => ({
  id: String(capturedAt), tabId: 1, frameId: 0, pageKey, pageUrl: 'https://site.example/episode/1',
  title: 'Episode 1', source: 'network' as const, url, format: 'hls' as const, capturedAt, headersByOrigin: {},
});

test('isolates navigation generations and refuses stale responses', () => {
  const store = new CandidateStore();
  store.navigate(1, 'page-1', 'https://site.example/episode/1');
  assert.equal(store.add(candidate('https://cdn.example/one.m3u8')), true);
  store.navigate(1, 'page-2', 'https://site.example/episode/2');
  assert.equal(store.add(candidate('https://cdn.example/late.m3u8')), false);
  assert.deepEqual(store.list(1), []);
});

test('deduplicates exact URLs, preserves distinct signatures and bounds storage', () => {
  const store = new CandidateStore(2);
  store.navigate(1, 'page-1', 'https://site.example/episode/1');
  store.add(candidate('https://cdn.example/a.m3u8?s=1', 'page-1', 1));
  store.add(candidate('https://cdn.example/a.m3u8?s=1', 'page-1', 2));
  assert.equal(store.list(1).length, 1);
  store.add(candidate('https://cdn.example/a.m3u8?s=2', 'page-1', 3));
  assert.equal(store.list(1).length, 2);
  store.add(candidate('https://cdn.example/b.m3u8', 'page-1', 4));
  assert.equal(store.list(1).length, 2);
  assert.ok(store.list(1).every(c => c.capturedAt >= 3));
});

test('only forwards approved media headers and blocks injection', () => {
  assert.deepEqual(sanitizeHeaders({ Cookie: 'media=ok', Referer: 'https://site.example/', Authorization: 'Bearer secret', Host: 'evil', Origin: 'https://site.example', 'User-Agent': 'test\r\nX-Evil: yes' }), {
    cookie: 'media=ok', referer: 'https://site.example/', origin: 'https://site.example',
  });
});

test('diagnostic URL summaries hide signed paths and queries', () => {
  const summary = describeUrl('https://cdn.example/private-token/secret.m3u8?token=password');
  assert.equal(summary, 'https://cdn.example/….m3u8');
  assert.ok(!summary.includes('secret') && !summary.includes('password'));
});
