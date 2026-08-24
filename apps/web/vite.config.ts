import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverPort = Number.parseInt(process.env.PORT ?? '3016', 10);
const serverTarget = `http://localhost:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true },
      '/agent': { target: serverTarget, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // three is large and changes rarely; keeping it separate keeps app rebuilds cheap.
          three: ['three'],
        },
      },
    },
  },
});
