import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
const name = `PotBridge-${version}-windows-x64`;
const destination = join(root, 'release', name);
// Replace only this version's output after verifying its canonical parent/name.
const { rm } = await import('node:fs/promises');
if (relative(join(root, 'release'), destination) !== name) throw new Error('Unsafe release path');
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, 'host'), { recursive: true });
await mkdir(join(destination, 'scripts'), { recursive: true });
await cp(join(root, 'dist/extension'), join(destination, 'extension'), { recursive: true });
await cp(join(root, 'native/bin/potbridge.exe'), join(destination, 'host/potbridge.exe'));
for (const file of ['install-host.ps1', 'uninstall-host.ps1']) await cp(join(root, 'scripts', file), join(destination, 'scripts', file));
await cp(join(root, 'README.md'), join(destination, 'README.md'));
await cp(join(root, 'docs/acceptance.md'), join(destination, 'ACCEPTANCE.md'));
await mkdir(join(destination, 'docs'), { recursive: true });
for (const file of ['acceptance.md', 'release-check.md', 'review-v01.md', 'review-v02.md', 'review-v03.md', 'credits.md', 'protocol.md']) await cp(join(root, 'docs', file), join(destination, 'docs', file));
await cp(join(root, 'CHANGELOG.md'), join(destination, 'CHANGELOG.md'));
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(join(directory, e.name)) : [join(directory, e.name)]))).flat();
}
const hashes = [];
for (const file of (await files(destination)).sort()) {
  hashes.push(`${createHash('sha256').update(await readFile(file)).digest('hex')}  ${relative(destination, file).replaceAll('\\', '/')}`);
}
await writeFile(join(destination, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
// Paths are passed through environment variables, never interpolated into shell source.
const zip = destination + '.zip';
const zipped = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:POTBRIDGE_PACKAGE_SOURCE -DestinationPath $env:POTBRIDGE_PACKAGE_ZIP -Force'], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env, POTBRIDGE_PACKAGE_SOURCE: destination, POTBRIDGE_PACKAGE_ZIP: zip },
});
if (zipped.error) throw zipped.error;
if (zipped.status !== 0) throw new Error(`ZIP packaging failed: ${zipped.status}`);
await writeFile(zip + '.sha256', `${createHash('sha256').update(await readFile(zip)).digest('hex')}  ${name}.zip\n`);
console.log(`Packaged ${zip}`);
