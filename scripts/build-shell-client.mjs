/**
 * Build the desktop-shell client bundle into `src/desktop-shell/lib/client.js`
 * as a CommonJS factory that the harness's `__ModuleLoader__` can register.
 *
 * Output shape (loaded by `apps/web`):
 *   window.__ModuleLoader__.load({
 *     id: '@dsh-desktop/shell',
 *     factory: (require) => {
 *       ...module body, returns { apply, inject }
 *       return module.exports;
 *     },
 *   });
 *
 * React is external (the harness seeds it into the module table); everything
 * else is bundled. The same package's `dsh.client` declaration in
 * package.json tells the harness's client-modules to serve this bundle.
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolvePath(ROOT, '..', 'src', 'desktop-shell')
const ENTRY = resolvePath(PKG_DIR, 'src', 'client', 'index.ts')
const OUTFILE = resolvePath(PKG_DIR, 'lib', 'client.js')

const PLUGIN_ID = '@dsh-desktop/shell'

await build({
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  sourcemap: true,
  // The harness satisfies these via the frozen module table; the bundle must
  // call `require()` for each instead of inlining its own copy.
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    '@deepseek-ai/cordis',
  ],
  banner: {
    js: [
      'var module = { exports: {} };',
      'var exports = module.exports;',
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    ].join('\n'),
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

console.log(`build-shell-client: wrote ${OUTFILE}`)