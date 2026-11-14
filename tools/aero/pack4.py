# Post every frame, then cut each need out of its frame where it differs from the empty world.
import sys, os, json, numpy as np
from PIL import Image
from scipy import ndimage as nd
sys.path.insert(0, os.path.dirname(__file__)); from post import load, post
src, dst = sys.argv[1], sys.argv[2]; os.makedirs(dst, exist_ok=True)
sun = json.load(open(f"{src}/sun.json"))
bg = post(load(f"{src}/bg.png"), sun)
Image.fromarray((bg * 255 + .5).astype(np.uint8)).save(f"{dst}/bg.jpg", quality=90)
Image.fromarray((post(load(f"{src}/mock.png"), sun) * 255 + .5).astype(np.uint8)).save(f"{dst}/mock.jpg", quality=90)
LEVELS = [0, 15, 30, 45, 60, 75, 90, 100]; man = {}
for n in ["walk", "eat", "stretch", "bathroom", "water"]:
    frames = {l: post(load(f"{src}/{n}-{l}.png"), sun) for l in LEVELS}
    masks = {}
    for l, f in frames.items():
        d = np.abs(f - bg).max(-1)
        m = np.clip((d - 0.012) / 0.03, 0, 1)
        m = nd.maximum_filter(m, 3); m = nd.gaussian_filter(m, 1.0)
        masks[l] = m
    union = np.maximum.reduce(list(masks.values())) > 0.02
    ys, xs = np.where(union); y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    man[n] = {"x": int(x0), "y": int(y0), "w": int(x1 - x0), "h": int(y1 - y0)}
    for l, f in frames.items():
        rgba = np.dstack([f, masks[l]])[y0:y1, x0:x1]
        Image.fromarray((rgba * 255 + .5).astype(np.uint8), "RGBA").save(f"{dst}/{n}-{l}.png", optimize=True)
    print(n, man[n])
for s in ["gull", "fish"]:
    im = Image.open(f"{src}/sprite-{s}.png"); im.crop(im.getbbox()).save(f"{dst}/sprite-{s}.png", optimize=True)
json.dump({"size": [1080, 1920], "levels": LEVELS, "layers": man}, open(f"{dst}/manifest.json", "w"), indent=1)
