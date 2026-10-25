import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const expectedId = process.argv[2];
if (!/^[a-p]{32}$/.test(expectedId ?? '')) throw new Error('Provide the actual Edge extension ID.');
const nativeDirectory = join(process.env.LOCALAPPDATA, 'PotBridge', 'native');
const manifest = JSON.parse(readFileSync(join(nativeDirectory, 'com.potbridge.host.json'), 'utf8'));
const executable = join(nativeDirectory, 'potbridge.exe');
if (manifest.name !== 'com.potbridge.host' || resolve(manifest.path) !== resolve(executable) || JSON.stringify(manifest.allowed_origins) !== JSON.stringify([`chrome-extension://${expectedId}/`])) throw new Error('Installed manifest does not match expected host/extension.');
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
if (digest(executable) !== digest(resolve('native/bin/potbridge.exe'))) throw new Error('Installed host differs from the current build.');
function request(type, payload = {}) {
const message = Buffer.from(JSON.stringify({ protocolVersion: 1, requestId: 'installation-check', type, ...payload }));
const length = Buffer.alloc(4); length.writeUInt32LE(message.length);
const result = spawnSync(executable, [], { input: Buffer.concat([length, message]), timeout: 15000, windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0 || result.stdout.length < 4) throw new Error('Installed host did not return a protocol frame.');
const size = result.stdout.readUInt32LE(0);
if (size > 1024*1024 || result.stdout.length < size + 4) throw new Error('Invalid response frame.');
const response = JSON.parse(result.stdout.subarray(4, size+4).toString('utf8'));
if (!response.ok || response.requestId !== 'installation-check') throw new Error('Host hello failed.');
return response.result;
}
let hello = request('hello');
if (process.argv[3]) {
  request('configure', { config: { ...hello.config, playerPath: process.argv[3] } });
  hello = request('hello');
}
console.log(JSON.stringify({ manifestVerified: true, buildHashVerified: true, hello: 'ok', version: hello.version, playerPath: hello.config.playerPath, proxyMode: hello.config.proxyMode, configWarning: hello.configWarning }, null, 2));
