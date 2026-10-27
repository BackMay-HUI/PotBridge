import { installCycaniAdapter } from './shared/page-adapter.ts';
import { installBilibiliAdapter } from './shared/bilibili-adapter.ts';
const marker = Symbol.for('potbridge.page.v2');
const root = window as unknown as Record<symbol, boolean>;
if (!root[marker]) { root[marker] = true; installCycaniAdapter(window); installBilibiliAdapter(window); }
