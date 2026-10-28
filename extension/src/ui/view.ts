import type { TabState, MediaCandidate } from '../shared/types.ts';
import { describeUrl } from '../shared/media.ts';

export function statusView(state: TabState, busy: boolean, connected: boolean, selectedId?: string) {
  const selected = selectedId ? state.candidates.find(c => c.id === selectedId) : state.candidates[0];
  const missingAudio = !!selected?.video && !selected.audio;
  const labels: Record<string, [string, string]> = {
    unidentified: ['等待发现媒体', '先在网页开始播放，再点击重新检测。'],
    detected: ['媒体已就绪', '发送前会检查媒体地址及所需资源。'],
    checking: ['正在检查媒体', '正在检查连接与媒体数据，请稍候。'],
    sent: ['已发送到 PotPlayer', '已启动播放器，正在等待它请求媒体。'],
    requested: ['播放器已请求媒体', '请在 PotPlayer 中确认画面和声音是否正常。'],
    error: ['需要处理', state.error?.message ?? '请重新检测或查看诊断。'],
  };
  const [label, detail] = busy ? labels.checking : !state.enabled ? ['此站点尚未启用', '打开上方站点开关，再刷新网页并开始播放。'] : missingAudio ? ['尚未获得音轨', '检测到独立视频轨，但未获得音轨。请在网页播放后重新检测。'] : labels[state.status] ?? labels.unidentified;
  const canInspect = !busy && state.status !== 'checking' && connected && state.enabled && state.candidates.length > 0;
  return { label, detail, tone: state.error || missingAudio ? 'warning' : state.candidates.length ? 'ready' : 'quiet', canInspect, canPlay: canInspect && !missingAudio };
}

function codecName(codec?: string): string {
  if (!codec) return '未知编码';
  if (/^avc/i.test(codec)) return 'AVC';
  if (/^(hev|hvc)/i.test(codec)) return 'HEVC';
  if (/^av01/i.test(codec)) return 'AV1';
  if (/^mp4a/i.test(codec)) return 'AAC';
  return codec.split('.')[0].toUpperCase().slice(0, 18);
}

const renderedCandidates = new WeakMap<HTMLElement, string>();
export function renderCandidates(container: HTMLElement, candidates: MediaCandidate[], selected: string): void {
  const signature = JSON.stringify(candidates);
  if (renderedCandidates.get(container) === signature && container.childElementCount === candidates.length) {
    for (const radio of container.querySelectorAll<HTMLInputElement>('input[name=source]')) radio.checked = radio.value === selected;
    return;
  }
  const doc = container.ownerDocument;
  const active = doc.activeElement;
  const focusedValue = active && container.contains(active) && active.tagName === 'INPUT' ? (active as HTMLInputElement).value : undefined;
  container.replaceChildren();
  renderedCandidates.set(container, signature);
  for (const candidate of candidates) {
    const label = doc.createElement('label'); label.className = 'source-row';
    const input = doc.createElement('input'); input.type = 'radio'; input.name = 'source'; input.value = candidate.id; input.checked = candidate.id === selected;
    const content = doc.createElement('span'); content.className = 'source-content';
    const title = doc.createElement('strong'); title.className = 'source-title'; title.textContent = candidate.quality || candidate.title || '当前视频'; title.title = candidate.title;
    const meta = doc.createElement('span'); meta.className = 'source-meta';
    if (candidate.video) {
      meta.textContent = `Bilibili · ${candidate.audio ? '音视频分离' : '缺少音轨'} · ${codecName(candidate.video.codecs)}${candidate.audio ? ' / ' + codecName(candidate.audio.codecs) : ''}`;
      if (!candidate.audio) label.dataset.missingAudio = 'true';
    } else meta.textContent = `${candidate.live ? '直播 · ' : ''}${candidate.source === 'bilibili' ? 'Bilibili' : candidate.source === 'cycani' ? '网页播放源' : '检测到的媒体'} · ${describeUrl(candidate.url)}`;
    const badge = doc.createElement('span'); badge.className = 'format-badge'; badge.textContent = candidate.format === 'unknown' ? '待检查' : candidate.format.toUpperCase();
    content.append(title, meta); label.append(input, content, badge); container.append(label);
  }
  if (focusedValue) Array.from(container.querySelectorAll<HTMLInputElement>('input[name=source]')).find(input => input.value === focusedValue)?.focus();
}
