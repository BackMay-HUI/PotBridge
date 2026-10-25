import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve('extension'), base: './',
  build: { outDir: resolve('dist/extension'), emptyOutDir: false, rolldownOptions: { input: { popup: resolve('extension/popup.html'), options: resolve('extension/options.html') } } },
});
