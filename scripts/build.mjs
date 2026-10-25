import { build } from 'vite';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve('.'), out = resolve('dist/extension');
function run(executable, args, options = {}) { const r = spawnSync(executable, args, { stdio: 'inherit', cwd: root, ...options }); if (r.error) throw r.error; if (r.status !== 0) throw new Error(`${executable} exited ${r.status}`); }
run(process.execPath, [resolve('node_modules/typescript/lib/tsc.js'), '--noEmit']);
if (relative(root, out) !== join('dist', 'extension')) throw new Error('Unsafe build output path');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build();
for (const [entry, format] of [['background', 'es'], ['content', 'iife'], ['page', 'iife']]) {
  await build({ configFile: false, root, build: { outDir: out, emptyOutDir: false, lib: { entry: resolve(`extension/src/${entry}.ts`), name: `PotBridge_${entry}`, formats: [format], fileName: () => `${entry}.js` }, rolldownOptions: { output: { codeSplitting: false } } } });
}
await copyFile(resolve('extension/manifest.json'), resolve(out, 'manifest.json'));
const localGo = resolve('.tools/go/bin/go.exe'), go = existsSync(localGo) ? localGo : 'go';
run(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', 'bin/potbridge.exe', './cmd/potbridge'], { cwd: resolve('native'), env: { ...process.env, GOCACHE: resolve('.cache/go-build'), GOPATH: resolve('.cache/go') } });
console.log('Built extension and Windows native host.');
