import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const watch = process.argv.includes('--watch');

// OAuth config — baked in at build time if env vars are set, otherwise empty
// (app falls back to PAT-only mode when these are absent).
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? '';
const OAUTH_PROXY_URL = process.env.OAUTH_PROXY_URL ?? '';

const ctx = await esbuild.context({
  entryPoints: ['app.ts'],
  bundle: true,
  outfile: 'dist/app.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  define: {
    '__OAUTH_CLIENT_ID__': JSON.stringify(OAUTH_CLIENT_ID),
    '__OAUTH_PROXY_URL__': JSON.stringify(OAUTH_PROXY_URL),
  },
  external: ['mermaid'],
});

// Copy mermaid.min.js from node_modules into dist/ so we don't depend on a CDN.
fs.mkdirSync('dist', { recursive: true });
const mermaidSrc = require.resolve('mermaid/dist/mermaid.min.js');
fs.copyFileSync(mermaidSrc, path.join('dist', 'mermaid.min.js'));

if (watch) {
  await ctx.watch();
  console.log('Watching for changes…');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('Build complete.');
}
