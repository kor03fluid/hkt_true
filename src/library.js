// Finds the assemblies to show.
//
// Repo models: tools/build_models.py turns the source STLs in Turret/ and hailo/ into one packed
// model per assembly, web/models/<model>.json (part table: names, explode moves, bounding boxes)
// + web/models/<model>.bin (16-bit vertices + indices). No transform is applied, so the parts
// load in the original assembly coordinates (mm).
//
// Local models: any STL folder opened with the folder button or dropped on the page; one folder =
// one model, one .stl = one part. An optional parts.json in that folder can override names,
// colours, descriptions and explode moves:
// {
//   "name": "Turret", "subtitle": "...", "up": "z", "view": { "x": 0.4, "y": -0.6, "zoom": 1 },
//   "parts": { "base.stl": { "name": "Base", "desc": "...", "color": "#f2c94c", "offset": [0, 0, -60] } }
// }
// "offset" is the move at full explode in model units (mm); "explode" is a direction in units of
// the assembly radius. Parts without either move away from the assembly centre.

const PACKS = import.meta.glob('/web/models/*.json', { import: 'default', eager: true });
const BINS = import.meta.glob('/web/models/*.bin', { query: '?url', import: 'default', eager: true });

const WRAPPERS = new Set(['web', 'models', 'model', 'stl', 'stls', 'assets', 'cad']);

export const partLabel = (file) =>
  file
    .replace(/\.stl$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Models committed to the repo: [{ name, subtitle, up, manifest, binUrl, parts: [{ file, packed }] }] */
export function repoModels() {
  const out = [];
  for (const [path, doc] of Object.entries(PACKS)) {
    const binUrl = BINS[path.slice(0, path.lastIndexOf('/') + 1) + doc.bin];
    if (!binUrl) {
      console.warn('missing', doc.bin, 'for', path);
      continue;
    }
    const parts = Object.fromEntries(doc.parts.map((p) => [p.file, p]));
    out.push({
      ...finish(doc.name, [], { name: doc.name, subtitle: doc.subtitle, up: doc.up, view: doc.view, about: doc.about, groups: doc.groups, parts }),
      binUrl,
      parts: doc.parts.map((p) => ({ file: p.file, packed: p })),
    });
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
