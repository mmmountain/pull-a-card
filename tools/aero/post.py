# Aero post: downsample, bloom, sun rays, lens ghosts, grade, vignette. Deterministic per pixel position,
# so the empty world and each "world + one need" frame get identical treatment and diff cleanly.
import sys, json, numpy as np
from PIL import Image
from scipy import ndimage as nd
W, H = 1080, 1920
def load(path):
    im = Image.open(path).convert("RGB")
    if im.size != (W, H): im = im.resize((W, H), Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0
def blur(a, s): return np.stack([nd.gaussian_filter(a[..., c], s, mode="nearest") for c in range(3)], -1)
def post(img, sun):
    lum = img @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    bright = img * (np.clip((lum - 0.86) / 0.14, 0, 1) ** 1.5)[..., None]
    small = bright[::2, ::2]
    bloom = blur(small, 4) * 0.35 + blur(small, 14) * 0.35 + blur(small, 40) * 0.4
    bloom = np.repeat(np.repeat(bloom, 2, 0), 2, 1)[:H, :W]
    # sun rays: radial smear of the bright sky toward the sun
    sx, sy = sun[0] * W / 2, sun[1] * H / 2
    rays = np.zeros_like(small); src = bright[::2, ::2] * (np.arange(H // 2)[:, None, None] < (0.52 * H / 2))
    for i in range(28):
        k = 1 - i * 0.022
        m = np.array([[k, 0], [0, k]]); off = np.array([sy, sx]) * (1 - k)
        z = np.stack([nd.affine_transform(src[..., c], np.linalg.inv(m), offset=-np.linalg.inv(m) @ off, order=1, mode="constant") for c in range(3)], -1)
        rays += z * (1 - i / 28)
    rays = blur(rays / 14, 2)
    rays = np.repeat(np.repeat(rays, 2, 0), 2, 1)[:H, :W]
    out = img + bloom * 0.4 + rays * np.array([1.0, 0.95, 0.8], np.float32) * 0.5
    # lens ghosts along the axis through the frame center
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    cx, cy = W / 2, H / 2; ux, uy = sun[0] * W, sun[1] * H
    for t, r, col, a in [(0.55, 60, (0.4, 1.0, 0.7), 0.10), (0.9, 26, (1.0, 0.8, 0.4), 0.14), (1.3, 110, (0.4, 0.7, 1.0), 0.07), (1.65, 40, (0.9, 0.5, 1.0), 0.09)]:
        gx, gy = ux + (cx - ux) * t * 2 * 0.5 * 2 / 2 * 1.0 * (1), uy + (cy - uy) * t
        gx = ux + (cx - ux) * t
        d = np.hypot(xx - gx, yy - gy) / r
        ring = np.clip(1 - d, 0, 1) ** 0.6 * 0.6 + np.exp(-((d - 0.95) ** 2) / 0.004) * 0.6
        out += ring[..., None] * np.array(col, np.float32) * a
    # grade: saturation, gentle S-curve, cool shadows
    l2 = out @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    out = l2[..., None] + (out - l2[..., None]) * 1.18
    out = np.clip(out, 0, 1)
    out = out + (out - out ** 2) * (out - 0.5) * 0.35 * 0  # placeholder for curve tuning
    out = 0.5 + (out - 0.5) * 1.06
    v = np.hypot((xx - cx) / W, (yy - cy) / H * 0.75)
    out *= (1 - np.clip(v - 0.32, 0, 1) * 0.55)[..., None]
    return np.clip(out, 0, 1)
if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]; sun = json.load(open(sys.argv[3]))
    Image.fromarray((post(load(src), sun) * 255 + 0.5).astype(np.uint8)).save(dst)
