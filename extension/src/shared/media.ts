import type { MediaCandidate, MediaFormat } from './types.ts';

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
  if (['video/mp4', 'audio/mp4'].includes(type) || /\.(mp4|m4v|mov)$/.test(path)) return 'mp4';
  return null;
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
    page.items = page.items.filter(c => c.id !== candidate.id && c.url !== candidate.url);
    return this.add(candidate);
  }
  add(candidate: MediaCandidate): boolean {
    const page = this.pages.get(candidate.tabId);
    if (!page || page.pageKey !== candidate.pageKey || !safeMediaUrl(candidate.url)) return false;
    const existing = page.items.find(c => c.url === candidate.url);
    const item = existing ? {
      ...existing, ...candidate, id: existing.id,
      source: existing.source === 'cycani' ? existing.source : candidate.source,
      sectionId: candidate.sectionId ?? existing.sectionId,
      headersByOrigin: { ...existing.headersByOrigin, ...candidate.headersByOrigin },
    } : candidate;
    const priority = (c: MediaCandidate) => Number(c.source === 'cycani') * 2 + Number(c.format === 'hls' || c.format === 'dash');
    page.items = [...page.items.filter(c => c.url !== candidate.url), item]
      .sort((a, b) => priority(b) - priority(a) || b.capturedAt - a.capturedAt).slice(0, this.limit);
    return true;
  }
  list(tabId: number): MediaCandidate[] {
    return [...(this.pages.get(tabId)?.items ?? [])].sort((a, b) => Number(b.source === 'cycani') - Number(a.source === 'cycani') || b.capturedAt - a.capturedAt);
  }
}
