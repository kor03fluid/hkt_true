import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// npm run build        -> dist/ : static site (index.html + assets), host it anywhere (GitHub Pages, any web server)
// npm run build:single -> release/HoloHand-STL.html : one file with code and models inside, opens by double-click
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
  server: { watch: { ignored: ['**/Turret/**', '**/hailo/**', '**/release/**'] } },
}));
