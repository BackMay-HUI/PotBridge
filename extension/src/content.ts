import { classifyMedia, safeMediaUrl } from './shared/media.ts';

let pageKey = '', pageUrl = location.href, topPageUrl = location.href, enabled = false;
let nonce = crypto.randomUUID();
const seen = new Set<string>();
const oldDOM = new Set<string>(), knownDOM = new Set<string>();
let navigated = false;
let handshake: Promise<void> | undefined;
const refreshes = new Map<string, { resolve(value: any): void; timer: ReturnType<typeof setTimeout> }>();
const send = (message: object) => chrome.runtime.sendMessage(message).catch(() => null);
async function hello() {
  const requestedPage = location.href;
  const reply = await send({ type: 'pageHello', pageUrl: requestedPage, nonce });
  if (requestedPage !== location.href) return;
  enabled = !!reply?.result?.enabled; pageKey = reply?.result?.pageKey ?? ''; topPageUrl = reply?.result?.pageUrl ?? location.href;
  window.postMessage({ channel: 'potbridge:control', type: enabled ? 'enable' : 'disable' }, location.origin);
}
function synchronize(): Promise<void> {
  if (location.href !== pageUrl) {
    const previousPage = pageUrl;
    pageUrl = location.href; nonce = crypto.randomUUID(); seen.clear(); navigated = true;
    for (const url of knownDOM) oldDOM.add(url);
    knownDOM.clear();
    window.postMessage({ channel: 'potbridge:control', type: 'clear', pageUrl: previousPage }, location.origin);
    handshake = undefined;
  }
  if (!handshake) handshake = hello();
  return handshake;
}
function candidate(raw: string, source = 'dom', sectionId?: string) {
  const url = safeMediaUrl(raw); if (!enabled || !pageKey || !url || (source !== 'cycani' && !classifyMedia(url))) return;
  const key = `${pageKey}:${url}:${source}`; if (seen.has(key)) return;
  if (seen.size >= 128) seen.delete(seen.values().next().value!); seen.add(key);
  void send({ type: 'pageCandidate', pageKey, pageUrl: topPageUrl, url, source, sectionId });
}
function scan() {
  if (!enabled) return;
  for (const element of document.querySelectorAll<HTMLMediaElement | HTMLSourceElement>('video,audio,source')) {
    const url = element instanceof HTMLMediaElement ? element.currentSrc || element.src : element.src;
    knownDOM.add(url); if (!oldDOM.has(url)) candidate(url);
  }
  // Resource Timing spans SPA pages. After a route change, live webRequest
  // capture and current DOM sources remain authoritative; the historical buffer is not.
  if (!navigated) for (const entry of performance.getEntriesByType('resource')) if (classifyMedia(entry.name)) candidate(entry.name);
}
window.addEventListener('message', async event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'potbridge:page') return;
  const data = event.data; if (data.pageUrl !== location.href) return;
  await synchronize();
  if (!enabled || data.pageUrl !== location.href) return;
  if (data.type === 'candidate') candidate(data.url, data.source, data.sectionId);
  if (data.type === 'page-error') void send({ type: 'pageError', pageKey, pageUrl: topPageUrl });
  if (data.type === 'refreshed' && refreshes.has(data.requestId)) {
    const pending = refreshes.get(data.requestId)!; clearTimeout(pending.timer); refreshes.delete(data.requestId);
    pending.resolve({ ok: data.ok === true, url: safeMediaUrl(data.url), error: data.error });
  }
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === 'rescan') { seen.clear(); handshake = undefined; void synchronize().then(() => { scan(); respond({ ok: true }); }); return true; }
  if (message.type === 'refreshSource') {
    if (!enabled || message.pageUrl !== location.href) { respond({ ok: false, error: { code: 'CONTENT_CHANGED', message: '来源页面已变化。' } }); return false; }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { refreshes.delete(requestId); respond({ ok: false, error: { code: 'REFRESH_TIMEOUT', message: '页面没有返回新地址，请刷新并重新播放。' } }); }, 15000);
    refreshes.set(requestId, { resolve: respond, timer });
    window.postMessage({ channel: 'potbridge:control', type: 'refresh', requestId, sectionId: message.sectionId, pageUrl: location.href }, location.origin);
    return true;
  }
  return false;
});
void synchronize().then(scan);
document.addEventListener('play', () => { void synchronize().then(scan); }, true);
setInterval(() => {
  void synchronize().then(scan);
}, 1500);
