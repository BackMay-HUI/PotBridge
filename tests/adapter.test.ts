import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installCycaniAdapter } from '../extension/src/shared/page-adapter.ts';

function harness() {
  const messages: any[] = [], listeners: Array<(event: any) => void> = [];
  const requests: Array<{ url: string; headers: Headers }> = [];
  const env: any = {
    location: { href: 'https://www.cycani.org/anime/2972/play/9?from=cychub', origin: 'https://www.cycani.org' },
    fetch: async (input: any, init: RequestInit = {}) => {
      requests.push({ url: String(input.url ?? input), headers: new Headers(init.headers ?? input.headers) });
      return new Response(JSON.stringify({ code: 0, data: { url: 'https://cdn.example/stream.m3u8?sign=keep%2Bme' } }), { headers: { 'content-type': 'application/json' } });
    },
    postMessage: (data: any) => messages.push(data),
    addEventListener: (_: string, listener: any) => listeners.push(listener),
    removeEventListener: () => {},
  };
  installCycaniAdapter(env);
  const control = (data: any) => listeners.forEach(listener => listener({ source: env, origin: env.location.origin, data: { channel: 'potbridge:control', ...data } }));
  return { env, messages, requests, control };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

test('captures the exact playback response while preserving page response and keeping Bearer private', async () => {
  const h = harness();
  const response = await h.env.fetch('/api/v2/sections/40246/play-url', { headers: { Authorization: 'Bearer private-account-token' } });
  assert.equal((await response.json()).code, 0);
  await flush();
  const candidate = h.messages.find(m => m.type === 'candidate');
  assert.equal(candidate.sectionId, '40246');
  assert.equal(candidate.url, 'https://cdn.example/stream.m3u8?sign=keep%2Bme');
  assert.ok(!JSON.stringify(h.messages).includes('private-account-token'));
  h.control({ type: 'refresh', requestId: 'r1', sectionId: '40246', pageUrl: h.env.location.href });
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].headers.get('Authorization'), 'Bearer private-account-token');
  assert.equal(h.messages.find(m => m.type === 'refreshed' && m.requestId === 'r1').ok, true);
});

test('never refreshes a different episode or uses old credentials after navigation', async () => {
  const h = harness();
  await h.env.fetch('/api/v2/sections/40246/play-url', { headers: { Authorization: 'Bearer secret' } });
  await flush();
  h.control({ type: 'refresh', requestId: 'bad', sectionId: '999', pageUrl: h.env.location.href });
  h.env.location.href = 'https://www.cycani.org/anime/2972/play/10';
  h.control({ type: 'refresh', requestId: 'stale', sectionId: '40246', pageUrl: h.env.location.href });
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.messages.filter(m => m.type === 'refreshed' && !m.ok).length, 2);
});

test('ignores unrelated API responses and limits refresh to one attempt', async () => {
  const h = harness();
  await h.env.fetch('/api/user/profile'); await flush(); assert.equal(h.messages.length, 0);
  await h.env.fetch('/api/v2/sections/40246/play-url'); await flush();
  for (const requestId of ['r1', 'r2']) { h.control({ type: 'refresh', requestId, sectionId: '40246', pageUrl: h.env.location.href }); await flush(); }
  assert.equal(h.requests.length, 3);
  assert.equal(h.messages.find(m => m.requestId === 'r2').ok, false);
});

test('disabling a site discards in-flight response captures', async () => {
  const h = harness();
  const pending = h.env.fetch('/api/v2/sections/40246/play-url', { headers: { Authorization: 'Bearer secret' } });
  h.control({ type: 'disable' });
  await pending; await flush();
  assert.equal(h.messages.filter(m => m.type === 'candidate').length, 0);
});
