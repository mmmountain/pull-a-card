import numpy as np
from PIL import Image
from scipy import ndimage as nd
def load(f): return np.asarray(Image.open(f).convert("RGB")).astype(np.float32) / 255
def save(a, f, q=88): Image.fromarray((np.clip(a, 0, 1) * 255 + .5).astype(np.uint8), "RGBA").save(f, quality=q, method=6)
def solid_matte(im, thr=0.07):
    v = im.max(-1); core = nd.binary_opening(v > thr, iterations=2)
    lab, n = nd.label(core); sizes = nd.sum(core, lab, range(1, n + 1)); keep = lab == (np.argmax(sizes) + 1)
    keep = nd.binary_fill_holes(nd.binary_closing(keep, iterations=5)); soft = nd.gaussian_filter(keep.astype(np.float32), 1.0)
    edge = np.clip((v - 0.02) / 0.08, 0, 1); a = np.where(soft > 0.99, 1.0, np.minimum(soft, np.maximum(edge, soft * 0.6)))
    return nd.gaussian_filter(a, 0.6)
def unpre(im, a): return np.clip(im / np.maximum(a[..., None], 0.05), 0, 1)
def bbox(a, pad=6):
    ys, xs = np.where(a > 0.03); return max(0, ys.min() - pad), ys.max() + pad, max(0, xs.min() - pad), xs.max() + pad
# ---- fruit bowl: color + greyed versions
im = load("bowl.webp"); a = solid_matte(im); y0, y1, x0, x1 = bbox(a)
rgb = unpre(im, a)[y0:y1, x0:x1]; a = a[y0:y1, x0:x1]
save(np.dstack([rgb, a]), "out/bowl.webp")
lum = rgb @ np.array([0.3, 0.59, 0.11]); grey = np.dstack([lum] * 3) * 0.85 + 0.08
save(np.dstack([grey * 0.9 + rgb * 0.1, a]), "out/bowl_grey.webp"); print("bowl", rgb.shape)
# ---- pod: crop the floor glow, lit + unlit
im = load("pod.webp"); H = im.shape[0]
a = solid_matte(im, 0.1); ys = np.where(a.max(1) > 0.5)[0]
rows = a.sum(1); base = int(H * 0.86)  # drop the glowing floor under the pod
a[base:] = 0; a[:base] *= 1
y0, y1, x0, x1 = bbox(a); rgb = unpre(im, a)[y0:y1, x0:x1]; a = a[y0:y1, x0:x1]
save(np.dstack([rgb, a]), "out/pod_lit.webp")
cy = (rgb[..., 2] - rgb[..., 0] > 0.25) & (rgb[..., 1] - rgb[..., 0] > 0.15)  # cyan light strips
cym = nd.gaussian_filter(cy.astype(np.float32), 2)[..., None]
lum = (rgb @ np.array([0.3, 0.59, 0.11]))[..., None]
unlit = rgb * (1 - cym) + cym * (lum * np.array([0.75, 0.82, 0.88]) * 0.7)
save(np.dstack([unlit, a]), "out/pod.webp"); print("pod", rgb.shape)
# ---- glass: clear glass keyed by light, split into walls and contents
im = load("glass.webp"); H, W = im.shape[:2]
v = im.max(-1); body = solid_matte(im, 0.05)
cut = int(H * 0.895); body[cut:] = 0  # drop the mirrored floor
y0, y1, x0, x1 = bbox(body); im = im[y0:y1, x0:x1]; body = body[y0:y1, x0:x1]; v = v[y0:y1, x0:x1]
a = np.clip(v * 1.25, 0, 1) * 0.85 + 0.15 * body  # glass: alpha follows its light; a faint body so it reads as a volume
a = np.minimum(a, body)
rgb = unpre(im, a) * 0.9 + 0.1 * np.array([0.85, 0.97, 1.0])
h, w = a.shape; walls = np.zeros_like(a)
for r in range(h):
    xs = np.where(body[r] > 0.5)[0]
    if len(xs) < 4: continue
    L, Rr = xs.min(), xs.max(); t = max(5, int((Rr - L) * 0.07)); walls[r, L:L + t] = 1; walls[r, Rr - t:Rr + 1] = 1
top = int(h * 0.04); basey = int(h * 0.86)
walls[:top] = 1; walls[basey:] = 1
walls = nd.gaussian_filter(walls, 2.0)
save(np.dstack([rgb, a * walls]), "out/glass_walls.webp")
save(np.dstack([rgb, a * (1 - walls)]), "out/glass_water.webp")
print("glass", a.shape, "water from", top, "to", basey)
