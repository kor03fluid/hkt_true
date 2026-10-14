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
const LOOSE = '\u0000loose'; // STL files dropped without a folder (never a real folder name)

export const partLabel = (file) =>
  file
    .replace(/\.stl$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Models committed to the repo: [{ name, key, subtitle, up, manifest, binUrl, parts: [{ file, packed }] }] */
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
      key: path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, ''), // 'Turret', 'hailo-Modern', ... (maintenance data)
      binUrl,
      parts: doc.parts.map((p) => ({ file: p.file, packed: p })),
    });
  }
  // Turret first, then hailo Modern, hailo Legacy, everything else alphabetical
  const rank = (n) => ['turret', 'hailo modern', 'hailo legacy'].indexOf(n.toLowerCase()) + 1 || 9;
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

function finish(name, parts, manifest) {
  manifest = cleanManifest(manifest);
  return {
    name: manifest?.name || name,
    subtitle: manifest?.subtitle || `${name} 폴더의 STL 어셈블리`,
    up: (manifest?.up || 'z').toLowerCase(),
    manifest,
    parts,
  };
}

// a parts.json is hand-written: every text field becomes a string, groups a list of objects, the view
// numbers, so one odd value cannot break the part list, the labels or the camera
const text = (v) => (typeof v === 'string' ? v : v == null ? '' : Array.isArray(v) ? v.map(text).join('\n') : typeof v === 'object' ? '' : String(v));
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
function cleanManifest(m) {
  m = obj(m);
  if (!m) return null;
  const out = { ...m };
  for (const k of ['name', 'subtitle', 'about', 'up']) if (k in out) out[k] = text(out[k]);
  out.groups = Array.isArray(m.groups) ? m.groups.filter(obj).map((g) => ({ ...g, id: text(g.id), name: text(g.name) })) : [];
  const view = obj(m.view);
  if (view) {
    out.view = {};
    for (const k of ['x', 'y', 'z', 'zoom']) if (view[k] !== null && view[k] !== '' && Number.isFinite(+view[k])) out.view[k] = +view[k];
  } else delete out.view;
  const parts = obj(m.parts) || {};
  out.parts = {};
  for (const [file, info] of Object.entries(parts)) {
    const q = obj(info);
    if (!q) continue;
    const c = { ...q };
    for (const k of ['name', 'alt', 'group', 'desc', 'code']) if (k in c) c[k] = text(c[k]);
    out.parts[file] = c;
  }
  return out;
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
    const model = segs.length > 1 ? segs[0] : LOOSE;
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
    const loose = name === LOOSE;
    // folder: what identifies 'the same folder opened again' (loose files never replace anything)
    return { ...finish(loose ? '드롭한 모델' : name, parts, manifests.get(name)), folder: loose ? null : name };
  });
}
