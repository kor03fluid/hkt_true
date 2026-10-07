#!/usr/bin/env python3
"""Make light-weight copies of the assembly STLs for the web viewer.

The source STLs (Turret/, hailo/) are exported in assembly coordinates and are far too heavy for a
browser (~10M triangles per assembly). This script, for every part:

  1. reads the STL (binary or ASCII) and merges duplicate vertices,
  2. reduces the triangle count with quadric decimation (fast_simplification),
  3. writes a binary STL to web/models/<model>/ - with NO transform, so every vertex stays in the
     original assembly coordinate system and the parts still fit together exactly as exported,
  4. checks the result against the original: bounding box and centre must match within TOL_MM,
     and the reduced surface must stay close to the original one.

It also writes web/models/<model>/parts.json with part names and the explode moves from
tools/explode.json, and reports parts whose bounding boxes still overlap at full explode.

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


def write_stl(path: Path, pts: np.ndarray, faces: np.ndarray, header: str) -> None:
    tri = pts[faces].astype(np.float32)
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    nrm = np.divide(nrm, ln, out=np.zeros_like(nrm), where=ln > 0)
    rec = np.zeros(len(tri), dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    rec["n"] = nrm
    rec["v"] = tri
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(header.encode("ascii", "replace")[:80].ljust(80, b" "))
        f.write(struct.pack("<I", len(tri)))
        f.write(rec.tobytes())


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


def write_manifest(model, files):
    """parts.json for the viewer: names, source file and explode move (mm) per part."""
    moves = EXPLODE.get(model["key"], {})
    names = {p.name for p in files}
    for extra in sorted(set(moves) - {"_comment"} - names):
        print(f"!! {model['name']}: explode.json lists {extra}, which has no STL")
    manifest = {"name": model["name"], "subtitle": f"{model['src']}/ 원본 STL {len(files)}개 · 좌표 그대로", "up": "z"}
    if "view" in model:
        manifest["view"] = model["view"]
    manifest["parts"] = {}
    for p in files:
        entry = {"name": part_name(p.stem), "source": str(p.relative_to(ROOT))}
        if p.name in moves:
            entry["offset"] = moves[p.name]
        else:
            print(f"!! {model['name']}: no explode move for {p.name} (viewer will use the automatic direction)")
        manifest["parts"][p.name] = entry
    out_dir = OUT / model["key"]
    (out_dir / "parts.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def clearance(model, manifest):
    """Pairs of parts whose bounding boxes still overlap at full explode (by volume share of the smaller box)."""
    boxes = {}
    for name, entry in manifest["parts"].items():
        v = read_stl(OUT / model["key"] / name).reshape(-1, 3)
        off = np.array(entry.get("offset", [0, 0, 0]), dtype=float)
        boxes[name] = (v.min(0) + off, v.max(0) + off)
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

    out_dir = OUT / model["key"]
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.stl"):
        old.unlink()
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

        src = x["tris"].reshape(-1, 3)
        b0 = np.array([src.min(0), src.max(0)])
        b1 = np.array([npts.min(0), npts.max(0)])
        box_err = float(np.abs(b0 - b1).max())
        c_err = float(np.linalg.norm(b0.mean(0) - b1.mean(0)))
        p99, pmax = surface_dev(pts, faces, npts)

        name = x["path"].name
        write_stl(out_dir / name, npts, nfaces, f"reduced from {name} - assembly coordinates kept")
        size = b0[1] - b0[0]
        rows.append((name, n0, len(nfaces), size, box_err, c_err, p99, pmax))
        if box_err > TOL_MM or c_err > TOL_MM:
            bad.append(name)

    print(f"\n== {model['name']}  ({len(files)} parts)")
    print(f"{'file':52s} {'tris':>9s} -> {'web':>7s}   size (mm)                     bbox±  centre±  dev99   devmax")
    for name, n0, n1, size, be, ce, p99, pm in rows:
        print(f"{name:52s} {n0:9d} -> {n1:7d}   {size[0]:7.1f} x {size[1]:7.1f} x {size[2]:7.1f}   {be:5.3f}  {ce:6.3f}  {p99:5.3f}  {pm:6.3f}")
    clearance(model, write_manifest(model, files))
    return {"model": model["name"], "rows": rows, "bad": bad}


def main():
    if "--manifest-only" in sys.argv:
        for m in MODELS:
            files = source_files(m)
            if files:
                clearance(m, write_manifest(m, files))
        return
    results = [r for r in (build(m) for m in MODELS) if r]
    bad = [f"{r['model']}: {b}" for r in results for b in r["bad"]]
    if bad:
        print("\nFAILED - parts moved by more than", TOL_MM, "mm:", *bad, sep="\n  ")
        sys.exit(1)
    print(f"\nOK - every part keeps its bounding box and centre within {TOL_MM} mm of the original")


if __name__ == "__main__":
    main()
