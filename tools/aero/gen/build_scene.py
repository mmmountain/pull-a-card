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
subprocess.run(["python3", "/home/claude/aero-build/photo/water_overlay.py", f"{OUT}/bg.jpg", "/home/claude/aero-build/photo/stream.png", f"{OUT}/bg.jpg", "600", "-95", "950", str(HZ)], check=True)
# re-cut layers
old = np.asarray(Image.open("oldbg.png").convert("RGB")).astype(np.float32) / 255
man = json.load(open("/home/claude/aero-build/pack9/manifest.json"))
for n in ["eat", "bathroom", "water"]:
    L = man["layers"][n]; ob = old[L["y"]:L["y"] + L["h"], L["x"]:L["x"] + L["w"]]
    for f in glob.glob(f"/home/claude/aero-build/pack9/{n}-*.webp"):
        im = np.asarray(Image.open(f).convert("RGBA")).astype(np.float32) / 255; F, A = im[..., :3], im[..., 3]
        k = F / np.maximum(ob, 0.03); km = k.mean(-1); ks = k.std(-1)
        sand = ((ob[..., 0] - ob[..., 2]) > 0.12) & (np.arange(L["y"], L["y"] + L["h"])[:, None] > 1150)  # only where the old world was sand
        shadow = (ks < 0.08) & (km < 0.985) & (A > 0) & sand
        sa = nd.gaussian_filter(np.where(shadow, np.clip(1 - km, 0, 1) * A, 0), 2.5)
        shadow = nd.binary_dilation(shadow, iterations=2) & sand & ~((A > 0) & ~shadow & (ks >= 0.08))
        out = np.dstack([np.where(shadow[..., None], 0.0, F), np.where(shadow, sa * 1.05, A)])
        # where it nearly matches the old sand, it's just sand: drop it
        out[..., 3] = np.where((~shadow) & sand & (np.abs(F - ob).max(-1) < 0.04), 0, out[..., 3])
        Image.fromarray((np.clip(out, 0, 1) * 255 + .5).astype(np.uint8), "RGBA").save(f"{OUT}/" + os.path.basename(f), quality=86, method=6)
json.dump({"layers": {n: man["layers"][n] for n in ["eat", "bathroom", "water"]}, "levels": man["levels"]}, open(f"{OUT}/manifest.json", "w"))
