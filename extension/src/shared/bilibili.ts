import type { MediaCandidate, MediaTrack } from './types.ts';
import { classifyMedia, safeMediaUrl, sanitizeTrack } from './media.ts';

export type BilibiliSource = Pick<MediaCandidate, 'url' | 'format' | 'video' | 'audio' | 'quality' | 'live'>;
const list = (input: unknown, max: number): any[] => Array.isArray(input) && input.length <= max ? input : [];
const text = (input: unknown, max = 80) => typeof input === 'string' ? input.slice(0, max) : '';
const codecRank = (track: MediaTrack) => track.codecs?.startsWith('avc') ? 0 : track.codecs?.startsWith('hev') || track.codecs?.startsWith('hvc') ? 1 : 2;

export function parseBilibiliPlayback(input: any): BilibiliSource[] {
  if (!input || typeof input !== 'object' || (typeof input.code === 'number' && input.code !== 0)) return [];
  const data = input.data ?? input.result ?? input;
  if (!data || typeof data !== 'object' || data.is_drm || data.drm_tech_type) return [];
  const body = data.video_info ?? data;
  const dash = body.dash;
  if (dash && typeof dash === 'object') {
    const audioTracks = [...list(dash.audio, 32), ...list(dash.dolby?.audio, 8), ...(dash.flac?.audio ? [dash.flac.audio] : [])].map(sanitizeTrack).filter((t): t is MediaTrack => !!t);
    const audio = audioTracks.sort((a, b) => Number(!a.codecs?.startsWith('mp4a')) - Number(!b.codecs?.startsWith('mp4a')) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    const qualities = new Map(list(body.support_formats, 64).map(q => [String(q.quality), text(q.new_description ?? q.display_desc)]));
    const videos = list(dash.video, 64).filter(v => !v?.drm_type && !v?.drm_tech_type).map(sanitizeTrack).filter((t): t is MediaTrack => !!t);
    return videos.sort((a, b) => codecRank(a) - codecRank(b) || (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0)).map(video => ({
      url: video.url, format: 'dash', video, audio,
      quality: qualities.get(video.id ?? '') || (video.height ? `${video.height}P` : '网页清晰度'),
    }));
  }
  const durl = list(body.durl, 32);
  if (durl.length) return durl.flatMap((item, i) => {
    const url = safeMediaUrl(item?.url), format = url && classifyMedia(url);
    return url && format ? [{ url, format, quality: durl.length > 1 ? `分段 ${i + 1}/${durl.length}` : '网页播放源' }] : [];
  });
  const sources: BilibiliSource[] = [];
  for (const stream of list(data.playurl_info?.playurl?.stream, 8)) {
    if (!['http_stream', 'http_hls'].includes(stream?.protocol_name)) continue;
    for (const format of list(stream.format, 8)) for (const codec of list(format?.codec, 8)) {
      for (const info of list(codec?.url_info, 8)) {
        if (typeof codec?.base_url !== 'string' || typeof info?.host !== 'string' || typeof info?.extra !== 'string') continue;
        let raw: string; try { raw = new URL(codec.base_url, info.host).href + info.extra; } catch { continue; }
        const url = safeMediaUrl(raw), kind = url && classifyMedia(url);
        if (url && (kind === 'flv' || kind === 'hls')) sources.push({ url, format: kind, live: true, quality: `直播 · ${Number(codec.current_qn) || '当前画质'}` });
        if (sources.length >= 32) return sources;
      }
    }
  }
  return sources;
}
