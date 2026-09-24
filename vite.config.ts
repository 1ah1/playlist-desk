import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Three entries: two content scripts (must be self-contained, no imports at runtime)
// and the panel page. manifest.json lives in public/ and is copied as-is.
export default defineConfig({
  root: 'src',
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    modulePreload: false,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        'content/bridge': resolve(__dirname, 'src/content/bridge.ts'),
        'content/inject': resolve(__dirname, 'src/content/inject.ts'),
        'panel/index': resolve(__dirname, 'src/panel/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // Content scripts cannot import chunks; keep every entry self-contained.
        manualChunks: () => undefined,
      },
    },
  },
});
