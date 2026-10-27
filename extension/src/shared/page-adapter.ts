import { safeMediaUrl } from './media.ts';

interface PageEnvironment {
  location: { href: string; origin: string };
  fetch: typeof fetch;
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
interface RefreshContext { url: string; sectionId: string; pageUrl: string; headers: Headers; credentials: RequestCredentials; referrerPolicy?: ReferrerPolicy; used: boolean }

export async function smallJSON(response: Response, limit = 256 * 1024): Promise<any> {
  if (Number(response.headers.get('content-length')) > limit) return null;
  const reader = response.body?.getReader(); if (!reader) return null;
  const decoder = new TextDecoder(); let text = '', total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.length;
      if (total > limit) { void reader.cancel().catch(() => {}); return null; }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch { return null; }
}

export function installCycaniAdapter(env: PageEnvironment): void {
  if (!['www.cycani.org', 'cycani.org'].includes(new URL(env.location.href).hostname)) return;
  const original = env.fetch;
  let current: RefreshContext | undefined;
  let enabled = true;
  const emit = (message: object) => env.postMessage({ channel: 'potbridge:page', ...message }, env.location.origin);
  const contextFor = (input: RequestInfo | URL, init?: RequestInit): RefreshContext | null => {
    try {
      const request = typeof input === 'object' && 'url' in input ? input as Request : undefined;
      const url = new URL(request?.url ?? String(input), env.location.href);
      const match = url.pathname.match(/^\/api\/v2\/sections\/(\d+)\/play-url$/);
      if (url.origin !== env.location.origin || !match || (init?.method ?? request?.method ?? 'GET').toUpperCase() !== 'GET') return null;
      return { url: url.href, sectionId: match[1], pageUrl: env.location.href, headers: new Headers(init?.headers ?? request?.headers), credentials: init?.credentials ?? request?.credentials ?? 'same-origin', referrerPolicy: init?.referrerPolicy ?? request?.referrerPolicy, used: false };
    } catch { return null; }
  };
  const extract = async (response: Response, context: RefreshContext): Promise<string | null> => {
    if (!enabled || context.pageUrl !== env.location.href) return null;
    if (response.status === 401) { current = undefined; emit({ type: 'page-error', pageUrl: context.pageUrl, error: { code: 'PAGE_LOGIN_REQUIRED', message: '请先在网页正常登录并开始播放。' } }); return null; }
    if (!response.ok) return null;
    const json = await smallJSON(response.clone());
    if (!enabled || context.pageUrl !== env.location.href || json?.code !== 0) return null;
    const url = safeMediaUrl(json?.data?.url); if (!url) return null;
    current = context;
    emit({ type: 'candidate', source: 'cycani', pageUrl: context.pageUrl, sectionId: context.sectionId, url });
    return url;
  };
  env.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
    if (current && current.pageUrl !== env.location.href) current = undefined;
    const context = enabled ? contextFor(input, init) : null;
    const promise = original.call(env, input, init);
    if (context) void promise.then(response => extract(response, context)).catch(() => {});
    return promise;
  } as typeof fetch;
  env.addEventListener('message', event => {
    if (event.source !== env as unknown || event.origin !== env.location.origin || event.data?.channel !== 'potbridge:control') return;
    const data = event.data;
    if (data.type === 'disable') { enabled = false; current = undefined; return; }
    if (data.type === 'enable') { enabled = true; return; }
    if (data.type === 'clear') { if (!data.pageUrl || current?.pageUrl === data.pageUrl) current = undefined; return; }
    if (data.type !== 'refresh' || typeof data.requestId !== 'string') return;
    const context = current;
    const fail = (message: string) => emit({ type: 'refreshed', requestId: data.requestId, pageUrl: env.location.href, ok: false, error: { code: 'REFRESH_UNAVAILABLE', message } });
    if (!context || context.pageUrl !== env.location.href || data.pageUrl !== context.pageUrl || data.sectionId !== context.sectionId) { fail('当前集数没有可复用的播放请求，请在网页重新播放。'); return; }
    if (context.used) { fail('已尝试重新获取一次，请回网页重新播放后再检测。'); return; }
    context.used = true;
    void original.call(env, context.url, { method: 'GET', headers: context.headers, credentials: context.credentials, referrerPolicy: context.referrerPolicy }).then(async response => {
      const url = await extract(response, context);
      if (url) emit({ type: 'refreshed', requestId: data.requestId, pageUrl: context.pageUrl, sectionId: context.sectionId, url, ok: true });
      else fail('重新获取失败，请确认网页登录状态并重新播放。');
    }).catch(() => fail('重新获取时发生网络错误，请回网页重试。'));
  });
}
