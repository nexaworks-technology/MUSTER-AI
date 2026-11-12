"""
Traces the Muster AI mark from the founder's reference sheet (docs/design/reference-logo-knot.png).

Provenance tool, run once by hand: python3 -I scripts/brand-trace-logo.py <out.json>
1. Crop the big mark (left of the sheet) with a small margin.
2. Convert to coverage (0 = paper, 1 = ink violet), upscale 10x (cubic), blur lightly to remove the
   source's compression noise, threshold at 45% coverage (the best pixel overlap with the reference: IoU 0.9905 against 0.987 at 50%).
3. Find every outline (outer silhouette and every hole: the weave gaps and the diamond).
4. Simplify each outline and fit smooth cubic curves through it (Catmull-Rom), keeping corners.
The result is filled with the even-odd rule, so holes stay holes. Coordinates are in source pixels
of the crop, so the traced mark lines up 1:1 with the reference crop for the overlay proof.
"""
import json
import sys

import cv2
import numpy as np

REF = "docs/design/reference-logo-knot.png"
CROP = (40, 50, 190, 166)  # x0, y0, x1, y1 in the sheet: the big mark plus margin
SCALE = 10


def coverage(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    ink = np.percentile(g[g < 120], 50)  # the solid violet
    paper = np.percentile(g[g > 200], 50)
    return np.clip((paper - g) / (paper - ink), 0, 1)


def catmull_rom(points, closed=True, tension=0.5):
    """Cubic Bezier segments through the points; corners (sharp turns) get straight handles."""
    n = len(points)
    segs = []
    for i in range(n):
        p0, p1, p2, p3 = points[(i - 1) % n], points[i], points[(i + 1) % n], points[(i + 2) % n]

        def turn(a, b, c):
            v1, v2 = b - a, c - b
            n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
            if n1 == 0 or n2 == 0:
                return 0
            return np.degrees(np.arccos(np.clip(np.dot(v1, v2) / (n1 * n2), -1, 1)))

        sharp1 = turn(p0, p1, p2) > 70
        sharp2 = turn(p1, p2, p3) > 70
        c1 = p1 if sharp1 else p1 + (p2 - p0) * tension / 3
        c2 = p2 if sharp2 else p2 - (p3 - p1) * tension / 3
        segs.append((c1, c2, p2))
    return segs


def clean_outline(raw, k=25, corner_deg=60, sigma=6.0, eps=1.5):
    """
    Hand-clean an outline the way a person tracing it would: keep the real corners (gap ends,
    the diamond) sharp, and smooth only the noise of the source's compression between them.
    `raw` is the dense 10x contour; returns simplified points (still at 10x).
    """
    n = len(raw)
    raw = raw + 0.5  # pixel centres to continuous coordinates
    # 1. Corners: where the outline turns sharply over a short span either side.
    turn = np.zeros(n)
    for i in range(n):
        a, b, c = raw[(i - k) % n], raw[i], raw[(i + k) % n]
        v1, v2 = b - a, c - b
        cosang = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9)
        turn[i] = np.degrees(np.arccos(np.clip(cosang, -1, 1)))
    corners = [
        i
        for i in range(n)
        if turn[i] > corner_deg and turn[i] == max(turn[(i + j) % n] for j in range(-k, k + 1))
    ]
    # 2. Smooth each run between corners (endpoints pinned), or the whole loop if none.
    out = []
    if not corners:
        idx = np.arange(n)
        sm = np.empty_like(raw)
        w = np.exp(-0.5 * (np.arange(-3 * int(sigma), 3 * int(sigma) + 1) / sigma) ** 2)
        w /= w.sum()
        for d in range(2):
            ext = np.concatenate([raw[-len(w) :, d], raw[:, d], raw[: len(w), d]])
            sm[:, d] = np.convolve(ext, w, mode="same")[len(w) : len(w) + n]
        approx = cv2.approxPolyDP(sm.astype(np.float32).reshape(-1, 1, 2), eps, True)[:, 0, :]
        return approx.astype(np.float64)
    for ci, start in enumerate(corners):
        end = corners[(ci + 1) % len(corners)]
        run = raw[[(start + j) % n for j in range(((end - start) % n) + 1)]]
        if len(run) > 4:
            sm = run.copy()
            for d in range(2):
                s = run[:, d]
                rad = int(min(3 * sigma, (len(s) - 1) // 2))
                if rad < 1:
                    continue
                w = np.exp(-0.5 * (np.arange(-rad, rad + 1) / sigma) ** 2)
                padded = np.concatenate([np.full(rad, s[0]), s, np.full(rad, s[-1])])
                sm[:, d] = np.convolve(padded, w / w.sum(), mode="valid")
            sm[0], sm[-1] = run[0], run[-1]
            run = cv2.approxPolyDP(sm.astype(np.float32).reshape(-1, 1, 2), eps, False)[:, 0, :]
        out.extend(run[:-1].tolist())  # the next run starts at this run's end corner
    return np.array(out, dtype=np.float64)


def trace():
    sheet = cv2.imread(REF)
    x0, y0, x1, y1 = CROP
    cov = coverage(sheet[y0:y1, x0:x1])
    big = cv2.resize(cov, None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_CUBIC)
    big = cv2.GaussianBlur(big, (0, 0), 3)
    mask = (big >= 0.45).astype(np.uint8)
    contours, _ = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    parts = []
    for c in contours:
        if cv2.contourArea(c) < 4 * SCALE * SCALE:  # specks under ~4 source px²
            continue
        pts = clean_outline(c[:, 0, :].astype(np.float64)) / SCALE
        segs = catmull_rom(pts)
        d = f"M{pts[0][0]:.2f} {pts[0][1]:.2f}"
        for c1, c2, p in segs:
            d += f"C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p[0]:.2f} {p[1]:.2f}"
        parts.append(d + "Z")
    # Ribbon thickness: twice the largest inscribed radius along the ribbons.
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5) / SCALE
    ribbon = float(np.percentile(dist[dist > 0], 99.5) * 2)
    ys, xs = np.where(mask)
    bbox = [xs.min() / SCALE, ys.min() / SCALE, (xs.max() + 1) / SCALE, (ys.max() + 1) / SCALE]
    return {
        "crop": CROP,
        "width": x1 - x0,
        "height": y1 - y0,
        "bbox": [round(v, 2) for v in bbox],
        "ribbon": round(ribbon, 2),
        "outlines": len(parts),
        "d": "".join(parts),
    }


if __name__ == "__main__":
    out = trace()
    with open(sys.argv[1], "w") as f:
        json.dump(out, f)
    print({k: v for k, v in out.items() if k != "d"}, "path chars:", len(out["d"]))
