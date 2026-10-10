#!/usr/bin/env python3
"""Place the sample (demonstration) defects exactly on the part surfaces the viewer draws.

tools/defects_spec.json lists each defect with a rough spot: "at" (STL mm, may be off the surface)
and "look" (the side the surface is seen from, i.e. roughly the outward normal). For each one this
script casts a ray from at + look * 200 mm towards -look against the part's decoded mesh (the same
16-bit vertices the viewer unpacks from web/models/<model>.bin), takes the first hit as the defect
point p, the hit triangle's winding normal as n (all parts have outward winding) and the "dir" hint
projected onto the surface as the tangent t. Then it checks every result and writes
web/defects.json.

Checks (a failure stops with exit 1, warnings are printed):
  - p lies on the mesh (distance <= 0.05 mm) and n agrees with the winding normal (dot > 0.9)
  - the hit surface faces the "look" side (dot(n, look) > 0.3)
  - t is a unit vector perpendicular to n
  - the patch (radius r = max(1.5, 0.6 * size)) is reasonably flat: area-weighted mean of
    dot(face normal, n) over faces within r >= 0.75 (warning otherwise)
  - exposure: whether another part covers the spot within 30 mm along n (warning; the viewer ghosts
    the other parts when a defect is focused, so covered defects are still visible)

Run from the repo root:  python3 -I tools/place_defects.py          (writes web/defects.json)
Re-check only:           python3 -I tools/place_defects.py --check  (verifies web/defects.json)
Needs: numpy
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "web" / "models"
SPEC = ROOT / "tools" / "defects_spec.json"
OUT = ROOT / "web" / "defects.json"
TYPES = {"crack", "scratch", "dent", "wear", "corrosion", "deform"}
SEVS = {"high", "mid", "low"}
SNAP_TOL = 0.05  # mm


def load_model(key):
    """Decoded part meshes of web/models/<key>: {code: (vertices float64 (n,3), faces int64 (m,3))}."""
    doc = json.loads((MODELS / f"{key}.json").read_text(encoding="utf-8"))
    data = (MODELS / doc["bin"]).read_bytes()
    parts = {}
    for p in doc["parts"]:
        q = np.frombuffer(data, dtype="<u2", count=p["verts"] * 3, offset=p["pos"]).reshape(-1, 3).astype(np.float64)
        mn, mx = np.array(p["min"]), np.array(p["max"])
        span = np.where(mx - mn > 0, mx - mn, 1.0)
        v = mn + q * (span / 65535)
        f = np.frombuffer(data, dtype="<u2" if p["index"] == 16 else "<u4", count=p["tris"] * 3, offset=p["idx"]).reshape(-1, 3).astype(np.int64)
        parts[p.get("code") or p["file"]] = (v, f)
    return parts


def unit(a):
    a = np.asarray(a, dtype=np.float64)
    return a / max(np.linalg.norm(a), 1e-12)


def face_normals(v, f):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    n = np.cross(b - a, c - a)
    area = np.linalg.norm(n, axis=1)
    return n / np.maximum(area, 1e-12)[:, None], area / 2


def raycast(v, f, o, d):
    """Nearest hit of the ray o + s d (s > 0): (s, face index) or None. Moller-Trumbore, vectorised."""
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    e1, e2 = b - a, c - a
    pv = np.cross(d, e2)
    det = (e1 * pv).sum(1)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
    tv = o - a
    u = (tv * pv).sum(1) * inv
    qv = np.cross(tv, e1)
    w = (d * qv).sum(1) * inv
    s = (e2 * qv).sum(1) * inv
    hit = ok & (u >= -1e-9) & (w >= -1e-9) & (u + w <= 1 + 1e-9) & (s > 1e-9)
    if not hit.any():
        return None
    i = int(np.argmin(np.where(hit, s, np.inf)))
    return float(s[i]), i


def closest_on_mesh(v, f, p):
    """Distance from p to the mesh and the closest face (exact point-triangle distance, Ericson)."""
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = (ab * ap).sum(1), (ac * ap).sum(1)
    bp = p - b
    d3, d4 = (ab * bp).sum(1), (ac * bp).sum(1)
    cp = p - c
    d5, d6 = (ab * cp).sum(1), (ac * cp).sum(1)
    va, vb, vc = d3 * d6 - d5 * d4, d5 * d2 - d1 * d6, d1 * d4 - d3 * d2
    denom = np.where(np.abs(va + vb + vc) > 1e-18, va + vb + vc, 1e-18)
    q = a + ab * (vb / denom)[:, None] + ac * (vc / denom)[:, None]  # inside the face
    safe = lambda x: np.where(x != 0, x, 1)
    t_ab = np.clip(d1 / safe(d1 - d3), 0, 1)
    t_ac = np.clip(d2 / safe(d2 - d6), 0, 1)
    t_bc = np.clip((d4 - d3) / safe((d4 - d3) + (d5 - d6)), 0, 1)
    # vertex / edge regions in Ericson's priority order; applied last-to-first so earlier ones win
    regions = [
        ((d1 <= 0) & (d2 <= 0), a),
        ((d3 >= 0) & (d4 <= d3), b),
        ((vc <= 0) & (d1 >= 0) & (d3 <= 0), a + ab * t_ab[:, None]),
        ((d6 >= 0) & (d5 <= d6), c),
        ((vb <= 0) & (d2 >= 0) & (d6 <= 0), a + ac * t_ac[:, None]),
        ((va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0), b + (c - b) * t_bc[:, None]),
    ]
    for mask, pts in reversed(regions):
        q = np.where(mask[:, None], pts, q)
    dist = np.linalg.norm(q - p, axis=1)
    i = int(np.argmin(dist))
    return float(dist[i]), i


def flatness(v, f, normals, area, p, n, r):
    cen = (v[f[:, 0]] + v[f[:, 1]] + v[f[:, 2]]) / 3
    near = np.linalg.norm(cen - p, axis=1) < r
    near &= (normals @ n) > -0.2  # the far side of a thin wall is not part of the patch
    if not near.any():
        return 1.0
    return float((normals[near] @ n * area[near]).sum() / area[near].sum())


def place(spec):
    out, problems = {}, []
    for key, items in spec.items():
        if key.startswith("_"):
            continue
        parts = load_model(key)
        rows = []
        for it in items:
            code = it["part"]
            if code not in parts:
                problems.append(f"{key} {it['id']}: unknown part {code}")
                continue
            v, f = parts[code]
            look = unit(it["look"])
            hit = raycast(v, f, np.asarray(it["at"], float) + look * 200, -look)
            if hit is None:
                problems.append(f"{key} {it['id']}: ray from 'at' along -look misses {code}")
                continue
            s, fi = hit
            p = np.asarray(it["at"], float) + look * 200 - look * s
            normals, area = face_normals(v, f)
            n = normals[fi]
            hint = unit(it.get("dir", [0, 0, 1]))
            t = hint - n * (hint @ n)
            if np.linalg.norm(t) < 0.2:  # the hint is along the normal: fall back to X, then Y
                t = np.array([1.0, 0, 0]) - n * n[0]
                if np.linalg.norm(t) < 0.2:
                    t = np.array([0, 1.0, 0]) - n * n[1]
            t = unit(t)
            row = {k: it[k] for k in ("id", "part", "type", "sev")}
            row["p"] = [round(float(x), 2) for x in p]
            row["n"] = [round(float(x), 4) for x in n]
            row["t"] = [round(float(x), 4) for x in t]
            for k in ("size", "depth", "conf", "cause", "found"):
                if k in it:
                    row[k] = it[k]
            rows.append(row)
        out[key] = rows
    return out, problems


def check(data, verbose=True):
    problems, warnings = [], []
    for key, rows in data.items():
        if key.startswith("_"):
            continue
        parts = load_model(key)
        everything = [(c, vf) for c, vf in parts.items()]
        ids = set()
        for d in rows:
            tag = f"{key} {d.get('id')}"
            if d.get("id") in ids:
                problems.append(f"{tag}: duplicate id")
            ids.add(d.get("id"))
            if d.get("type") not in TYPES:
                problems.append(f"{tag}: bad type {d.get('type')}")
            if d.get("sev") not in SEVS:
                problems.append(f"{tag}: bad sev {d.get('sev')}")
            if not (isinstance(d.get("size"), (int, float)) and d["size"] > 0):
                problems.append(f"{tag}: size must be > 0")
            if d.get("part") not in parts:
                problems.append(f"{tag}: unknown part {d.get('part')}")
                continue
            v, f = parts[d["part"]]
            p, n, t = np.asarray(d["p"], float), np.asarray(d["n"], float), np.asarray(d["t"], float)
            dist, fi = closest_on_mesh(v, f, p)
            normals, area = face_normals(v, f)
            # the closest face can be a neighbour on a curved surface; compare with the faces around p
            cen = (v[f[:, 0]] + v[f[:, 1]] + v[f[:, 2]]) / 3
            close = np.linalg.norm(cen - p, axis=1) < max(1.0, dist + 0.6)
            agree = float(np.max(normals[close] @ n)) if close.any() else float(normals[fi] @ n)
            if dist > SNAP_TOL:
                problems.append(f"{tag}: {dist:.3f} mm off the surface of {d['part']}")
            if agree < 0.9:
                problems.append(f"{tag}: normal disagrees with the surface (best dot {agree:.2f})")
            if abs(np.linalg.norm(n) - 1) > 1e-3 or abs(np.linalg.norm(t) - 1) > 1e-3 or abs(n @ t) > 1e-3:
                problems.append(f"{tag}: n / t not orthonormal")
            r = max(1.5, 0.6 * d["size"])
            flat = flatness(v, f, normals, area, p, n, r)
            cover = []
            for c, (ov, of) in everything:
                h = raycast(ov, of, p + n * 0.05, n)
                if h and h[0] < 30 and not (c == d["part"] and h[0] < 0.2):
                    cover.append(f"{c}@{h[0]:.0f}mm")
            if flat < 0.75:
                warnings.append(f"{tag}: patch not flat (mean dot {flat:.2f}) — overlay will wrap edges")
            if verbose:
                print(f"  {tag:<16} {d['part']:<11} {d['type']:<9} {d['sev']:<4} p=({p[0]:8.2f},{p[1]:8.2f},{p[2]:8.2f}) "
                      f"n=({n[0]:5.2f},{n[1]:5.2f},{n[2]:5.2f}) snap={dist:.4f}mm flat={flat:.2f} "
                      f"{'covered by ' + ', '.join(cover) if cover else 'exposed'}")
    return problems, warnings


def main():
    if "--check" in sys.argv:
        data = json.loads(OUT.read_text(encoding="utf-8"))
    else:
        spec = json.loads(SPEC.read_text(encoding="utf-8"))
        data, problems = place(spec)
        if problems:
            print("\n".join("ERROR " + p for p in problems))
            sys.exit(1)
        data = {"_comment": spec.get("_comment", ""), **data}
    problems, warnings = check(data)
    for w in warnings:
        print("WARN  " + w)
    if problems:
        print("\n".join("ERROR " + p for p in problems))
        sys.exit(1)
    if "--check" not in sys.argv:
        OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"wrote {OUT.relative_to(ROOT)}: " + ", ".join(f"{k} {len(v)}" for k, v in data.items() if not k.startswith("_")))
    else:
        print("ok")


if __name__ == "__main__":
    main()
