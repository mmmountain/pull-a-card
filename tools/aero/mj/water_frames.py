# Water fill frames for the app: the Wan fill video, sharpened by taking everything that doesn't change from the
# full-resolution stills (Kontext empty glass, then glass 3), cut to the glass and its shadow, mapped into the scene.
import numpy as np, glob, json
from PIL import Image
from scipy import ndimage as nd
fs = sorted(glob.glob("fill2frames/*.png")); V = [np.asarray(Image.open(f).convert("RGB")).astype(np.float32) / 255 for f in fs]
E = np.asarray(Image.open("glass_empty.webp").convert("RGB").resize((840, 1520), Image.LANCZOS)).astype(np.float32) / 255
Fh = np.asarray(Image.open("/home/claude/pull-a-card/tools/aero/mj/glass3_crop.png").convert("RGB")).astype(np.float32) / 255
up = lambda a: np.asarray(Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).resize((840, 1520), Image.LANCZOS)).astype(np.float32) / 255
V0, VN = up(V[0]), up(V[-1])
# scene alpha: glass + shadow, in glass3_crop space (840x1520 = 2x the 420x760 crop at (0,640) of the 816 frame)
P = np.asarray(Image.open("plate_816.png").convert("RGB")).astype(np.float32) / 255
G = np.asarray(Image.open("glass3_full.jpg").convert("RGB")).astype(np.float32) / 255
d = nd.gaussian_filter(np.abs(G - P).max(-1), 2)[640:1400, 0:420]
m = nd.binary_fill_holes(nd.binary_closing(d > 0.05, iterations=6)); m = nd.binary_dilation(m, iterations=4)
lab, n = nd.label(m); sizes = nd.sum(m, lab, range(1, n + 1)); m = lab == (np.argmax(sizes) + 1)
A = np.asarray(Image.fromarray((nd.gaussian_filter(m.astype(np.float32), 3) * 255).astype(np.uint8)).resize((840, 1520), Image.LANCZOS)).astype(np.float32) / 255
N = 25; idx = np.linspace(2, len(V) - 1, N).round().astype(int); out = []
for k, i in enumerate(idx):
    t = k / (N - 1); Vi = up(V[i])
    base = E * (1 - t) + Fh * t if False else (E if t < 0.5 else Fh)
    ch = nd.gaussian_filter(np.abs(Vi - (V0 if t < 0.5 else VN)).max(-1), 3)
    w = np.clip((ch - 0.03) / 0.06, 0, 1)[..., None]           # where the video differs from the still: take the video
    img = base * (1 - w) + Vi * w
    if k == 0: img = E
    if k == N - 1: img = Fh
    out.append(img)
ys, xs = np.where(A > 0.02); y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
S = (1080 / 816) / 2   # glass3_crop px -> art px
W, H = round((x1 - x0) * S), round((y1 - y0) * S)
for k, img in enumerate(out):
    rgba = np.dstack([img, A])[y0:y1, x0:x1]
    Image.fromarray((np.clip(rgba, 0, 1) * 255 + .5).astype(np.uint8), "RGBA").resize((W, H), Image.LANCZOS).save(f"out/wf-{k:02d}.webp", quality=84, method=6)
rect = {"x": round(x0 * S), "y": round((640 * 2 + y0) * S), "w": W, "h": H}; json.dump(rect, open("out/wf_rect.json", "w")); print(rect)
sheet = Image.new("RGB", (9 * 130, 260), "white")
for j, k in enumerate(range(0, 25, 3)):
    im = Image.open(f"out/wf-{k:02d}.webp").convert("RGBA"); bg = Image.new("RGBA", im.size, (235, 230, 220, 255)); bg.alpha_composite(im); bg.thumbnail((125, 255)); sheet.paste(bg.convert("RGB"), (j * 130, 0))
sheet.save("wf_sheet.jpg", quality=88)
