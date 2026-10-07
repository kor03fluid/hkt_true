#!/usr/bin/env python3
"""Make light-weight copies of the assembly STLs for the web viewer.

The source STLs (Turret/, hailo/) are exported in assembly coordinates and are far too heavy for a
browser (~10M triangles per assembly). This script, for every part:

  1. reads the STL (binary or ASCII) and merges duplicate vertices,
  2. reduces the triangle count with quadric decimation (fast_simplification),
  3. packs it into web/models/<model>.bin: vertices as 16-bit integers inside the part's own
     bounding box (step = part size / 65535, i.e. well under 0.01 mm) plus 16/32-bit indices.
     There is NO other transform, so every vertex stays in the original assembly coordinate
     system and the parts still fit together exactly as exported,
  4. checks the decoded result against the original: bounding box and centre must match within
     TOL_MM, and the reduced surface must stay close to the original one.

web/models/<model>.json holds the part table (byte ranges in the .bin, bounding boxes, names and
the explode moves from tools/explode.json). Parts whose bounding boxes still overlap at full
explode are reported.

Run from the repo root:  python3 tools/build_models.py
After editing only tools/explode.json:  python3 tools/build_models.py --manifest-only
Needs: numpy, scipy, fast-simplification  (pip install -r tools/requirements.txt)
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np
import fast_simplification
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "models"
EXPLODE = json.loads((ROOT / "tools" / "explode.json").read_text(encoding="utf-8"))
INFO = json.loads((ROOT / "tools" / "parts_info.json").read_text(encoding="utf-8"))
TOL_MM = 0.5  # max allowed bounding-box / centre shift per part

# name: shown in the viewer, src: folder searched recursively, match: file-name prefix filter,
# view: optional starting camera angles (radians) for the viewer
MODELS = [
    {"key": "Turret", "name": "Turret", "src": "Turret", "match": "", "budget": 420_000},
    # the hailo parts explode sideways (±Y), so start with the camera looking across that axis
    {"key": "hailo-Modern", "name": "hailo Modern", "src": "hailo", "match": "Modern_", "budget": 380_000, "view": {"x": 0.42, "y": -1.2, "zoom": 0.8}},
    {"key": "hailo-Legacy", "name": "hailo Legacy", "src": "hailo", "match": "Legacy_", "budget": 340_000, "view": {"x": 0.42, "y": -1.2, "zoom": 0.8}},
]
MIN_TRIS, MAX_TRIS = 8_000, 90_000


# ------------------------------------------------------------------ STL io
def read_stl(path: Path) -> np.ndarray:
    """Returns triangles as float64 array (n, 3, 3)."""
    data = path.read_bytes()
    if len(data) >= 84:
        n = struct.unpack_from("<I", data, 80)[0]
        if 84 + 50 * n == len(data):
            rec = np.frombuffer(data, dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]), count=n, offset=84)
            return rec["v"].astype(np.float64)
    # ASCII
    verts = [list(map(float, line.split()[1:4])) for line in data.decode("utf-8", "replace").splitlines() if line.strip().startswith("vertex")]
    if not verts or len(verts) % 3:
        raise ValueError(f"cannot parse {path}")
    return np.asarray(verts, dtype=np.float64).reshape(-1, 3, 3)


def pack(pts: np.ndarray, faces: np.ndarray):
    """Quantise vertices to uint16 inside the part bounding box. Returns (min, max, q, idx, decoded)."""
    mn, mx = pts.min(0), pts.max(0)
    span = np.where(mx - mn > 0, mx - mn, 1.0)
    q = np.round((pts - mn) / span * 65535).astype("<u2")
    decoded = mn + q.astype(np.float64) * (span / 65535)
    idx = faces.astype("<u2" if len(pts) <= 65536 else "<u4")
    return mn, mx, q, idx, decoded


def weld(tris: np.ndarray):
    """Triangle soup -> (points, faces) with exactly-equal vertices merged; drops degenerate faces."""
    flat = np.ascontiguousarray(tris.reshape(-1, 3).astype(np.float32))
    key = flat.view(np.dtype((np.void, 12))).ravel()
    _, first, inv = np.unique(key, return_index=True, return_inverse=True)
    pts = flat[first].astype(np.float64)
    faces = inv.reshape(-1, 3)
    ok = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])
    return pts, faces[ok].astype(np.int64)


# ------------------------------------------------------------------ helpers
def part_name(stem: str) -> str:
    """'B-01_베이스_하우징' -> 'B-01 베이스 하우징', 'Modern_Left_Pod_Housing_HP-01L' -> 'HP-01L Left Pod Housing'."""
    words = stem.split("_")
    if words[0] in ("Modern", "Legacy"):
        words = words[1:]
        code = words.pop() if words and "-" in words[-1] and words[-1][:2].isalpha() else ""
        return f"{code} {' '.join(words)}".strip()
    return " ".join(words)


def surface_dev(orig_pts, orig_faces, new_pts, samples=20000, seed=0):
    """Distance (mm) from points sampled on the reduced surface to the nearest point sampled densely on the original."""
    rng = np.random.default_rng(seed)

    def sample(p, f, n):
        a, b, c = p[f[:, 0]], p[f[:, 1]], p[f[:, 2]]
        area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
        idx = rng.choice(len(f), size=n, p=area / area.sum())
        u, v = rng.random(n), rng.random(n)
        flip = u + v > 1
        u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
        return a[idx] + (b[idx] - a[idx]) * u[:, None] + (c[idx] - a[idx]) * v[:, None]

    ref = np.vstack([orig_pts, sample(orig_pts, orig_faces, min(2_000_000, len(orig_faces) * 2))])
    d, _ = cKDTree(ref).query(new_pts if len(new_pts) <= samples else new_pts[rng.choice(len(new_pts), samples, replace=False)])
    return float(np.percentile(d, 99)), float(d.max())


def source_files(model):
    return sorted(p for p in (ROOT / model["src"]).rglob("*") if p.suffix.lower() == ".stl" and p.name.startswith(model["match"]))


def part_code(stem: str, known) -> str:
    """'B-01_베이스_하우징' -> 'B-01', 'Modern_Left_Pod_Housing_HP-01L' -> 'HP-01L' (first or last token)."""
    words = stem.split("_")
    for w in (words[0], words[-1]):
        if w in known:
            return w
    return ""


def apply_manifest(model, doc):
    """Names, descriptions, groups, explode moves (mm) and view settings; writes web/models/<key>.json."""
    moves = EXPLODE.get(model["key"], {})
    info = INFO.get(model["key"], {})
    known = info.get("parts", {})
    doc.pop("about", None)
    doc.pop("groups", None)
    if info.get("about"):
        doc["about"] = info["about"]
    if info.get("groups"):
        doc["groups"] = info["groups"]
    names = {p["file"] for p in doc["parts"]}
    for extra in sorted(set(moves) - {"_comment"} - names):
        print(f"!! {model['name']}: explode.json lists {extra}, which has no STL")
    doc.update({"name": model["name"], "subtitle": f"{model['src']}/ 원본 STL {len(names)}개 · 좌표 그대로", "up": "z"})
    doc.pop("view", None)
    if "view" in model:
        doc["view"] = model["view"]
    used = set()
    for p in doc["parts"]:
        stem = Path(p["file"]).stem
        code = part_code(stem, known)
        for k in ("alt", "desc", "group", "code"):
            p.pop(k, None)
        p["name"] = part_name(stem)
        if code:
            used.add(code)
            meta = known[code]
            alt = p["name"]
            p["name"] = f"{code} {meta['name']}"
            p["code"] = code
            if alt != p["name"] and any("\uac00" <= ch <= "\ud7a3" for ch in alt):
                p["alt"] = alt[len(code):].strip() if alt.startswith(code) else alt  # Korean name from the file
            p["desc"] = meta["desc"]
            p["group"] = meta["group"]
        else:
            print(f"!! {model['name']}: no description for {p['file']} (tools/parts_info.json)")
        if p["file"] in moves:
            p["offset"] = moves[p["file"]]
        else:
            p.pop("offset", None)
            print(f"!! {model['name']}: no explode move for {p['file']} (viewer will use the automatic direction)")
    for extra in sorted(set(known) - used):
        print(f"!! {model['name']}: parts_info.json describes {extra}, which has no STL")
    (OUT / f"{model['key']}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return doc


def clearance(model, doc):
    """Pairs of parts whose bounding boxes still overlap at full explode (by volume share of the smaller box)."""
    boxes = {}
    for p in doc["parts"]:
        off = np.array(p.get("offset", [0, 0, 0]), dtype=float)
        boxes[p["file"]] = (np.array(p["min"]) + off, np.array(p["max"]) + off)
    hits = []
    keys = list(boxes)
    for i, a in enumerate(keys):
        for b in keys[i + 1 :]:
            lo = np.maximum(boxes[a][0], boxes[b][0])
            hi = np.minimum(boxes[a][1], boxes[b][1])
            if np.all(hi > lo):
                inter = np.prod(hi - lo)
                small = min(np.prod(boxes[a][1] - boxes[a][0]), np.prod(boxes[b][1] - boxes[b][0]))
                share = inter / max(small, 1e-9)
                if share > 0.02:
                    hits.append((share, a, b))
    hits.sort(reverse=True)
    print(f"-- {model['name']}: bounding-box overlaps at full explode: {len(hits) or 'none'}")
    for share, a, b in hits:
        print(f"   {share:5.0%}  {a}  <->  {b}")


# ------------------------------------------------------------------ main
def build(model):
    files = source_files(model)
    if not files:
        print(f"!! {model['name']}: no STL files")
        return None
    parts = []
    for p in files:
        tris = read_stl(p)
        pts, faces = weld(tris)
        parts.append({"path": p, "tris": tris, "pts": pts, "faces": faces})

    w = np.array([len(x["faces"]) for x in parts], dtype=float) ** 0.6
    targets = np.clip(model["budget"] * w / w.sum(), MIN_TRIS, MAX_TRIS).astype(int)

    OUT.mkdir(parents=True, exist_ok=True)
    blob = bytearray()
    table = []
    rows, bad = [], []
    for x, target in zip(parts, targets):
        pts, faces = x["pts"], x["faces"]
        n0 = len(faces)
        npts, nfaces = pts, faces
        # the decimator sometimes stalls far above the target on finely tessellated parts;
        # another pass from the partly reduced mesh gets it there
        for _ in range(4):
            if len(nfaces) <= target * 1.05:
                break
            npts, nfaces = fast_simplification.simplify(npts, nfaces, target_count=int(target), agg=5)
        # keep only vertices that are still referenced
        used = np.unique(nfaces)
        remap = np.full(len(npts), -1)
        remap[used] = np.arange(len(used))
        npts, nfaces = npts[used], remap[nfaces]

        mn, mx, q, idx, dec = pack(npts, nfaces)
        # everything below is measured on the decoded vertices, i.e. exactly what the viewer draws
        src = x["tris"].reshape(-1, 3)
        b0 = np.array([src.min(0), src.max(0)])
        b1 = np.array([dec.min(0), dec.max(0)])
        box_err = float(np.abs(b0 - b1).max())
        c_err = float(np.linalg.norm(b0.mean(0) - b1.mean(0)))
        p99, pmax = surface_dev(pts, faces, dec)

        name = x["path"].name
        pos_at = len(blob)
        blob += q.tobytes()
        blob += b"\0" * (-len(blob) % 4)
        idx_at = len(blob)
        blob += idx.tobytes()
        blob += b"\0" * (-len(blob) % 4)
        table.append({
            "file": name,
            "source": str(x["path"].relative_to(ROOT)),
            "verts": len(q), "tris": len(idx), "index": 16 if idx.dtype == np.uint16 else 32,
            "pos": pos_at, "idx": idx_at,
            "min": mn.tolist(), "max": mx.tolist(),
        })
        size = b0[1] - b0[0]
        rows.append((name, n0, len(nfaces), size, box_err, c_err, p99, pmax))
        if box_err > TOL_MM or c_err > TOL_MM:
            bad.append(name)

    print(f"\n== {model['name']}  ({len(files)} parts)")
    print(f"{'file':52s} {'tris':>9s} -> {'web':>7s}   size (mm)                     bbox±  centre±  dev99   devmax")
    for name, n0, n1, size, be, ce, p99, pm in rows:
        print(f"{name:52s} {n0:9d} -> {n1:7d}   {size[0]:7.1f} x {size[1]:7.1f} x {size[2]:7.1f}   {be:5.3f}  {ce:6.3f}  {p99:5.3f}  {pm:6.3f}")
    (OUT / f"{model['key']}.bin").write_bytes(bytes(blob))
    print(f"   -> web/models/{model['key']}.bin  {len(blob) / 1e6:.1f} MB")
    clearance(model, apply_manifest(model, {"bin": f"{model['key']}.bin", "parts": table}))
    return {"model": model["name"], "rows": rows, "bad": bad}


def main():
    if "--manifest-only" in sys.argv:
        for m in MODELS:
            path = OUT / f"{m['key']}.json"
            if path.exists():
                clearance(m, apply_manifest(m, json.loads(path.read_text(encoding="utf-8"))))
        return
    results = [r for r in (build(m) for m in MODELS) if r]
    bad = [f"{r['model']}: {b}" for r in results for b in r["bad"]]
    if bad:
        print("\nFAILED - parts moved by more than", TOL_MM, "mm:", *bad, sep="\n  ")
        sys.exit(1)
    print(f"\nOK - every part keeps its bounding box and centre within {TOL_MM} mm of the original")


if __name__ == "__main__":
    main()
