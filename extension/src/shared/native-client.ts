import type { HostEvent, HostResponse } from './types.ts';

export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: any) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}
interface Pending { resolve(value: any): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; type: string; payload: Record<string, unknown> }

function disconnectFault(detail?: string) {
  const known: Array<[RegExp, string, string]> = [
    [/host not found/i, 'NATIVE_HOST_NOT_FOUND', 'Edge 找不到本机组件注册。请核对当前 Windows 用户和注册路径。'],
    [/access .*forbidden/i, 'NATIVE_HOST_FORBIDDEN', 'Edge 拒绝访问本机组件。请核对设置页的扩展 ID 与安装绑定的 ID，以及浏览器策略。'],
    [/failed to start/i, 'NATIVE_LAUNCH_FAILED', 'Edge 未能启动本机组件。请检查程序路径、文件权限或系统拦截提示。'],
    [/host has exited/i, 'NATIVE_HOST_EXITED', '本机组件启动后退出。需要检查组件运行环境和启动参数。'],
    [/communicating with.*host/i, 'NATIVE_PROTOCOL_ERROR', 'Edge 与本机组件通信失败。需要检查原生消息格式和进程输出。'],
  ];
  for (const [pattern, code, message] of known) if (pattern.test(detail ?? '')) return { code, message: `${message} [${code}]` };
  return { code: 'NATIVE_DISCONNECTED', message: detail ? '本机连接失败，浏览器未返回已识别的错误类型。请查看扩展后台错误。 [NATIVE_DISCONNECTED]' : '本机连接已断开，请重新检查。' };
}

export class NativeClient {
  private port?: NativePort;
  private pending = new Map<string, Pending>();
  private sessions = new Set<string>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private connect: () => NativePort;
  private event: (event: HostEvent) => void;
  private lastError: () => string | undefined;
  private timeout: number;
  constructor(connect: () => NativePort, event: (event: HostEvent) => void, lastError: () => string | undefined, timeout = 90000) {
    this.connect = connect; this.event = event; this.lastError = lastError; this.timeout = timeout;
  }
  get connected(): boolean { return !!this.port; }
  private ensurePort(): NativePort {
    if (this.port) return this.port;
    const port = this.connect(); this.port = port;
    port.onMessage.addListener((message: HostResponse & HostEvent) => {
      if (message?.protocolVersion !== 2) {
        const pending = message?.requestId && this.pending.get(message.requestId);
        if (pending) {
          this.pending.delete(message.requestId); clearTimeout(pending.timer);
          pending.reject({ code: 'VERSION_MISMATCH', message: '扩展与本机组件版本不一致，请更新并重新安装 v0.2 本机组件。' });
          this.scheduleIdle();
        }
        return;
      }
      if (typeof message.requestId === 'string' && this.pending.has(message.requestId)) {
        const pending = this.pending.get(message.requestId)!; this.pending.delete(message.requestId); clearTimeout(pending.timer);
        if (message.ok) {
          if (message.result?.session?.id) this.sessions.add(message.result.session.id);
          if (pending.type === 'stop') { if (pending.payload.sessionId) this.sessions.delete(String(pending.payload.sessionId)); else this.sessions.clear(); }
          pending.resolve(message.result);
        } else pending.reject(message.error ?? { code: 'NATIVE_ERROR', message: '本机组件返回了未知错误。' });
        this.scheduleIdle();
      } else if (typeof message.type === 'string') {
        if (message.type === 'sessionEnded' && message.sessionId) this.sessions.delete(message.sessionId);
        this.event(message); this.scheduleIdle();
      }
    });
    port.onDisconnect.addListener(() => {
      const detail = this.lastError();
      if (this.port !== port) return;
      this.port = undefined; this.sessions.clear();
      const error = disconnectFault(detail);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear(); this.event({ protocolVersion: 2, type: 'disconnected', error });
    });
    return port;
  }
  request(type: string, payload: Record<string, unknown> = {}): Promise<any> {
    clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      let port: NativePort;
      try { port = this.ensurePort(); } catch { reject({ code: 'NATIVE_DISCONNECTED', message: '无法连接本机组件，请先完成安装。' }); return; }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject({ code: 'NATIVE_TIMEOUT', message: '本机操作超时，请检查网络设置后重试。' }); this.scheduleIdle(); }, this.timeout);
      this.pending.set(requestId, { resolve, reject, timer, type, payload });
      try { port.postMessage({ protocolVersion: 2, requestId, type, ...payload }); }
      catch { clearTimeout(timer); this.pending.delete(requestId); reject({ code: 'NATIVE_DISCONNECTED', message: '无法向本机组件发送请求。' }); this.close(); }
    });
  }
  private scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (!this.pending.size && !this.sessions.size) this.idleTimer = setTimeout(() => this.close(), 15000);
  }
  close(): void {
    clearTimeout(this.idleTimer); const port = this.port;
    if (port) port.disconnect();
    this.port = undefined;
  }
}
