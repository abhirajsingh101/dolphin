import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/* The Dolphin Desktop renderer: the glass workspace and System Health only,
   built with relative paths so Electron can serve it from its own app://
   origin. The web app's build (vite.config.ts) is untouched. */
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: 'dist-desktop',
    emptyOutDir: true,
    rollupOptions: { input: 'desktop.html' },
  },
});
