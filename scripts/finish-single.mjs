// After `vite build --mode single`: move the one self-contained page to release/HoloHand-STL.html.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'release/.tmp');
const out = path.join(root, 'release/HoloHand-STL.html');
const left = fs.readdirSync(tmp).filter((f) => f !== 'index.html');
if (left.length) throw new Error('single-file build left extra files (not inlined): ' + left.join(', '));
fs.renameSync(path.join(tmp, 'index.html'), out);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`release/HoloHand-STL.html  ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
