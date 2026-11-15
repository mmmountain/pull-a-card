# Assemble the generated Focus scene: plate + ringed planet + water stream, and re-cut the rendered objects' layers
# so their shadows become true shadows (black with alpha) over the new sand instead of patches of the old one.
import numpy as np, json, glob, os, subprocess
from PIL import Image
from scipy import ndimage as nd
OUT = "pack"; os.makedirs(OUT, exist_ok=True)
plate = Image.open("plate_src.webp").convert("RGB").resize((1080, 1920), Image.LANCZOS)
HZ = 855
bg = np.asarray(plate).astype(np.float32) / 255
# ringed planet: opaque body and rings, soft glow edges
pl = np.asarray(Image.open("planet_src.webp").convert("RGB")).astype(np.float32) / 255
v = pl.max(-1); a = np.clip((v - 0.03) / 0.22, 0, 1); a = nd.gaussian_filter(a, 0.7)
rgb = np.clip(pl / np.maximum(a[..., None], 0.05), 0, 1)
ys, xs = np.where(a > 0.02); pl_rgba = np.dstack([rgb, a])[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
pim = Image.fromarray((pl_rgba * 255).astype(np.uint8), "RGBA"); PW = 500; pim = pim.resize((PW, round(PW * pim.height / pim.width)), Image.LANCZOS)
base = Image.fromarray((bg * 255).astype(np.uint8)).convert("RGBA"); base.alpha_composite(pim, (290 - PW // 2, 360 - pim.height // 2))
base.convert("RGB").save(f"{OUT}/bg.jpg", quality=93)
subprocess.run(["python3", "/home/claude/aero-build/photo/water_overlay.py", f"{OUT}/bg.jpg", "stream2.png", f"{OUT}/bg.jpg", "-120", "300", "690", str(HZ)], check=True)
# soft contact shadows where the photographed objects stand on the sand
import json as _j
L = _j.load(open("/home/claude/aero-build/mj/layout.json"))
b = np.asarray(Image.open(f"{OUT}/bg.jpg").convert("RGB")).astype(np.float32) / 255
yy, xx = np.mgrid[0:1920, 0:1080].astype(np.float32); sh = np.zeros((1920, 1080), np.float32)
for k, (cx, cy, rx, ry, d) in L["shadows"].items(): sh = np.maximum(sh, np.exp(-(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2) * 2.2) * d)
b = b * (1 - sh[..., None] * np.array([0.9, 0.85, 0.75]))
Image.fromarray((b * 255 + .5).astype(np.uint8)).save(f"{OUT}/bg.jpg", quality=92)
