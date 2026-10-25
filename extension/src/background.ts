import { BridgeController, asFault } from './shared/controller.ts';
import { NativeClient } from './shared/native-client.ts';
import { DEFAULT_SETTINGS, NATIVE_HOST } from './shared/types.ts';
import type { ExtensionSettings } from './shared/types.ts';

const native = new NativeClient(() => chrome.runtime.connectNative(NATIVE_HOST), event => { void controller.onNativeEvent(event); }, () => chrome.runtime.lastError?.message);
const controller = new BridgeController({
  extensionBase: chrome.runtime.getURL(''), getTab: id => chrome.tabs.get(id),
  sendToTab: (id, message, frameId) => chrome.tabs.sendMessage(id, message, frameId === undefined ? {} : { frameId }),
  native: (type, payload) => native.request(type, payload),
  saveSettings: async settings => { await chrome.storage.local.set({ settings }); await registerAdapter(settings); },
});
async function registerAdapter(settings: ExtensionSettings) {
  const matches = settings.enabledOrigins.filter(origin => { try { return ['www.cycani.org', 'cycani.org'].includes(new URL(origin).hostname); } catch { return false; } }).map(origin => origin + '/*');
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: ['potbridge-page'] });
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: ['potbridge-page'] });
  if (matches.length) await chrome.scripting.registerContentScripts([{ id: 'potbridge-page', matches, js: ['page.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true }]);
}
const ready = chrome.storage.local.get('settings').then(async result => {
  const settings = result.settings as ExtensionSettings | undefined;
  controller.settings = settings?.enabledOrigins && Array.isArray(settings.enabledOrigins) ? { enabledOrigins: settings.enabledOrigins.filter(x => typeof x === 'string').slice(0, 64) } : structuredClone(DEFAULT_SETTINGS);
  await registerAdapter(controller.settings);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  void ready.then(() => controller.handle(message, sender)).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: asFault(error) }));
  return true;
});
chrome.tabs.onUpdated.addListener((id, info, tab) => { if (info.url) controller.invalidate(id, info.url, tab.title); });
chrome.tabs.onRemoved.addListener(id => controller.remove(id));

const requests = new Map<string, { tabId: number; frameId: number; pageKey: string; headers: Record<string, string> }>();
chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  const pageKey = controller.pageKey(details.tabId); if (!pageKey || !controller.captures(details.tabId)) return;
  if (requests.size >= 512) requests.delete(requests.keys().next().value!);
  const headers: Record<string, string> = {};
  for (const h of details.requestHeaders ?? []) if (h.value && ['referer', 'origin', 'cookie', 'user-agent'].includes(h.name.toLowerCase())) headers[h.name] = h.value;
  requests.set(details.requestId, { tabId: details.tabId, frameId: details.frameId, pageKey, headers });
}, { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other'] }, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onHeadersReceived.addListener(details => {
  const request = requests.get(details.requestId); if (!request || details.statusCode < 200 || details.statusCode >= 300) return;
  const mime = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value ?? '';
  controller.observeNetwork(request.tabId, request.frameId, request.pageKey, details.url, mime, request.headers);
}, { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other'] }, ['responseHeaders']);
for (const event of [chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred]) event.addListener(details => requests.delete(details.requestId), { urls: ['http://*/*', 'https://*/*'] });
