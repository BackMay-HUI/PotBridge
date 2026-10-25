import { installCycaniAdapter } from './shared/page-adapter.ts';
const marker = Symbol.for('potbridge.page.v1');
const root = window as unknown as Record<symbol, boolean>;
if (!root[marker]) { root[marker] = true; installCycaniAdapter(window); }
