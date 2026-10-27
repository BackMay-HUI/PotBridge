import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBilibiliAdapter } from '../extension/src/shared/bilibili-adapter.ts';
import { CandidateStore } from '../extension/src/shared/media.ts';

const data = () => ({ code: 0, data: { dash: { video: [{ id: 80, baseUrl: 'https://video.example/v.m4s?secret=keep', codecs: 'avc1.640028', height: 1080 }], audio: [{ id: 30280, baseUrl: 'https://audio.example/a.m4s', codecs: 'mp4a.40.2' }] } } });
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
function harness(initial?: any, delayed = false, responseFor?: (url: string) => unknown) {
  const messages: any[] = [], listeners: any[] = [], ticks: any[] = [];
  let complete: (response: Response) => void = () => {};
  class XHR extends EventTarget {
    responseType = ''; responseText = ''; response: any; status = 200;
    open(_method: string, _url: string) {}
    respond(value: any) { this.responseText = JSON.stringify(value); this.response = this.responseType === 'json' ? value : this.responseText; this.dispatchEvent(new Event('load')); }
  }
  const env: any = {
    location: { href: 'https://www.bilibili.com/video/BV1234567890/', origin: 'https://www.bilibili.com' },
    fetch: async (input: any) => delayed ? new Promise<Response>(resolve => { complete = resolve; }) : new Response(JSON.stringify(responseFor?.(typeof input === 'string' ? input : input.url) ?? data())),
    XMLHttpRequest: XHR, __playinfo__: initial,
    __INITIAL_STATE__: { bvid: 'BV1234567890', cid: 99, videoData: { aid: 123, pages: [{ page: 1, cid: 99 }, { page: 2, cid: 222 }] } },
    postMessage: (value: any) => messages.push(value),
    addEventListener: (type: string, listener: any) => { if (type === 'message') listeners.push(listener); },
    setInterval: (fn: any) => { ticks.push(fn); },
  };
  installBilibiliAdapter(env);
  const control = (value: object) => listeners.forEach(fn => fn({ source: env, origin: env.location.origin, data: { channel: 'potbridge:control', ...value } }));
  return { env, messages, control, tick: () => ticks.forEach(fn => fn()), resolve: () => complete(new Response(JSON.stringify(data()))) };
}

test('Bilibili fetch interception preserves the response and exports only structured media', async () => {
  const h = harness();
  const response = await h.env.fetch('https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1234567890&cid=99', { headers: { Authorization: 'Bearer private-account' } });
  assert.equal((await response.json()).code, 0); await settle();
  const candidate = h.messages.find(m => m.type === 'candidate');
  assert.equal(candidate?.video.url, 'https://video.example/v.m4s?secret=keep');
  assert.equal(candidate?.audio.url, 'https://audio.example/a.m4s');
  assert.match(candidate.contentId, /99/);
  assert.ok(!JSON.stringify(h.messages).includes('private-account'));
});

test('Bilibili XHR and initial page playback data both discover complete pairs', async () => {
  const xhr = harness();
  const request = new xhr.env.XMLHttpRequest(); request.open('GET', 'https://api.bilibili.com/x/player/playurl?cid=99'); request.respond(data());
  await settle();
  assert.ok(xhr.messages.some(m => m.type === 'candidate' && m.audio));
  const initial = harness(data()); initial.tick(); await settle();
  assert.ok(initial.messages.some(m => m.type === 'candidate' && m.audio));
});

test('Bilibili discards in-flight responses after a route change or site disable', async () => {
  for (const action of ['navigate', 'disable']) {
    const h = harness(undefined, true);
    const pending = h.env.fetch('https://api.bilibili.com/x/player/wbi/playurl?cid=99');
    if (action === 'navigate') { h.env.location.href = 'https://www.bilibili.com/video/BV0987654321/'; h.control({ type: 'clear' }); }
    else h.control({ type: 'disable' });
    h.resolve(); await pending; await settle();
    assert.equal(h.messages.filter(m => m.type === 'candidate').length, 0);
  }
});

test('Bilibili never relabels old initial playback data as the next video', async () => {
  const h = harness(data()); h.tick(); await settle();
  const before = h.messages.filter(m => m.type === 'candidate').length;
  assert.ok(before > 0);
  h.env.location.href = 'https://www.bilibili.com/video/BV0987654321/'; h.control({ type: 'clear' }); h.tick(); await settle();
  assert.equal(h.messages.filter(m => m.type === 'candidate').length, before);
});

test('Bilibili reconciles selected part, current CID, request identifiers and response identifiers', async () => {
  const h = harness();
  h.env.location.href += '?p=2'; h.env.__INITIAL_STATE__.cid = 222;
  for (const query of ['bvid=BV1234567890&cid=99', 'aid=456&cid=222', 'ep_id=123&cid=222', 'room_id=123&cid=222']) {
    const request = new h.env.XMLHttpRequest(); request.open('GET', `https://api.bilibili.com/x/player/playurl?${query}`); request.respond(data());
  }
  assert.equal(h.messages.length, 0);
  const badResponse = new h.env.XMLHttpRequest(); badResponse.open('GET', 'https://api.bilibili.com/x/player/playurl?aid=123&cid=222'); badResponse.respond({ ...data(), data: { ...data().data, cid: 99 } });
  assert.equal(h.messages.length, 0);
  const good = new h.env.XMLHttpRequest(); good.open('GET', 'https://api.bilibili.com/x/player/playurl?aid=123&cid=222'); good.respond(data());
  assert.equal(h.messages[0]?.contentId, 'BV1234567890:p2:222');
});

test('Bilibili rejects lagging part state and unseen initial data across a part switch', () => {
  const h = harness();
  h.env.location.href += '?p=2'; h.control({ type: 'clear' });
  h.env.__playinfo__ = data(); h.tick();
  const req = new h.env.XMLHttpRequest(); req.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=99'); req.respond(data());
  assert.equal(h.messages.length, 0);
  h.env.__INITIAL_STATE__.cid = 222; h.tick();
  assert.equal(h.messages.length, 0, 'unidentified initial payload is not proven to belong to p2');
  h.env.__playinfo__ = { ...data(), data: { ...data().data, cid: 222 } }; h.tick();
  assert.equal(h.messages[0]?.contentId, 'BV1234567890:p2:222');
});

test('Bilibili forwards meaningful metadata and backup updates without repeating unchanged captures', () => {
  const h = harness(data());
  const changed: any = data(); changed.data.dash.video[0].backupUrl = ['https://backup.example/v.m4s']; changed.data.dash.audio[0].bandwidth = 192000;
  h.env.__playinfo__ = changed; h.tick(); h.tick();
  assert.equal(h.messages.length, 2);
  assert.deepEqual(h.messages[1].video.backupUrls, ['https://backup.example/v.m4s']);
  assert.equal(h.messages[1].audio.bandwidth, 192000);
});

test('Bilibili rescan cannot downgrade a complete pair with older partial playback cache', () => {
  const h = harness();
  const partial: any = data(); delete partial.data.dash.audio;
  const request = new h.env.XMLHttpRequest();
  request.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=99');
  request.respond(partial);
  const complete: any = data();
  complete.data.dash.video[0].baseUrl = 'https://video.example/new-v.m4s';
  complete.data.dash.audio[0].baseUrl = 'https://audio.example/new-a.m4s';
  h.env.__playinfo__ = complete;
  h.control({ type: 'rescan' });
  const store = new CandidateStore();
  store.navigate(1, 'current', h.env.location.href);
  for (const [index, message] of h.messages.entries()) store.add({ ...message, id: String(index), tabId: 1, frameId: 0, pageKey: 'current', title: 'Current video', capturedAt: index, headersByOrigin: {} });
  assert.equal(store.list(1).length, 1);
  assert.equal(store.list(1)[0].url, 'https://video.example/new-v.m4s');
  assert.equal(store.list(1)[0].audio?.url, 'https://audio.example/new-a.m4s');
  const renewed = { ...store.list(1)[0], url: 'https://video.example/renewed.m4s', video: { ...store.list(1)[0].video!, url: 'https://video.example/renewed.m4s' }, audio: { url: 'https://audio.example/renewed.m4s' } };
  store.add(renewed);
  assert.equal(store.list(1)[0].audio?.url, 'https://audio.example/renewed.m4s');
  store.add({ ...renewed, contentId: 'BV1234567890:p2:222', audio: undefined });
  assert.equal(store.list(1)[0].audio, undefined, 'another part cannot inherit the previous part audio');
});

test('Bilibili accepts videoData identity without duplicate top-level metadata', () => {
  const h = harness();
  h.env.__INITIAL_STATE__ = { videoData: { bvid: 'BV1234567890', aid: 123, cid: 99 } };
  h.env.__playinfo__ = data(); h.tick();
  assert.equal(h.messages[0]?.contentId, 'BV1234567890:p1:99');
});

test('Bilibili accepts the route-selected page CID while an unrelated top-level CID lags', () => {
  const h = harness();
  h.env.location.href += '?p=2'; h.control({ type: 'clear' });
  const wrong = new h.env.XMLHttpRequest(); wrong.open('GET', 'https://api.bilibili.com/x/player/playurl?cid=99'); wrong.respond(data());
  assert.equal(h.messages.length, 0);
  const current = new h.env.XMLHttpRequest(); current.open('GET', 'https://api.bilibili.com/x/player/playurl?cid=222'); current.respond(data());
  assert.equal(h.messages[0]?.contentId, 'BV1234567890:p2:222');
});

test('returning to the installation route never restores ownership of unknown initial data', () => {
  const h = harness();
  h.env.location.href += '?p=2'; h.env.__INITIAL_STATE__.cid = 222; h.control({ type: 'clear' });
  const second = data(); second.data.dash.video[0].baseUrl = 'https://video.example/part2.m4s';
  h.env.__playinfo__ = second; h.tick();
  assert.equal(h.messages.length, 0);
  h.env.location.href = 'https://www.bilibili.com/video/BV1234567890/'; h.env.__INITIAL_STATE__.cid = 99; h.control({ type: 'clear' }); h.tick();
  assert.equal(h.messages.length, 0, 'unowned part-2 data cannot become part-1 initial data');
  h.env.__playinfo__ = { ...data(), data: { ...data().data, cid: 99 } }; h.tick();
  assert.equal(h.messages[0]?.contentId, 'BV1234567890:p1:99');
  assert.equal(h.messages[0]?.video.url, 'https://video.example/v.m4s?secret=keep');
});

test('Bilibili retains a prefetched part until that part becomes current', () => {
  const h = harness();
  const next = data(); next.data.dash.video[0].baseUrl = 'https://video.example/part2.m4s';
  const prefetched = new h.env.XMLHttpRequest(); prefetched.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=222'); prefetched.respond(next);
  assert.equal(h.messages.length, 0, 'prefetch must never relabel p2 as p1');
  h.env.location.href += '?p=2'; h.control({ type: 'clear' }); h.tick();
  assert.equal(h.messages[0]?.contentId, 'BV1234567890:p2:222');
  assert.equal(h.messages[0]?.video.url, 'https://video.example/part2.m4s');
});

test('Bilibili SPA video metadata and playback can arrive in either order without updating initial state', () => {
  for (const order of ['metadata-first', 'playback-first']) {
    const h = harness();
    h.env.location.href = 'https://www.bilibili.com/video/BV0987654321/'; h.control({ type: 'clear' });
    const metadata = () => { const request = new h.env.XMLHttpRequest(); request.open('GET', 'https://api.bilibili.com/x/web-interface/wbi/view/detail?bvid=BV0987654321'); request.respond({ code: 0, data: { View: { bvid: 'BV0987654321', aid: 456, cid: 333, pages: [{ page: 1, cid: 333 }] } } }); };
    const playback = () => { const request = new h.env.XMLHttpRequest(); request.open('GET', 'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV0987654321&cid=333'); request.respond(data()); };
    if (order === 'metadata-first') { metadata(); playback(); } else { playback(); assert.equal(h.messages.length, 0); metadata(); }
    assert.equal(h.messages[0]?.contentId, 'BV0987654321:p1:333', order);
    assert.equal(h.env.__INITIAL_STATE__.bvid, 'BV1234567890', 'the page initial object is intentionally stale');
  }
});

test('Bilibili never replays cached parts after a site disable', () => {
  const h = harness();
  const request = new h.env.XMLHttpRequest(); request.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=222'); request.respond(data());
  h.control({ type: 'disable' }); h.env.location.href += '?p=2'; h.control({ type: 'clear' }); h.control({ type: 'enable' }); h.tick();
  assert.equal(h.messages.length, 0);
  const fresh = new h.env.XMLHttpRequest(); fresh.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=222'); fresh.respond(data());
  assert.equal(h.messages[0]?.contentId, 'BV1234567890:p2:222');
});

test('Bilibili cached playback expires and a fresh response can still populate the current part', () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 1000;
    const h = harness();
    const expiring = data(); expiring.data.dash.video[0].baseUrl = 'https://video.example/v.m4s?deadline=60';
    const first = new h.env.XMLHttpRequest(); first.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=222'); first.respond(expiring);
    Date.now = () => 62001;
    h.env.location.href += '?p=2'; h.control({ type: 'clear' }); h.tick();
    assert.equal(h.messages.length, 0, 'expired playback must not return after navigation');
    const fresh = new h.env.XMLHttpRequest(); fresh.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=222'); fresh.respond(data());
    assert.equal(h.messages[0]?.contentId, 'BV1234567890:p2:222');
  } finally { Date.now = originalNow; }
});

test('Bilibili fetch metadata preserves the page response and activates the matching cached playback', async () => {
  const h = harness(undefined, false, url => url.includes('/view') ? { code: 0, data: { bvid: 'BV0987654321', aid: 456, cid: 333, pages: [{ page: 1, cid: 333 }] } } : data());
  h.env.location.href = 'https://www.bilibili.com/video/BV0987654321/'; h.control({ type: 'clear' });
  await h.env.fetch('https://api.bilibili.com/x/player/playurl?bvid=BV0987654321&cid=333'); await settle();
  assert.equal(h.messages.length, 0);
  const response = await h.env.fetch('https://api.bilibili.com/x/web-interface/view?bvid=BV0987654321');
  assert.equal((await response.json()).data.bvid, 'BV0987654321'); await settle();
  assert.equal(h.messages[0]?.contentId, 'BV0987654321:p1:333');
});

test('Bilibili rejects mismatched metadata before activating deferred playback', () => {
  const h = harness(); h.env.location.href = 'https://www.bilibili.com/video/BV0987654321/'; h.control({ type: 'clear' });
  const play = new h.env.XMLHttpRequest(); play.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV0987654321&cid=333'); play.respond(data());
  const wrong = new h.env.XMLHttpRequest(); wrong.open('GET', 'https://api.bilibili.com/x/web-interface/view?bvid=BV0987654321'); wrong.respond({ code: 0, data: { bvid: 'BV1234567890', aid: 123, cid: 333, pages: [{ page: 1, cid: 333 }] } });
  assert.equal(h.messages.length, 0);
  const right = new h.env.XMLHttpRequest(); right.open('GET', 'https://api.bilibili.com/x/web-interface/view?bvid=BV0987654321'); right.respond({ code: 0, data: { bvid: 'BV0987654321', aid: 456, cid: 333, pages: [{ page: 1, cid: 333 }] } });
  assert.equal(h.messages[0]?.contentId, 'BV0987654321:p1:333');
});

test('Bilibili playback cache evicts older parts while retaining bounded recent responses', () => {
  const h = harness(); h.env.__INITIAL_STATE__.videoData.pages = [{ page: 1, cid: 99 }, ...Array.from({ length: 17 }, (_, i) => ({ page: i + 2, cid: 100 + i }))];
  for (let i = 0; i < 17; i++) { const req = new h.env.XMLHttpRequest(); req.open('GET', `https://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=${100 + i}`); req.respond(data()); }
  assert.equal(h.messages.length, 0);
  h.env.location.href = 'https://www.bilibili.com/video/BV1234567890/?p=2'; h.control({ type: 'clear' }); h.tick();
  assert.equal(h.messages.length, 0, 'the oldest of more than16 cached parts was evicted');
  h.env.location.href = 'https://www.bilibili.com/video/BV1234567890/?p=18'; h.control({ type: 'clear' }); h.tick();
  assert.equal(h.messages[0]?.contentId, 'BV1234567890:p18:116');
});

test('Bilibili disabling and re-enabling cannot revive an older in-flight response', async () => {
  const h = harness(undefined, true);
  const pending = h.env.fetch('https://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=99');
  h.control({ type: 'disable' }); h.control({ type: 'enable' }); h.resolve(); await pending; await settle();
  assert.equal(h.messages.length, 0);
});

test('Bilibili metadata and playback tolerate unset optional IDs while requiring the selected CID', () => {
  const h = harness(); h.env.location.href = 'https://www.bilibili.com/video/BV0987654321/'; h.control({ type: 'clear' });
  const metadata = new h.env.XMLHttpRequest(); metadata.open('GET', 'https://api.bilibili.com/x/web-interface/view?bvid=BV0987654321&aid=0'); metadata.respond({ code: 0, data: { bvid: 'BV0987654321', aid: 456, cid: 0, pages: [{ page: 1, cid: 333 }] } });
  const play = new h.env.XMLHttpRequest(); play.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV0987654321&aid=0&cid=333'); play.respond({ ...data(), data: { ...data().data, aid: 0 } });
  assert.equal(h.messages[0]?.contentId, 'BV0987654321:p1:333');
});

test('Bilibili prefetched playback remains usable after watching a part within its URL deadline', () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 1000;
    const h = harness(); const prefetched = data(); prefetched.data.dash.video[0].baseUrl = 'https://video.example/p2.m4s?deadline=300';
    const request = new h.env.XMLHttpRequest(); request.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=222'); request.respond(prefetched);
    Date.now = () => 120000;
    h.env.location.href += '?p=2'; h.control({ type: 'clear' }); h.tick();
    assert.equal(h.messages[0]?.contentId, 'BV1234567890:p2:222');
  } finally { Date.now = originalNow; }
});

test('Bilibili unrelated metadata prefetch cannot evict the current SPA video identity', () => {
  const h = harness(); h.env.location.href = 'https://www.bilibili.com/video/BV0987654321/'; h.control({ type: 'clear' });
  const metadata = new h.env.XMLHttpRequest(); metadata.open('GET', 'https://api.bilibili.com/x/web-interface/view?bvid=BV0987654321'); metadata.respond({ code: 0, data: { bvid: 'BV0987654321', aid: 456, cid: 333 } });
  for (let i = 0; i < 9; i++) { const bvid = `BV${String(i + 1).padStart(10, '0')}`; const other = new h.env.XMLHttpRequest(); other.open('GET', `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`); other.respond({ code: 0, data: { bvid, aid: 1000 + i, cid: 2000 + i } }); }
  const play = new h.env.XMLHttpRequest(); play.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV0987654321&cid=333'); play.respond(data());
  assert.equal(h.messages[0]?.contentId, 'BV0987654321:p1:333');
});

test('Bilibili keeps a prefetched pair while an authorized backup URL is still valid', () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 1000;
    const h = harness(); const prefetched: any = data();
    prefetched.data.dash.video[0].baseUrl = 'https://video.example/p2.m4s?deadline=60';
    prefetched.data.dash.video[0].backupUrl = ['https://backup.example/p2.m4s?deadline=300'];
    prefetched.data.dash.audio[0].baseUrl += '?deadline=300';
    const request = new h.env.XMLHttpRequest(); request.open('GET', 'https://api.bilibili.com/x/player/playurl?bvid=BV1234567890&cid=222'); request.respond(prefetched);
    Date.now = () => 120000;
    h.env.location.href += '?p=2'; h.control({ type: 'clear' }); h.tick();
    assert.equal(h.messages[0]?.contentId, 'BV1234567890:p2:222');
    assert.deepEqual(h.messages[0]?.video.backupUrls, ['https://backup.example/p2.m4s?deadline=300']);
  } finally { Date.now = originalNow; }
});
