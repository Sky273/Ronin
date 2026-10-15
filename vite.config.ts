import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, strictPort: true, host: true },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
