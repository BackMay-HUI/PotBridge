import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeClient } from '../extension/src/shared/native-client.ts';

function portFixture() {
  const messages: any[] = [], receives: Array<(m: any) => void> = [], disconnects: Array<() => void> = [];
  const port = { postMessage: (m: any) => messages.push(m), disconnect() { disconnects.forEach(f => f()); }, onMessage: { addListener: (f: any) => receives.push(f) }, onDisconnect: { addListener: (f: any) => disconnects.push(f) } };
  return { port, messages, respond: (m: any) => receives.forEach(f => f(m)) };
}
test('correlates native responses and rejects pending requests on disconnect', async () => {
  const f = portFixture(), client = new NativeClient(() => f.port, () => {}, () => 'host unavailable', 1000);
  const first = client.request('hello');
  f.respond({ protocolVersion: 1, requestId: f.messages[0].requestId, ok: true, result: { version: '0.1.0' } });
  assert.equal((await first).version, '0.1.0');
  const second = client.request('probe', {});
  f.port.disconnect();
  await assert.rejects(second, (e: any) => e.code === 'NATIVE_DISCONNECTED');
  client.close();
});
test('does not mistake unsolicited session events for successful requests', async () => {
  const f = portFixture(), events: any[] = [], client = new NativeClient(() => f.port, e => events.push(e), () => '', 15);
  const pending = client.request('play');
  f.respond({ protocolVersion: 1, type: 'mediaRequested', sessionId: 's' });
  await assert.rejects(pending, (e: any) => e.code === 'NATIVE_TIMEOUT');
  assert.equal(events.length, 1); client.close();
});

test('browser native connection errors identify the failed boundary', async () => {
  for (const [detail, code] of [
    ['Specified native messaging host not found.', 'NATIVE_HOST_NOT_FOUND'],
    ['Access to the specified native messaging host is forbidden.', 'NATIVE_HOST_FORBIDDEN'],
    ['Failed to start native messaging host.', 'NATIVE_LAUNCH_FAILED'],
    ['Native host has exited.', 'NATIVE_HOST_EXITED'],
    ['Error when communicating with the native messaging host.', 'NATIVE_PROTOCOL_ERROR'],
  ]) {
    const fixture = portFixture(), client = new NativeClient(() => fixture.port, () => {}, () => detail, 1000);
    const pending = client.request('hello'); fixture.port.disconnect();
    await assert.rejects(pending, (error: any) => error.code === code && error.message.includes(code));
    client.close();
  }
});
