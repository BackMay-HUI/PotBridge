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

test('many Bilibili representations cannot evict the preferred compatible video', () => {
  const store=new CandidateStore(4);store.navigate(1,'page','https://www.bilibili.com/video/BV123/');
  const candidate=(id:string,codecs:string,time:number):any=>({id,tabId:1,frameId:0,pageKey:'page',pageUrl:'https://www.bilibili.com/video/BV123/',title:'Video',source:'bilibili',format:'dash',url:`https://video.example/${id}.m4s`,video:{id,url:`https://video.example/${id}.m4s`,height:1080,codecs},audio:{url:'https://audio.example/a.m4s'},capturedAt:time,headersByOrigin:{},contentId:'cid:99'});
  store.add(candidate('avc','avc1.640028',1));
  for(let i=0;i<20;i++)store.add(candidate(`av1-${i}`,'av01.0.08M.08',100+i));
  assert.ok(store.list(1).some(c=>c.id==='avc'));
  assert.equal(store.list(1)[0].id,'avc');
});

test('later network MIME observations cannot downgrade a structured pair to a silent MP4', () => {
  const store=new CandidateStore();store.navigate(1,'page-1','https://www.bilibili.com/video/BV123/');
  const url='https://video.example/opaque-media';
  store.add({...candidate(url),source:'bilibili',contentId:'cid:99',format:'dash',video:{url,id:'80'},audio:{url:'https://audio.example/audio.m4s'}});
  store.add({...candidate(url,'page-1',2),format:'mp4'});
  const current=store.list(1)[0];
  assert.equal(current.format,'dash');assert.ok(current.audio);assert.equal(current.source,'bilibili');
});

test('generic DASH and HLS manifests remain the default ahead of later MP4 fragments', () => {
  for (const format of ['dash', 'hls'] as const) {
    const store = new CandidateStore();
    store.navigate(1, 'page-1', 'https://site.example/episode/1');
    store.add({ ...candidate('https://cdn.example/manifest', 'page-1', 1), format });
    for (let i = 0; i < 30; i++) store.add({ ...candidate(`https://cdn.example/segment-${i}`, 'page-1', 10 + i), format: 'mp4' });
    assert.equal(store.list(1).length, 20);
    assert.equal(store.list(1)[0].format, format);
    assert.equal(store.list(1)[0].url, 'https://cdn.example/manifest');
  }
});
