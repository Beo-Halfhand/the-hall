// Builds the cage's contract code to dist/cage.js, served at /wallet-app/cage.js. Nothing is inlined, so the page's
// CSP needs only 'self' and 'wasm-unsafe-eval'.
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { existsSync } from 'node:fs';

// dice-proof's bundle is only built when its contract is there: see scripts/copy-contract.mjs.
const dice = existsSync(new URL('./src/generated-dice/index.js', import.meta.url)) ? { 'dice-proof': 'src/dice-proof.js' } : {};

export default defineConfig({
  base: '/wallet-app/',
  publicDir: false,
  plugins: [wasm()],
  resolve: { alias: { assert: new URL('./src/shims/assert.js', import.meta.url).pathname } },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    minify: true,
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      input: { cage: 'src/cage.js', ...dice },
      preserveEntrySignatures: 'strict',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
