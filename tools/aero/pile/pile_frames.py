# Stop-motion fruit pile: start from the glass shot (no fruit) and add pieces one at a time, front first,
# each piece cut from the chosen Midjourney pile with SAM3 masks. Only fruit and its disturbed sand are drawn.
import numpy as np, json
from PIL import Image
from scipy import ndimage as nd
x0, y0, x1, y1 = map(int, open("crop.txt").read().split())
W, H = 1152, 896
F = np.asarray(Image.open("f7.png").convert("RGB")).astype(np.float32) / 255
E = np.asarray(Image.open("/home/claude/aero-build/mj/glass3_full.jpg").convert("RGB").crop((x0, y0, x1, y1)).resize((W, H), Image.LANCZOS)).astype(np.float32) / 255
M = lambda *ks: np.any([np.asarray(Image.open(f"m_{k}.png")) > 127 for k in ks], axis=0)
pieces = [M("s5"), M("s4"), M("g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"), M("s3", "s1", "s2"), M("o1"), M("a1")]
fruit = np.any(pieces, axis=0)
dirt = (nd.gaussian_filter(np.abs(F - E).max(-1), 2) > 0.08) & ~nd.binary_dilation(fruit, iterations=2)
dirt[: int(H * 0.55)] = False                                  # only the sand under the pile, not the glass
dirt = nd.binary_opening(dirt, iterations=2)
dist = np.stack([nd.distance_transform_edt(~p) for p in pieces]); owner = dist.argmin(0)   # each bit of disturbed sand belongs to its nearest piece
S = (1080 / 816) * (x1 - x0) / W                               # crop px -> art px
out = []
for k in range(len(pieces) + 1):
    m = np.zeros((H, W), bool)
    for j, p in enumerate(pieces[:k]): m |= p | (dirt & (owner == j))
    a = nd.gaussian_filter(nd.binary_dilation(m, iterations=1).astype(np.float32), 1.2)
    rgba = np.dstack([F, a])
    im = Image.fromarray((np.clip(rgba, 0, 1) * 255 + .5).astype(np.uint8), "RGBA").resize((round(W * S), round(H * S)), Image.LANCZOS)
    im.save(f"out_pile-{k}.webp", quality=86, method=6); out.append(im)
rect = {"x": round(x0 * 1080 / 816), "y": round(y0 * 1080 / 816), "w": out[0].width, "h": out[0].height}
json.dump(rect, open("pile_rect.json", "w")); print(rect)
sheet = Image.new("RGB", (7 * 260, 210), "white")
for k, im in enumerate(out):
    bg = Image.fromarray((E * 255).astype(np.uint8)).resize(im.size).convert("RGBA"); bg.alpha_composite(im); bg.thumbnail((250, 200)); sheet.paste(bg.convert("RGB"), (k * 260, 0))
sheet.save("pile_sheet.jpg", quality=88)
