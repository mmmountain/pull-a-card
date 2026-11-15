# One stop-motion step: keep the previous frame, take only the patch where Kontext removed a piece.
import sys, numpy as np
from PIL import Image
from scipy import ndimage as nd
prev, kon, out = sys.argv[1:4]
P = np.asarray(Image.open(prev).convert("RGB")).astype(np.float32) / 255
K = np.asarray(Image.open(kon).convert("RGB").resize((P.shape[1], P.shape[0]), Image.LANCZOS)).astype(np.float32) / 255
d = nd.gaussian_filter(np.abs(K - P).max(-1), 3)
m = d > 0.12; m = nd.binary_opening(m, iterations=3)
lab, n = nd.label(m); sizes = nd.sum(m, lab, range(1, n + 1)); keep = lab == (np.argmax(sizes) + 1)
keep = nd.binary_fill_holes(nd.binary_dilation(keep, iterations=10))
a = nd.gaussian_filter(keep.astype(np.float32), 6)[..., None]
Image.fromarray((np.clip(P * (1 - a) + K * a, 0, 1) * 255 + .5).astype(np.uint8)).save(out)
ys, xs = np.where(keep); print("patch", xs.min(), xs.max(), ys.min(), ys.max(), "area", int(keep.sum()))
