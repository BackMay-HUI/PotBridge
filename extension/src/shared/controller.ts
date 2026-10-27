import { CandidateStore, classifyMedia, safeMediaUrl, sanitizeHeaders, sanitizeTrack, describeUrl } from './media.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import type { ExtensionSettings, MediaCandidate, TabState, HostEvent, Fault } from './types.ts';

interface Sender { url?: string; frameId?: number; tab?: { id?: number } }
interface TabInfo { id?: number; url?: string; title?: string }
interface Dependencies {
  extensionBase: string;
  getTab(id: number): Promise<TabInfo>;
  sendToTab(id: number, message: object, frameId?: number): Promise<any>;
  native(type: string, payload?: Record<string, unknown>): Promise<any>;
  saveSettings(settings: ExtensionSettings): Promise<void>;
  userAgent?: string;
}
interface Page { pageKey: string; nonce: string; pageUrl: string; title: string; status: string; error?: Fault; sessionId?: string; playOperation?: string; busy: boolean; mediaHeaders: Map<string, Record<string, string>> }
const fault = (code: string, message: string): Fault => ({ code, message });
export function asFault(error: unknown): Fault {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) return error as Fault;
  return fault('OPERATION_FAILED', '操作未完成，请重新检测后重试。');
}
export class BridgeController {
  settings: ExtensionSettings = structuredClone(DEFAULT_SETTINGS);
  private io: Dependencies;
  private store = new CandidateStore();
  private pages = new Map<number, Page>();
  private sessions = new Map<string, { tabId: number; candidate: MediaCandidate }>();
  private pendingPlays = 0;
  private stopping = 0;
  private earlyEvents = new Map<string, HostEvent[]>();
  constructor(io: Dependencies) { this.io = io; }
  enabled(url: string): boolean { try { return this.settings.enabledOrigins.includes(new URL(url).origin); } catch { return false; } }
  pageKey(tabId: number): string | undefined { return this.pages.get(tabId)?.pageKey; }
  captures(tabId: number): boolean { const page = this.pages.get(tabId); return !!page && this.enabled(page.pageUrl); }
  invalidate(tabId: number, pageUrl: string, title = ''): Page {
    const old = this.pages.get(tabId);
    if (old?.pageUrl === pageUrl) return old;
    this.cancelPending(old);
    const page: Page = { pageKey: crypto.randomUUID(), nonce: '', pageUrl, title, status: 'unidentified', sessionId: old?.sessionId, busy: false, mediaHeaders: new Map() };
    this.pages.set(tabId, page); this.store.navigate(tabId, page.pageKey, pageUrl); return page;
  }
  remove(tabId: number) { this.cancelPending(this.pages.get(tabId)); this.pages.delete(tabId); this.store.remove(tabId); }
  private cancelPending(page?: Page): void {
    const operationId = page?.playOperation;
    if (page) page.playOperation = undefined;
    if (operationId) void this.io.native('stop', { operationId }).catch(() => {});
  }
  private ui(sender: Sender): boolean { return ['popup.html', 'options.html'].some(file => sender.url?.split(/[?#]/)[0] === this.io.extensionBase + file); }
  private async current(tabId: number): Promise<Page> {
    if (!Number.isInteger(tabId) || tabId < 0) throw fault('NO_TAB', '请在视频网页中打开插件。');
    const tab = await this.io.getTab(tabId);
    const page = this.invalidate(tabId, tab.url ?? '', tab.title ?? '');
    if (tab.title) page.title = tab.title;
    return page;
  }
  private state(tabId: number): TabState {
    const page = this.pages.get(tabId);
    return { pageUrl: page?.pageUrl ?? '', enabled: this.enabled(page?.pageUrl ?? ''), candidates: this.store.list(tabId), status: page?.status ?? 'unidentified', error: page?.error, sessionId: page?.sessionId };
  }
  observeNetwork(tabId: number, frameId: number, pageKey: string, url: string, mime: string, rawHeaders: Record<string, string>): void {
    const page = this.pages.get(tabId);
    if (!page || page.pageKey !== pageKey || !this.enabled(page.pageUrl) || !safeMediaUrl(url)) return;
    const headers = sanitizeHeaders(rawHeaders), origin = new URL(url).origin;
    const frameOrigin = `${frameId}:${origin}`;
    if (/^(video\/|audio\/|application\/octet-stream)/i.test(mime)) {
      if (page.mediaHeaders.size >= 32 && !page.mediaHeaders.has(frameOrigin)) page.mediaHeaders.delete(page.mediaHeaders.keys().next().value!);
      page.mediaHeaders.set(frameOrigin, headers);
    }
    const format = classifyMedia(url, mime);
    if (format) {
      this.store.add({ id: crypto.randomUUID(), tabId, frameId, pageKey, pageUrl: page.pageUrl, title: page.title, source: 'network', url, format, capturedAt: Date.now(), headersByOrigin: { [origin]: headers } });
      if (!page.busy && !page.sessionId) page.status = 'detected';
    }
    if (format || /^(video\/|audio\/|application\/octet-stream)/i.test(mime)) {
      for (const candidate of this.store.list(tabId)) {
        if (candidate.frameId === frameId && Object.keys(candidate.headersByOrigin).length < 32) candidate.headersByOrigin[origin] = headers;
      }
    }
  }
  async handle(message: any, sender: Sender): Promise<any> {
    if (!message || typeof message.type !== 'string') throw fault('INVALID_MESSAGE', '无效消息。');
    if (['pageHello', 'pageCandidate', 'pageError'].includes(message.type)) return this.fromPage(message, sender);
    if (!this.ui(sender)) throw fault('FORBIDDEN', '网页不能执行此操作。');
    const type = message.type;
    if (type === 'hello') return this.io.native('hello');
    if (type === 'getSettings') return this.settings;
    if (type === 'saveConfig') return this.io.native('configure', { config: message.config });
    if (type === 'diagnostics') {
      const host = await this.io.native('diagnostics').catch(error => ({ error: asFault(error) }));
      return { version: '0.2.0', host, currentPages: [...this.pages.entries()].map(([tabId, page]) => ({ origin: describeUrl(page.pageUrl), status: page.status, error: page.error, candidates: this.store.list(tabId).map(c => ({ source: c.source, format: c.format, resource: describeUrl(c.url), capturedAt: c.capturedAt })) })) };
    }
    if (type === 'stopAll') {
      for (const page of this.pages.values()) page.playOperation = undefined;
      this.stopping++;
      try { const result = await this.io.native('stop'); this.sessions.clear(); for (const page of this.pages.values()) { page.sessionId = undefined; page.status = 'detected'; } return result; }
      finally { this.stopping--; }
    }
    const tabId = message.tabId as number, page = await this.current(tabId);
    if (type === 'getState') return this.state(tabId);
    if (type === 'enableSite') {
      let origin: string;
      try { const u = new URL(page.pageUrl); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); origin = u.origin; } catch { throw fault('UNSUPPORTED_PAGE', '请在普通 HTTP 或 HTTPS 视频网页启用。'); }
      const enabled = message.enabled === true;
      const origins = new Set(this.settings.enabledOrigins); enabled ? origins.add(origin) : origins.delete(origin);
      this.settings = { enabledOrigins: [...origins].slice(0, 64) }; await this.io.saveSettings(this.settings);
      if (!enabled) { this.store.navigate(tabId, crypto.randomUUID(), page.pageUrl); page.pageKey = this.store.page(tabId)!.pageKey; page.status = 'unidentified'; page.mediaHeaders.clear(); }
      try { await this.io.sendToTab(tabId, { type: 'rescan' }); } catch { /* UI tells the user to refresh the existing page. */ }
      return this.state(tabId);
    }
    if (type === 'detect') {
      page.error = undefined;
      try { await this.io.sendToTab(tabId, { type: 'rescan' }); } catch { throw fault('RELOAD_PAGE', '请刷新当前网页并开始播放，然后重新检测。'); }
      return this.state(tabId);
    }
    if (type === 'stop') {
      const operationId = page.playOperation, sessionId = page.sessionId;
      page.playOperation = undefined; this.stopping++;
      try {
        const result = operationId || sessionId ? await this.io.native('stop', { operationId, sessionId }) : { stopped: true };
        if (sessionId) this.sessions.delete(sessionId);
        page.sessionId = undefined; page.status = 'detected'; return result;
      } finally { this.stopping--; }
    }
    if (!['play', 'probe', 'refresh'].includes(type)) throw fault('UNKNOWN_COMMAND', '不支持此操作。');
    const candidate = this.store.list(tabId).find(c => c.id === message.candidateId);
    if (!this.enabled(page.pageUrl) || !candidate || candidate.pageKey !== page.pageKey) throw fault('NO_MEDIA', '当前页面没有这个媒体源，请重新检测。');
    if (page.busy || this.stopping) throw fault('BUSY', '正在检查媒体或结束中转，请稍候。');
    page.busy = true; page.status = 'checking'; page.error = undefined;
    const operationId = type === 'play' ? crypto.randomUUID() : undefined;
    if (type === 'play') { this.pendingPlays++; page.playOperation = operationId; }
    try {
      if (type === 'refresh') { await this.refreshCandidate(tabId, candidate); page.status = 'detected'; return this.state(tabId); }
      const result = await this.io.native(type, { candidate, ...(operationId ? { operationId, sessionId: page.sessionId } : {}) });
      if (type === 'play') {
        if (this.pages.get(tabId) !== page || page.pageKey !== candidate.pageKey) {
          await this.io.native('stop', { sessionId: result.session.id });
          throw fault('CONTENT_CHANGED', '当前页面已切换，已结束刚创建的中转。请重新选择媒体。');
        }
        if (page.playOperation !== operationId) {
          await this.io.native('stop', { sessionId: result.session.id });
          throw fault('PLAY_CANCELLED', '已取消本次播放并结束中转。');
        }
        const previous = page.sessionId; page.sessionId = result.session.id;
        this.sessions.set(result.session.id, { tabId, candidate });
        page.status = 'sent';
        const early = this.earlyEvents.get(result.session.id) ?? [];
        this.earlyEvents.delete(result.session.id);
        for (const event of early) await this.onNativeEvent(event);
        if (previous && previous !== page.sessionId) { try { await this.io.native('stop', { sessionId: previous }); this.sessions.delete(previous); } catch {} }
      } else page.status = 'detected';
      return result;
    } catch (error) {
      const failure = asFault(error);
      if (type !== 'play' || page.playOperation === operationId) { page.error = failure; page.status = 'error'; }
      throw failure;
    }
    finally { page.busy = false; if (page.playOperation === operationId) page.playOperation = undefined; if (type === 'play' && --this.pendingPlays === 0) this.earlyEvents.clear(); }
  }
  private async fromPage(message: any, sender: Sender) {
    const tabId = sender.tab?.id; if (tabId === undefined) throw fault('FORBIDDEN', '缺少页面来源。');
    const page = await this.current(tabId), frameId = sender.frameId ?? 0;
    if (frameId === 0 && message.pageUrl !== page.pageUrl) return { enabled: false };
    if (message.type === 'pageHello') {
      if (frameId === 0 && typeof message.nonce === 'string' && page.nonce !== message.nonce) {
        this.cancelPending(page);
        page.nonce = message.nonce; page.pageKey = crypto.randomUUID(); page.mediaHeaders.clear(); this.store.navigate(tabId, page.pageKey, page.pageUrl);
      }
      return { enabled: this.enabled(page.pageUrl), pageKey: page.pageKey, pageUrl: page.pageUrl };
    }
    if (!this.enabled(page.pageUrl) || message.pageKey !== page.pageKey) return { accepted: false };
    if (message.type === 'pageError') { page.error = fault('PAGE_LOGIN_REQUIRED', '请先在网页正常登录并开始播放。'); return { accepted: true }; }
    const url = safeMediaUrl(message.url); if (!url) return { accepted: false };
    const fromCycani = frameId === 0 && new URL(page.pageUrl).hostname === 'www.cycani.org' && message.source === 'cycani' && /^\d+$/.test(message.sectionId);
    const fromBilibili = frameId === 0 && ['www.bilibili.com', 'live.bilibili.com'].includes(new URL(page.pageUrl).hostname) && message.source === 'bilibili' && typeof message.contentId === 'string' && message.contentId.length <= 200;
    const video = fromBilibili && message.video ? sanitizeTrack(message.video) : undefined;
    const audio = fromBilibili && message.audio ? sanitizeTrack(message.audio) : undefined;
    if ((message.video && !video) || (message.audio && !audio) || (video && video.url !== url)) return { accepted: false };
    const format = video ? 'dash' : classifyMedia(url); if (!format && !fromCycani) return { accepted: false };
    const headersByOrigin: MediaCandidate['headersByOrigin'] = {};
    if (fromBilibili) for (const raw of [url, ...(video?.backupUrls ?? []), audio?.url, ...(audio?.backupUrls ?? [])]) {
      if (!raw) continue;
      const origin = new URL(raw).origin;
      headersByOrigin[origin] = { referer: new URL(page.pageUrl).origin + '/', ...(this.io.userAgent ? { 'user-agent': this.io.userAgent } : {}), ...page.mediaHeaders.get(`${frameId}:${origin}`) };
    }
    this.store.add({ id: crypto.randomUUID(), tabId, frameId, pageKey: page.pageKey, pageUrl: page.pageUrl, title: page.title, source: fromCycani ? 'cycani' : fromBilibili ? 'bilibili' : 'dom', sectionId: fromCycani ? message.sectionId : undefined, url, format: format ?? 'unknown', capturedAt: Date.now(), headersByOrigin, video: video || undefined, audio: audio || undefined, quality: fromBilibili && typeof message.quality === 'string' ? message.quality.slice(0, 100) : undefined, contentId: fromBilibili ? message.contentId : undefined, live: fromBilibili && message.live === true });
    if (!page.busy && !page.sessionId) { page.status = 'detected'; page.error = undefined; }
    return { accepted: true };
  }
  private async refreshCandidate(tabId: number, candidate: MediaCandidate): Promise<MediaCandidate> {
    if (candidate.source !== 'cycani' || !candidate.sectionId) throw fault('REFRESH_UNAVAILABLE', '此媒体源需要回到网页重新播放后再检测。');
    const result = await this.io.sendToTab(tabId, { type: 'refreshSource', sectionId: candidate.sectionId, pageUrl: candidate.pageUrl }, candidate.frameId);
    const url = safeMediaUrl(result?.url);
    if (!result?.ok || !url) throw result?.error ?? fault('REFRESH_UNAVAILABLE', '未能重新获取播放地址，请回网页重试。');
    const page = await this.current(tabId);
    if (page.pageKey !== candidate.pageKey) throw fault('CONTENT_CHANGED', '当前页面已切换，请重新选择媒体。');
    const updated = { ...candidate, url, capturedAt: Date.now() };
    this.store.replace(updated); return updated;
  }
  async onNativeEvent(event: HostEvent): Promise<void> {
    if (event.type === 'disconnected') { for (const page of this.pages.values()) { page.playOperation = undefined; if (page.sessionId || page.busy) { page.sessionId = undefined; page.error = event.error; page.status = 'error'; } } this.sessions.clear(); return; }
    const session = event.sessionId && this.sessions.get(event.sessionId);
    if (!session) {
      if (this.pendingPlays && event.sessionId && this.earlyEvents.size < 32) {
        const events = this.earlyEvents.get(event.sessionId) ?? [];
        this.earlyEvents.set(event.sessionId, [...events, event].slice(-8));
      }
      return;
    }
    const page = this.pages.get(session.tabId);
    if (event.type === 'sessionEnded') { this.sessions.delete(event.sessionId!); if (page && page.sessionId === event.sessionId) { page.sessionId = undefined; page.status = 'detected'; } return; }
    if (!page || page.pageKey !== session.candidate.pageKey) return;
    if (event.type === 'mediaRequested') page.status = 'requested';
    if (event.type === 'sessionError') { page.error = event.error; page.status = 'error'; }
    if (event.type === 'refreshNeeded') {
      try {
        const updated = await this.refreshCandidate(session.tabId, session.candidate);
        await this.io.native('updateSession', { sessionId: event.sessionId, candidate: updated });
        session.candidate = updated;
        page.error = fault('RESEND_REQUIRED', '已重新取得地址。若播放仍未恢复，请再次点击“用 PotPlayer 播放”。');
      } catch (error) { page.error = asFault(error); }
    }
  }
}
