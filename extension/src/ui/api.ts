export const isExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
export async function rpc(type: string, payload: object = {}): Promise<any> {
  if (!isExtension) throw { code: 'PREVIEW', message: '这是界面预览，请从 Edge 扩展中使用实际功能。' };
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw response?.error ?? { code: 'BACKGROUND_ERROR', message: '插件后台未响应，请重新打开插件。' };
  return response.result;
}
export const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
export function errorMessage(error: unknown): string { return typeof error === 'object' && error && 'message' in error ? String(error.message) : '操作未完成，请重试。'; }
