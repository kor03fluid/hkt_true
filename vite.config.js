import { defineConfig } from 'vite';

export default defineConfig({
  // three.js + MediaPipe make one big bundle; that is expected
  build: { chunkSizeWarningLimit: 1500 },
});
