import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// npm run build        -> dist/ : static site (index.html + assets), host it anywhere (GitHub Pages, any web server)
// npm run build:single -> release/HoloHand-STL.html : one file with code and models inside, opens by double-click
// SQUAD_URL=http://<control-server>:8080 npm run dev -> the AI 정비 mode follows SQUAD LINK live through
// /squad/api/* (read-only GETs; same job as tools/squad_bridge.mjs for the single file)
const squad = process.env.SQUAD_URL
  ? {
      '/squad/api': {
        target: process.env.SQUAD_URL,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/squad/, ''),
        // read-only: anything but GET config / state / stream gets a 404 instead of reaching the server
        bypass: (req) => (req.method === 'GET' && /^\/squad\/api\/(config|state|stream)(\?|$)/.test(req.url) ? undefined : false),
      },
    }
  : undefined;

export default defineConfig(({ mode }) => ({
  base: './', // relative URLs, so the build works from a sub-path or straight from disk
  // three.js + MediaPipe make one big bundle; that is expected
  build:
    mode === 'single'
      ? { outDir: 'release/.tmp', emptyOutDir: true, chunkSizeWarningLimit: 20000, reportCompressedSize: false }
      : { chunkSizeWarningLimit: 1500 },
  // the single file cannot carry the MediaPipe WASM (30 MB); it loads it from the CDN instead
  publicDir: mode === 'single' ? false : 'public',
  plugins: mode === 'single' ? [viteSingleFile({ removeViteModuleLoader: true })] : [],
  server: { watch: { ignored: ['**/Turret/**', '**/hailo/**', '**/release/**'] }, proxy: squad },
  preview: { proxy: squad },
}));
