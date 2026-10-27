import './styles.css';
import { element, errorMessage, isExtension, rpc } from './api.ts';
import type { HostConfig } from '../shared/types.ts';

const input = (id: string) => element<HTMLInputElement>(id);
function feedback(message: string, success = false) { const box = element('settings-feedback'); box.textContent = message; box.hidden = false; box.classList.toggle('success', success); }
function proxyVisibility() { element('proxy-url-wrap').hidden = element<HTMLSelectElement>('proxy-mode').value !== 'manual'; }
async function check() {
  element('host-status').textContent = '正在检查本机组件…';
  element('settings-feedback').hidden = true;
  try {
    const result = await rpc('hello'); const config = result.config as HostConfig;
    input('player-path').value = config.playerPath; input('proxy-url').value = config.proxyUrl;
    input('ffprobe-path').value = config.ffprobePath; element<HTMLSelectElement>('proxy-mode').value = config.proxyMode;
    element('host-status').textContent = `已连接 · 本机组件 ${result.version}`; proxyVisibility();
    if (result.configWarning) feedback('已有配置无法读取，请检查并重新保存。');
  } catch (error) { element('host-status').textContent = '尚未连接 · 请先安装本机组件'; feedback(errorMessage(error)); }
}
element('proxy-mode').addEventListener('change', proxyVisibility);
element('reconnect').addEventListener('click', () => void check());
element('copy-id').addEventListener('click', async () => { if (isExtension) { try { await navigator.clipboard.writeText(chrome.runtime.id); feedback('扩展 ID 已复制。', true); } catch { feedback('请手动选中并复制上方扩展 ID。'); } } });
element('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); const save = element<HTMLButtonElement>('save'); save.disabled = true;
  const config: HostConfig = { playerPath: input('player-path').value.trim().replace(/^"|"$/g, ''), proxyMode: element<HTMLSelectElement>('proxy-mode').value as HostConfig['proxyMode'], proxyUrl: input('proxy-url').value.trim(), ffprobePath: input('ffprobe-path').value.trim().replace(/^"|"$/g, '') };
  try { await rpc('saveConfig', { config }); feedback('设置已保存。回到视频网页，开始播放后打开插件。', true); }
  catch (error) { feedback(errorMessage(error)); }
  finally { save.disabled = false; }
});
element('stop-all').addEventListener('click', async () => { try { await rpc('stopAll'); feedback('全部中转已结束。', true); } catch (error) { feedback(errorMessage(error)); } });
element('export').addEventListener('click', async () => {
  try {
    const report = await rpc('diagnostics'); const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...report }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `potbridge-diagnostics-${Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    feedback('已导出脱敏诊断，不包含登录凭据和完整媒体链接。', true);
  } catch (error) { feedback(errorMessage(error)); }
});
if (isExtension) { element('extension-id').textContent = chrome.runtime.id; void check(); }
else { element('preview-note').hidden = false; element('host-status').textContent = '界面预览 · 实际连接状态将在扩展中显示'; }
