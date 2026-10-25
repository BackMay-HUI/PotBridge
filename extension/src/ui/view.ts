import type { TabState, MediaCandidate } from '../shared/types.ts';
import { describeUrl } from '../shared/media.ts';

export function statusView(state: TabState, busy: boolean, connected: boolean) {
  const labels: Record<string, [string, string]> = {
    unidentified: ['等待发现媒体', '先在网页开始播放，再点击重新检测。'],
    detected: ['媒体已就绪', '发送前会检查地址、清单与首个媒体分片。'],
    checking: ['正在检查媒体', '正在检查连接与媒体数据，请稍候。'],
    sent: ['已发送到 PotPlayer', '已启动播放器，正在等待它请求媒体。'],
    requested: ['播放器已请求媒体', '请在 PotPlayer 中确认画面和声音是否正常。'],
    error: ['需要处理', state.error?.message ?? '请重新检测或查看诊断。'],
  };
  const [label, detail] = busy ? labels.checking : labels[state.status] ?? labels.unidentified;
  return { label, detail, tone: state.error ? 'warning' : state.candidates.length ? 'ready' : 'quiet', canPlay: !busy && state.status !== 'checking' && connected && state.enabled && state.candidates.length > 0 };
}

export function renderCandidates(container: HTMLElement, candidates: MediaCandidate[], selected: string): void {
  container.replaceChildren();
  const doc = container.ownerDocument;
  for (const candidate of candidates) {
    const label = doc.createElement('label'); label.className = 'source-row';
    const input = doc.createElement('input'); input.type = 'radio'; input.name = 'source'; input.value = candidate.id; input.checked = candidate.id === selected;
    const content = doc.createElement('span'); content.className = 'source-content';
    const title = doc.createElement('strong'); title.textContent = candidate.title || '当前视频'; title.title = candidate.title;
    const meta = doc.createElement('span'); meta.className = 'source-meta'; meta.textContent = `${candidate.source === 'cycani' ? '网页播放源' : '检测到的媒体'} · ${describeUrl(candidate.url)}`;
    const badge = doc.createElement('span'); badge.className = 'format-badge'; badge.textContent = candidate.format === 'unknown' ? '待检查' : candidate.format.toUpperCase();
    content.append(title, meta); label.append(input, content, badge); container.append(label);
  }
}
