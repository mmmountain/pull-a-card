# Lay a photographed water splash (shot on black) into the Aero background: the black drops away, the highlights
# screen over the sky, the body of the water slightly darkens and bends what's behind it, and it meets the sea in foam.
import sys, numpy as np
from PIL import Image
from scipy import ndimage as nd
bg_path, photo_path, out_path = sys.argv[1:4]
X, Y, HGT, HZ = int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])  # top-left, height, horizon y
bg = np.asarray(Image.open(bg_path).convert("RGB")).astype(np.float32) / 255
ph = Image.open(photo_path).convert("RGB"); w = round(ph.width * HGT / ph.height); ph = ph.resize((w, HGT), Image.LANCZOS)
p = np.asarray(ph).astype(np.float32) / 255
p = p * np.clip(np.arange(HGT) / (0.12 * HGT), 0, 1)[:, None, None] ** 1.5  # the stream comes out of the sky, no hard edge
H, W = bg.shape[:2]
# place the photo on a full-frame black canvas (clipped to the frame)
canvas = np.zeros_like(bg); x0, y0 = max(0, X), max(0, Y); x1, y1 = min(W, X + w), min(H, Y + HGT)
canvas[y0:y1, x0:x1] = p[y0 - Y:y1 - Y, x0 - X:x1 - X]
L = canvas.max(-1)
L = np.clip((L - 0.035) / 0.965, 0, 1)                      # crush the black floor
# fade where it plunges under the sea surface
fade = np.clip((HZ + 6 - np.arange(H)) / 14.0, 0, 1)[:, None]; L = L * fade; canvas = canvas * fade[..., None]
body = nd.gaussian_filter((L > 0.05).astype(np.float32), 3) # the volume of the water
# refraction: bend the world behind by the shape of the water
Ls = nd.gaussian_filter(L, 4); gy, gx = np.gradient(Ls); k = 260
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
ref = np.stack([nd.map_coordinates(bg[..., c], [np.clip(yy + gy * k, 0, H - 1), np.clip(xx + gx * k, 0, W - 1)], order=1) for c in range(3)], -1)
out = bg * (1 - body[..., None]) + ref * body[..., None]
out = out * (1 - body[..., None] * 0.18) + body[..., None] * 0.18 * np.array([0.0, 0.2, 0.62])  # a little blue depth
tint = np.array([0.86, 0.97, 1.0])
hi = np.clip(canvas * tint * 1.15, 0, 1)
out = 1 - (1 - out) * (1 - hi)                               # screen the light of the water over the scene
# foam and a ring where the stream meets the sea
cols = np.where(L[HZ - 8:HZ].max(0) > 0.2)[0]
if len(cols):
    cx, half = cols.mean(), (cols.max() - cols.min()) / 2 + 30
    r = np.hypot((xx - cx) / half, (yy - HZ - 4) / (half * 0.12))
    fo = np.exp(-((r - 1.0) / 0.25) ** 2) * 0.55 + np.exp(-(r / 0.7) ** 2) * 0.35
    rng = np.random.default_rng(3); n = nd.gaussian_filter(rng.random((H, W)).astype(np.float32), 2); n = (n - n.min()) / (n.max() - n.min())
    fo = fo * np.clip(n * 1.6 - 0.2, 0, 1) * (yy > HZ - 2)
    out = out * (1 - fo[..., None]) + fo[..., None] * 0.97
Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)).save(out_path, quality=92)
