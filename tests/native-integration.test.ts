import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

test('actual Windows host speaks framed JSON, rejects versions and private media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'potbridge-test-'));
  const child = spawn(resolve('native/bin/potbridge.exe'), ['--config', join(directory, 'config.json')], { windowsHide: true });
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let data = Buffer.alloc(0);
  child.on('error', error => { for (const p of pending.values()) p.reject(error); });
  child.stdout.on('data', chunk => {
    data = Buffer.concat([data, chunk]);
    while (data.length >= 4 && data.length >= 4 + data.readUInt32LE(0)) {
      const size = data.readUInt32LE(0), response = JSON.parse(data.subarray(4, 4 + size).toString());
      data = data.subarray(4 + size); pending.get(response.requestId)?.resolve(response); pending.delete(response.requestId);
    }
  });
  const request = (id: string, type: string, extra: object = {}, version = 1): Promise<any> => new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const body = Buffer.from(JSON.stringify({ protocolVersion: version, requestId: id, type, ...extra }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length); child.stdin.write(Buffer.concat([header, body]));
  });
  try {
    const hello = await request('hello', 'hello');
    assert.equal(hello.ok, true); assert.equal(hello.result.version, '0.1.0');
    const wrong = await request('wrong', 'hello', {}, 99);
    assert.equal(wrong.error.code, 'VERSION_MISMATCH');
    const invalid = await request('private', 'probe', { candidate: { url: 'http://127.0.0.1:1/private.mp4' } });
    assert.equal(invalid.error.code, 'BLOCKED_ADDRESS');
    const unknown = await request('unknown', 'runShell', { command: 'echo bad' });
    assert.equal(unknown.error.code, 'UNKNOWN_COMMAND');
  } finally {
    child.stdin.end(); child.kill();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('potbridge-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
