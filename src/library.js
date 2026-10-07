// Finds the STL assemblies to show.
//
// Every folder under web/models/ that holds .stl files becomes one model, and every .stl file inside
// it becomes one part. Those files are light-weight copies of the originals in Turret/ and hailo/,
// made by tools/build_models.py without any transform, so loading them unchanged gives the
// assembled model in the original assembly coordinates (mm).
//
// parts.json next to the STL files can override names, colours, descriptions and explode moves:
// {
//   "name": "Turret", "subtitle": "...", "up": "z", "view": { "x": 0.4, "y": -0.6, "zoom": 1 },
//   "parts": { "base.stl": { "name": "Base", "desc": "...", "color": "#f2c94c", "offset": [0, 0, -60] } }
// }
// "offset" is the move at full explode in model units (mm); "explode" is a direction in units of
// the assembly radius. Parts without either move away from the assembly centre.

const STL_URLS = import.meta.glob(['/web/models/**/*.stl', '/web/models/**/*.STL'], {
  query: '?url',
  import: 'default',
  eager: true,
});
const MANIFESTS = import.meta.glob('/web/models/**/parts.json', {
  import: 'default',
  eager: true,
});

const WRAPPERS = new Set(['web', 'models', 'model', 'stl', 'stls', 'assets', 'cad']);

export const partLabel = (file) =>
  file
    .replace(/\.stl$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "/models/Turret/sub/base.stl" -> { model: "Turret", file: "sub/base.stl" } */
function splitPath(path) {
  const segs = path.split('/').filter(Boolean);
  let dir = '';
  while (segs.length > 2 && WRAPPERS.has(segs[0].toLowerCase())) dir += '/' + segs.shift();
  if (segs.length === 1) return { model: 'STL', dir, file: segs[0] };
  return { model: segs[0], dir: `${dir}/${segs[0]}`, file: segs.slice(1).join('/') };
}

function manifestFor(dir) {
  for (const [p, m] of Object.entries(MANIFESTS)) if (p === `${dir}/parts.json`) return m;
  return null;
}

/** Models committed to the repo: [{ name, subtitle, up, manifest, parts: [{ file, url }] }] */
export function repoModels() {
  const byModel = new Map();
  for (const [path, url] of Object.entries(STL_URLS)) {
    const { model, dir, file } = splitPath(path);
    if (!byModel.has(model)) byModel.set(model, { name: model, dir, parts: [] });
    byModel.get(model).parts.push({ file, url });
  }
  const out = [];
  for (const m of byModel.values()) {
    m.parts.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
    out.push(finish(m.name, m.parts, manifestFor(m.dir)));
  }
  // Turret first, then hailo Modern, hailo Legacy, everything else alphabetical
  const rank = (n) => ['turret', 'hailo modern', 'hailo legacy'].indexOf(n.toLowerCase()) + 1 || 9;
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

function finish(name, parts, manifest) {
  return {
    name: manifest?.name || name,
    subtitle: manifest?.subtitle || `${name} 폴더의 STL 어셈블리`,
    up: (manifest?.up || 'z').toLowerCase(),
    manifest: manifest || null,
    parts,
  };
}

// ------------------------------------------------------------------ drag & drop / folder picker

async function readEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + file.name, file });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await readEntry(e, `${prefix}${entry.name}/`, out);
    } while (batch.length);
  }
}

/** Files from a drop event or an <input webkitdirectory> -> list of local models. */
export async function localModels(source) {
  const files = [];
  if (source instanceof DataTransfer) {
    const entries = [...source.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) for (const e of entries) await readEntry(e, '', files);
    else for (const f of source.files) files.push({ path: f.name, file: f });
  } else {
    for (const f of source) files.push({ path: f.webkitRelativePath || f.name, file: f });
  }

  const byModel = new Map();
  const manifests = new Map();
  for (const { path, file } of files) {
    const segs = path.split('/');
    while (segs.length > 2 && WRAPPERS.has(segs[0].toLowerCase())) segs.shift();
    const model = segs.length > 1 ? segs[0] : '드롭한 모델';
    const rel = segs.length > 1 ? segs.slice(1).join('/') : segs[0];
    if (/\.stl$/i.test(path)) {
      if (!byModel.has(model)) byModel.set(model, []);
      byModel.get(model).push({ file: rel, blob: file });
    } else if (/(^|\/)parts\.json$/i.test(path)) {
      try {
        manifests.set(model, JSON.parse(await file.text()));
      } catch {
        /* ignore a broken manifest */
      }
    }
  }
  return [...byModel].map(([name, parts]) => {
    parts.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
    return finish(name, parts, manifests.get(name));
  });
}
