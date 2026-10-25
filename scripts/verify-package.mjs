import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const directory = resolve(`release/PotBridge-${version}-windows-x64`);
const checksums = (await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
for (const line of checksums) {
  const [expected, file] = line.split('  ');
  assert.match(file, /^(extension\/|host\/|scripts\/|docs\/|README\.md$|ACCEPTANCE\.md$|CHANGELOG\.md$)/);
  assert.equal(createHash('sha256').update(await readFile(join(directory, file))).digest('hex'), expected, file);
}
const manifest = JSON.parse(await readFile(join(directory, 'extension/manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3); assert.equal(manifest.version, version);
for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, 'page.js', ...manifest.content_scripts.flatMap(s => s.js)]) {
  assert.ok((await stat(join(directory, 'extension', file))).size > 0, file);
}
for (const html of ['popup.html', 'options.html']) {
  const body = await readFile(join(directory, 'extension', html), 'utf8');
  for (const [, asset] of body.matchAll(/(?:src|href)="(\.\/assets\/[^"?]+)"/g)) {
    assert.ok((await stat(join(directory, 'extension', asset))).size > 0, asset);
  }
}
const executable = await readFile(join(directory, 'host/potbridge.exe'));
assert.equal(executable.toString('ascii', 0, 2), 'MZ');
assert.deepEqual(executable, await readFile('native/bin/potbridge.exe'));
const zipExpected = (await readFile(directory + '.zip.sha256', 'utf8')).split('  ')[0];
assert.equal(createHash('sha256').update(await readFile(directory + '.zip')).digest('hex'), zipExpected);
console.log(`Verified ${checksums.length} packaged files, manifest entrypoints, UI assets, native executable and ZIP checksum.`);
