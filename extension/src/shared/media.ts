import type { MediaCandidate, MediaFormat, MediaTrack } from './types.ts';

export function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 16384) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function classifyMedia(value: string, mime = ''): MediaFormat | null {
  const safe = safeMediaUrl(value);
  if (!safe) return null;
  const type = mime.toLowerCase().split(';')[0].trim();
  if (['text/html', 'application/json'].includes(type)) return null;
  const path = new URL(safe).pathname.toLowerCase();
  if (/\.(m4s|cmfv|cmfa|ts|aac|key)$/.test(path) || /\/(?:init|initialization)(?:[._-][^/]*)?\.mp4$/.test(path)) return null;
  if (['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(type) || /\.m3u8?$/.test(path)) return 'hls';
  if (type === 'application/dash+xml' || path.endsWith('.mpd')) return 'dash';
  if (['video/x-flv', 'video/flv', 'application/x-flv'].includes(type) || path.endsWith('.flv')) return 'flv';
  if (['video/mp4', 'audio/mp4'].includes(type) || /\.(mp4|m4v|mov)$/.test(path)) return 'mp4';
  return null;
}

export function sanitizeTrack(value: any): MediaTrack | null {
  const url = safeMediaUrl(value?.url ?? value?.baseUrl ?? value?.base_url);
  if (!url || !value || typeof value !== 'object') return null;
  const track: MediaTrack = { url };
  const backup = value.backupUrls ?? value.backupUrl ?? value.backup_url;
  if (Array.isArray(backup)) track.backupUrls = [...new Set(backup.slice(0, 2).map(safeMediaUrl).filter((s): s is string => !!s && s !== url))];
  for (const [key, input] of [['id', value.id], ['mimeType', value.mimeType ?? value.mime_type], ['codecs', value.codecs], ['frameRate', value.frameRate ?? value.frame_rate]] as const) {
    if ((typeof input === 'string' || typeof input === 'number') && String(input).length <= 100 && !/[\r\n\0]/.test(String(input))) track[key] = String(input);
  }
  for (const key of ['bandwidth', 'width', 'height'] as const) if (Number.isFinite(value[key]) && value[key] > 0 && value[key] <= 1e10) track[key] = value[key];
  return track;
}

export function sanitizeHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase();
    if (['referer', 'origin', 'user-agent', 'cookie'].includes(name) && typeof value === 'string' && value.length <= 16384 && !/[\r\n\0]/.test(value)) out[name] = value;
  }
  return out;
}

export function describeUrl(value: string): string {
  try {
    const url = new URL(value);
    const ext = url.pathname.match(/\.(m3u8?|mp4|mpd|m4s|ts|key)$/i)?.[0] ?? '';
    return `${url.origin}/…${ext}`;
  } catch { return '无效地址'; }
}

export class CandidateStore {
  private pages = new Map<number, { pageKey: string; pageUrl: string; items: MediaCandidate[] }>();
  private limit: number;
  constructor(limit = 20) { this.limit = limit; }
  navigate(tabId: number, pageKey: string, pageUrl: string): void {
    const old = this.pages.get(tabId);
    if (old?.pageKey === pageKey && old.pageUrl === pageUrl) return;
    this.pages.set(tabId, { pageKey, pageUrl, items: [] });
  }
  page(tabId: number) { return this.pages.get(tabId); }
  remove(tabId: number) { this.pages.delete(tabId); }
  replace(candidate: MediaCandidate): boolean {
    const page = this.pages.get(candidate.tabId);
    if (!page || page.pageKey !== candidate.pageKey || !page.items.some(c => c.id === candidate.id)) return false;
    page.items = page.items.filter(c => c.id !== candidate.id && !(c.frameId === candidate.frameId && c.url === candidate.url));
    return this.add(candidate);
  }
  add(candidate: MediaCandidate): boolean {
    const page = this.pages.get(candidate.tabId);
    if (!page || page.pageKey !== candidate.pageKey || !safeMediaUrl(candidate.url)) return false;
    const existing = page.items.find(c => c.frameId === candidate.frameId && (c.url === candidate.url || (candidate.source === 'bilibili' && candidate.contentId && candidate.video?.id && c.source === 'bilibili' && c.contentId === candidate.contentId && c.video?.id === candidate.video.id && c.video.codecs === candidate.video.codecs)));
    const preservePair = existing?.video && (candidate.source !== 'bilibili' ||
      (existing.source === 'bilibili' && existing.audio && candidate.video && !candidate.audio && existing.contentId && existing.contentId === candidate.contentId));
    const item = existing ? {
      ...existing, ...candidate, id: existing.id,
      source: ['cycani', 'bilibili'].includes(existing.source) ? existing.source : candidate.source,
      sectionId: candidate.sectionId ?? existing.sectionId,
      headersByOrigin: { ...existing.headersByOrigin, ...candidate.headersByOrigin },
      ...(preservePair ? { url: existing.url, format: existing.format, video: existing.video, audio: existing.audio, quality: existing.quality, contentId: existing.contentId } : {}),
    } : candidate;
    const priority = (c: MediaCandidate) => Number(['cycani', 'bilibili'].includes(c.source)) * 2 + Number(c.format === 'hls' || c.format === 'dash');
    const compatible = (c: MediaCandidate) => Number(c.source === 'bilibili' && !!c.video?.codecs?.startsWith('avc'));
    page.items = [...page.items.filter(c => c !== existing && !(c.frameId === candidate.frameId && c.url === candidate.url)), item]
      .sort((a, b) => priority(b) - priority(a) || compatible(b) - compatible(a) || (b.video?.height ?? 0) - (a.video?.height ?? 0) || b.capturedAt - a.capturedAt).slice(0, this.limit);
    return true;
  }
  list(tabId: number): MediaCandidate[] {
    const rank = (c: MediaCandidate) => Number(['cycani', 'bilibili'].includes(c.source)) * 2 + Number(c.format === 'hls' || c.format === 'dash');
    const compatible = (c: MediaCandidate) => c.source === 'bilibili' && c.video ? Number(!c.video.codecs?.startsWith('avc')) : 0;
    return [...(this.pages.get(tabId)?.items ?? [])].sort((a, b) => rank(b) - rank(a) || compatible(a) - compatible(b) || (b.video?.height ?? 0) - (a.video?.height ?? 0) || b.capturedAt - a.capturedAt);
  }
}
