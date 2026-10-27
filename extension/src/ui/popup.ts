import './styles.css';
import { element, errorMessage, isExtension, rpc } from './api.ts';
import { renderCandidates, statusView } from './view.ts';
import type { TabState } from '../shared/types.ts';

let tabId = -1, selected = '', busy = false, connected = false, actionNotice = '';
let state: TabState = { pageUrl: '', enabled: false, candidates: [], status: 'unidentified' };
const play = element<HTMLButtonElement>('play'), probe = element<HTMLButtonElement>('probe'), refresh = element<HTMLButtonElement>('refresh');
function render() {
  if (!state.candidates.some(c => c.id === selected)) selected = state.candidates[0]?.id ?? '';
  const view = statusView(state, busy, connected, selected);
  renderCandidates(element('sources'), state.candidates, selected);
  element('empty').hidden = !!state.candidates.length;
  element('source-count').textContent = `${state.candidates.length} 个`;
  element('status-label').textContent = view.label; element('status-detail').textContent = view.detail;
  element('feedback').dataset.tone = view.tone;
  play.disabled = !view.canPlay; play.querySelector('span')!.textContent = busy ? '正在检查…' : '用 PotPlayer 播放';
  probe.disabled = !view.canInspect; refresh.disabled = busy || !state.candidates.some(c => c.id === selected && c.source === 'cycani');
  element<HTMLButtonElement>('detect').disabled = busy;
  element<HTMLInputElement>('site-enabled').checked = state.enabled;
  element<HTMLInputElement>('site-enabled').disabled = busy || !isExtension;
  element('stop').hidden = !state.sessionId;
  const notice = actionNotice || state.error?.message || (!connected && isExtension ? '本机组件尚未连接。打开设置，完成一次安装后再播放。' : '');
  element('notice').textContent = notice; element('notice').hidden = !notice;
}
async function loadState() { if (tabId < 0) return; state = await rpc('getState', { tabId }); render(); }
async function action(type: string) {
  busy = true; actionNotice = ''; render();
  try {
    const result = await rpc(type, { tabId, candidateId: selected });
    if (type === 'probe') actionNotice = `媒体检查通过：${String(result.probe.format).toUpperCase()}，已检查 ${result.probe.checks.length} 项资源。仍需在 PotPlayer 确认画面与声音。`;
    if (type === 'refresh') actionNotice = '已重新取得地址，可以再次发送到 PotPlayer。';
    await loadState();
  } catch (error) { actionNotice = errorMessage(error); }
  finally { busy = false; render(); }
}
element('sources').addEventListener('change', event => { if (event.target instanceof HTMLInputElement) { selected = event.target.value; render(); } });
play.addEventListener('click', () => void action('play')); probe.addEventListener('click', () => void action('probe')); refresh.addEventListener('click', () => void action('refresh'));
element('detect').addEventListener('click', () => void action('detect')); element('stop').addEventListener('click', () => void action('stop'));
element('settings').addEventListener('click', () => { if (isExtension) void chrome.runtime.openOptionsPage(); else location.href = 'options.html'; });
element<HTMLInputElement>('site-enabled').addEventListener('change', async event => {
  try { state = await rpc('enableSite', { tabId, enabled: (event.target as HTMLInputElement).checked }); actionNotice = state.enabled ? '已启用。若未找到媒体，请刷新网页并开始播放。' : ''; }
  catch (error) { actionNotice = errorMessage(error); } render();
});
async function init() {
  if (!isExtension) { element('connection').textContent = '界面预览'; actionNotice = '这是界面预览。加载 Edge 扩展后，此处会显示当前网页实际发现的媒体。'; render(); return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab?.id ?? -1;
  if (tab?.title) element('page-title').textContent = tab.title;
  try { element('site-host').textContent = new URL(tab?.url ?? '').hostname; } catch {}
  try { await loadState(); } catch (error) { actionNotice = errorMessage(error); }
  try { await rpc('hello'); connected = true; element('connection').innerHTML = '<i aria-hidden="true"></i>本机已连接'; element('connection').classList.add('is-connected'); }
  catch (error) { element('connection').innerHTML = '<i aria-hidden="true"></i>本机未连接'; actionNotice = errorMessage(error); }
  render();
  setInterval(() => { if (!busy) void loadState().catch(() => {}); }, 1500);
}
void init().catch(error => { actionNotice = errorMessage(error); render(); });
