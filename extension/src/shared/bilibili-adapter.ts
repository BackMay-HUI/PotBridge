import { parseBilibiliPlayback, type BilibiliSource } from './bilibili.ts';
import { smallJSON } from './page-adapter.ts';

interface Environment {
  location: { href: string; origin: string };
  fetch: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  __playinfo__?: unknown;
  __INITIAL_STATE__?: any;
  document?: Pick<Document, 'addEventListener'>;
  postMessage(message: unknown, origin: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  setInterval?(callback: () => void, milliseconds: number): unknown;
}
interface Context { pageUrl: string; contentId: string; generation: number; owner: Owner }
interface Owner { route: string; bvid?: string; aid?: string; cid?: string; ep_id?: string; room_id?: string }
type Identifiers = Omit<Owner, 'route'>;
interface VideoMetadata { bvid?: string; aid?: string; cid?: string; pages?: { page: string; cid: string }[] }
type CaptureContext = (Context & { kind: 'current'; epoch: number }) | { kind: 'metadata' | 'video'; epoch: number; ids: Identifiers };
interface CachedPlayback { ids: Identifiers; responseIds: Identifiers[]; sources: BilibiliSource[]; expiresAt: number }
const identityKeys = ['bvid', 'aid', 'cid', 'ep_id', 'room_id'] as const;
const MAX_JSON = 1024 * 1024;
const numericId = (value: unknown): string | undefined => (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d{0,19}$/.test(String(value)) ? String(value) : undefined;
function identifiers(value: any): Identifiers | undefined {
  const ids: Identifiers = {};
  for (const key of identityKeys) {
    if (value?.[key] === undefined || value[key] === null || value[key] === '' || (key !== 'bvid' && (value[key] === 0 || value[key] === '0'))) continue;
    const id = key === 'bvid' ? (typeof value[key] === 'string' && /^BV[a-zA-Z0-9]{10}$/.test(value[key]) ? value[key] : undefined) : numericId(value[key]);
    if (!id) return;
    ids[key] = id;
  }
  return ids;
}
function videoMetadata(payload: any): VideoMetadata | undefined {
  if (!payload || (typeof payload.code === 'number' && payload.code !== 0)) return;
  const data = payload.data ?? payload.result ?? payload, video = data.View ?? data;
  const ids = identifiers({ bvid: video?.bvid, aid: video?.aid, cid: video?.cid });
  if (!ids || (!ids.bvid && !ids.aid) || (video.pages !== undefined && !Array.isArray(video.pages)) || video.pages?.length > 1000) return;
  const pages: VideoMetadata['pages'] = [];
  const seen = new Set<string>();
  for (const item of video.pages ?? []) {
    const page = numericId(item?.page), cid = numericId(item?.cid);
    if (!page || !cid || seen.has(page)) return;
    seen.add(page); pages.push({ page, cid });
  }
  return { bvid: ids.bvid, aid: ids.aid, cid: ids.cid, pages };
}
function currentOwner(env: Environment, state: any = env.__INITIAL_STATE__): Owner | undefined {
  const route = identity(env.location.href);
  if (!route || route === 'room:') return;
  if (route.startsWith('room:')) return { route, room_id: route.slice(5) };
  if (route.startsWith('ep')) return { route, ep_id: route.slice(2) };
  const [video, part] = route.split(':p');
  const videoData = state?.videoData, rawBvid = videoData?.bvid ?? state?.bvid;
  const bvid = typeof rawBvid === 'string' && /^BV[a-zA-Z0-9]{10}$/.test(rawBvid) ? rawBvid : undefined;
  const aid = numericId(videoData?.aid);
  if (video.startsWith('BV') ? video !== bvid : video !== `av${aid}`) return;
  const pages = videoData?.pages;
  if ((pages !== undefined && !Array.isArray(pages)) || pages?.length > 1000 || !numericId(part)) return;
  const selected = Array.isArray(pages) ? pages.filter(p => numericId(p?.page) === part) : [];
  const cid = pages?.length ? (selected.length === 1 ? numericId(selected[0]?.cid) : undefined) : part === '1' ? numericId(videoData?.cid ?? state?.cid) : undefined;
  // The route selects a CID from this video's page list. Duplicate top-level
  // metadata can be absent or still describe the previous selected part.
  if (!cid) return;
  return { route, bvid, aid, cid };
}
function agrees(owner: Identifiers, ids: any): boolean {
  return identityKeys.every(key => {
    const value = ids?.[key];
    return value === undefined || value === null || (String(value).length <= 40 && String(value) === owner[key]);
  });
}
function identity(raw: string): string {
  const url = new URL(raw);
  const video = url.pathname.match(/^\/video\/((?:BV|av)[a-zA-Z0-9]+)/)?.[1];
  if (video) return `${video}:p${url.searchParams.get('p') ?? '1'}`;
  const episode = url.pathname.match(/^\/bangumi\/play\/(ep\d+)/)?.[1];
  if (episode) return episode;
  return url.hostname === 'live.bilibili.com' ? `room:${url.pathname.match(/^\/(\d+)/)?.[1] ?? ''}` : '';
}

export function installBilibiliAdapter(env: Environment): void {
  if (!['www.bilibili.com', 'live.bilibili.com'].includes(new URL(env.location.href).hostname)) return;
  const original = env.fetch, installedIdentity = identity(env.location.href);
  const seen = new Set<string>(), initialOwners = new WeakMap<object, string>();
  const metadata = new Map<string, VideoMetadata>(), playback = new Map<string, CachedPlayback>();
  let enabled = true, generation = 0, epoch = 0, initialDocument = true;
  const ownerNow = () => {
    const video = identity(env.location.href).split(':p')[0];
    const cached = [...metadata.values()].reverse().find(info => info.bvid === video || `av${info.aid}` === video);
    return cached ? currentOwner(env, { videoData: cached }) : currentOwner(env);
  };
  const valid = (context: Context) => enabled && context.generation === generation && context.pageUrl === env.location.href && JSON.stringify(ownerNow()) === JSON.stringify(context.owner);
  const emitSources = (context: Context, sources: BilibiliSource[]) => {
    if (!valid(context)) return;
    for (const source of sources) {
      const key = `${context.contentId}:${JSON.stringify(source)}`;
      if (seen.has(key)) continue;
      if (seen.size >= 256) seen.delete(seen.values().next().value!);
      seen.add(key);
      env.postMessage({ channel: 'potbridge:page', type: 'candidate', source: 'bilibili', pageUrl: context.pageUrl, contentId: context.contentId, ...source }, env.location.origin);
    }
  };
  const emit = (context: Context, payload: any) => {
    if (![payload, payload?.data, payload?.result, payload?.data?.video_info].map(identifiers).every(ids => ids && agrees(context.owner, ids))) return;
    emitSources(context, parseBilibiliPlayback(payload));
  };
  function scan() {
    if (!enabled) return;
    scanInitial();
    const owner = ownerNow();
    for (const [key, record] of playback) {
      if (Date.now() >= record.expiresAt) { playback.delete(key); continue; }
      if (owner?.cid && agrees(owner, record.ids) && record.responseIds.every(ids => agrees(owner, ids))) {
        emitSources({ pageUrl: env.location.href, contentId: `${owner.route}:${owner.cid}`, generation, owner }, record.sources);
      }
    }
  }
  const consume = (context: CaptureContext, payload: any) => {
    if (!enabled || context.epoch !== epoch) return;
    if (context.kind === 'current') { emit(context, payload); return; }
    if (context.kind === 'metadata') {
      const info = videoMetadata(payload);
      if (!info || !agrees(info, { bvid: context.ids.bvid, aid: context.ids.aid })) return;
      const key = info.bvid ?? `av${info.aid}`;
      metadata.delete(key);
      if (metadata.size >= 8) {
        const currentVideo = identity(env.location.href).split(':p')[0];
        const inactive = [...metadata].find(([, value]) => value.bvid !== currentVideo && (!value.aid || `av${value.aid}` !== currentVideo));
        metadata.delete(inactive?.[0] ?? metadata.keys().next().value!);
      }
      metadata.set(key, info);
    } else {
      const sources = parseBilibiliPlayback(payload).slice(0, 20);
      const responseIds = [payload, payload?.data, payload?.result, payload?.data?.video_info].map(identifiers);
      if (!sources.length || responseIds.some(ids => !ids || identityKeys.some(key => context.ids[key] && ids[key] && context.ids[key] !== ids[key]))) return;
      const key = JSON.stringify(context.ids);
      playback.delete(key);
      if (playback.size >= 16) playback.delete(playback.keys().next().value!);
      const cap = Date.now() + 2 * 60 * 60 * 1000;
      const trackExpiry = (urls: string[]) => Math.max(...urls.map(raw => {
        const deadline = new URL(raw).searchParams.get('deadline');
        return deadline && /^\d{1,12}$/.test(deadline) && Number(deadline) > 0 ? Math.min(cap, Number(deadline) * 1000) : cap;
      }));
      const expiresAt = Math.max(...sources.map(source => Math.min(
        trackExpiry([source.video?.url ?? source.url, ...(source.video?.backupUrls ?? [])]),
        source.audio ? trackExpiry([source.audio.url, ...(source.audio.backupUrls ?? [])]) : cap,
      )));
      playback.set(key, { ids: context.ids, responseIds: responseIds as Identifiers[], sources, expiresAt });
    }
    scan();
  };
  const contextFor = (input: RequestInfo | URL, method = 'GET'): CaptureContext | undefined => {
    if (!enabled || method.toUpperCase() !== 'GET') return;
    try {
      const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input), env.location.href);
      if (!['api.bilibili.com', 'api.live.bilibili.com', 'www.bilibili.com'].includes(url.hostname)) return;
      if (identityKeys.some(key => url.searchParams.getAll(key).length > 1)) return;
      const ids = identifiers(Object.fromEntries(url.searchParams)); if (!ids) return;
      if (/^\/x\/web-interface\/(?:wbi\/)?view(?:\/detail)?$/.test(url.pathname)) return ids.bvid || ids.aid ? { kind: 'metadata', ids, epoch } : undefined;
      if (!/^\/(?:x\/player\/(?:wbi\/)?playurl|pgc\/player\/web(?:\/v2)?\/playurl|xlive\/web-room\/v2\/index\/getRoomPlayInfo)$/.test(url.pathname)) return;
      if (/^\/x\/player\//.test(url.pathname) && ids.cid) return { kind: 'video', ids, epoch };
      const owner = ownerNow(); if (!owner) return;
      if (owner.route !== installedIdentity) initialDocument = false;
      if (!agrees(owner, Object.fromEntries(url.searchParams))) return;
      if (owner.cid && url.searchParams.get('cid') !== owner.cid) return;
      if (owner.ep_id && url.searchParams.get('ep_id') !== owner.ep_id) return;
      if (owner.room_id && url.searchParams.get('room_id') !== owner.room_id) return;
      return { kind: 'current', epoch, pageUrl: env.location.href, contentId: `${owner.route}:${owner.cid ?? owner.room_id ?? 'current'}`, generation, owner };
    } catch { return; }
  };
  env.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
    const context = contextFor(input, init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET'));
    const promise = original.call(env, input, init);
    if (context) void promise.then(async response => {
      if (response.ok && enabled && context.epoch === epoch) consume(context, await smallJSON(response.clone(), MAX_JSON));
    }).catch(() => {});
    return promise;
  } as typeof fetch;

  if (env.XMLHttpRequest) {
    const prototype = env.XMLHttpRequest.prototype, open = prototype.open;
    const requests = new WeakMap<XMLHttpRequest, CaptureContext | undefined>(), listening = new WeakSet<XMLHttpRequest>();
    prototype.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...args: unknown[]) {
      requests.set(this, contextFor(url, method));
      if (!listening.has(this)) {
        listening.add(this);
        this.addEventListener('load', () => {
          const context = requests.get(this); if (!context || !enabled || context.epoch !== epoch || this.status < 200 || this.status >= 300) return;
          try {
            if (this.responseType === 'json') {
              if (JSON.stringify(this.response).length <= MAX_JSON) consume(context, this.response);
            } else if ((!this.responseType || this.responseType === 'text') && this.responseText.length <= MAX_JSON) consume(context, JSON.parse(this.responseText));
          } catch { /* Preserve normal XHR behavior for other response types. */ }
        });
      }
      return Reflect.apply(open, this, [method, url, ...args]);
    } as XMLHttpRequest['open'];
  }

  function scanInitial() {
    if (!enabled || !env.__playinfo__ || typeof env.__playinfo__ !== 'object') return;
    const state = ownerNow(); if (!state) return;
    const current = state.route;
    if (current !== installedIdentity) initialDocument = false;
    const info = env.__playinfo__, owner = initialOwners.get(info);
    if (owner && owner !== current) return;
    // A new object after a route switch is not proof of ownership. Require an
    // explicit payload identifier; page metadata and playinfo can update apart.
    const payload = (info as any).data ?? (info as any).result ?? info;
    if (!owner && !(initialDocument && current === installedIdentity) && !(state.cid ? numericId(payload.cid) === state.cid : state.ep_id ? numericId(payload.ep_id) === state.ep_id : numericId(payload.room_id) === state.room_id)) return;
    initialOwners.set(info, current);
    emit({ pageUrl: env.location.href, contentId: `${current}:${state.cid ?? state.room_id ?? 'current'}`, generation, owner: state }, info);
  }
  env.addEventListener('message', event => {
    if (event.source !== env as unknown || event.origin !== env.location.origin || event.data?.channel !== 'potbridge:control') return;
    if (event.data.type === 'disable') { enabled = false; generation++; epoch++; seen.clear(); metadata.clear(); playback.clear(); }
    if (event.data.type === 'clear') { initialDocument = false; generation++; seen.clear(); }
    if (event.data.type === 'enable' || event.data.type === 'rescan') { enabled = true; seen.clear(); scan(); }
  });
  env.document?.addEventListener('DOMContentLoaded', scan);
  env.setInterval?.(scan, 1500);
  scan();
}
