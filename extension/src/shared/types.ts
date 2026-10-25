export type MediaFormat = 'hls' | 'mp4' | 'dash' | 'unknown';
export type HeaderContext = Record<string, Record<string, string>>;
export interface MediaCandidate {
  id: string;
  tabId: number;
  frameId: number;
  pageKey: string;
  pageUrl: string;
  title: string;
  source: 'cycani' | 'network' | 'dom';
  sectionId?: string;
  url: string;
  format: MediaFormat;
  capturedAt: number;
  headersByOrigin: HeaderContext;
}
export interface HostConfig {
  playerPath: string;
  proxyMode: 'system' | 'direct' | 'manual';
  proxyUrl: string;
  ffprobePath: string;
}
export interface Fault { code: string; message: string; stage?: string; status?: number }
export interface HostResponse { protocolVersion: 1; requestId: string; ok: boolean; result?: any; error?: Fault }
export interface HostEvent { protocolVersion: 1; type: string; sessionId?: string; error?: Fault; [key: string]: unknown }
export interface ExtensionSettings { enabledOrigins: string[] }
export interface TabState {
  pageUrl: string;
  enabled: boolean;
  candidates: MediaCandidate[];
  status: string;
  error?: Fault;
  sessionId?: string;
}
export const NATIVE_HOST = 'com.potbridge.host';
export const DEFAULT_SETTINGS: ExtensionSettings = { enabledOrigins: ['https://www.cycani.org'] };
