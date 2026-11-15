# Walk: the dolphin turning away to leave. Frames from a generated video on black, cut out by luminance, lined up so
# frame 0 is the original sharp photo exactly where it sits in the scene.
import numpy as np, glob, json
from PIL import Image, ImageFilter
from scipy import ndimage as nd
fs = sorted(glob.glob("fr3/*.png"))
pick = [0, 3, 6, 9, 12, 15, 18, 21, 24, 32, 36, 40, 44, 48, 52, 56, 60, 64]   # skip the few frames whose tail leaves the frame
def matte(im):
    v = im.max(-1); core = nd.binary_opening(v > 0.07, iterations=1)
    lab, n = nd.label(core); sizes = nd.sum(core, lab, range(1, n + 1)); keep = lab == (np.argmax(sizes) + 1)
    keep = nd.binary_fill_holes(nd.binary_closing(keep, iterations=3))
    soft = nd.gaussian_filter(keep.astype(np.float32), 0.8); edge = np.clip((v - 0.02) / 0.07, 0, 1)
    return np.where(soft > 0.99, 1.0, np.minimum(soft, np.maximum(edge, soft * 0.6)))
F = [np.asarray(Image.open(fs[i]).convert("RGB")).astype(np.float32) / 255 for i in pick]
A = [matte(f) for f in F]
u = np.any([a > 0.03 for a in A], axis=0); ys, xs = np.where(u); X0, X1, Y0, Y1 = max(0, xs.min() - 4), min(640, xs.max() + 5), max(0, ys.min() - 4), min(640, ys.max() + 5)
# align: frame 0's dolphin box -> the original dolphin's rect in the scene (330, 520, 380 x 338)
ys0, xs0 = np.where(A[0] > 0.5); k = 380 / (xs0.max() - xs0.min())
ax, ay = 330 - (xs0.min() - X0) * k, 520 - (ys0.min() - Y0) * k
Wc, Hc = round((X1 - X0) * k), round((Y1 - Y0) * k)
rect = {"x": round(ax), "y": round(ay), "w": Wc, "h": Hc}
for j, (f, a) in enumerate(zip(F, A)):
    rgb = np.clip(f / np.maximum(a[..., None], 0.05), 0, 1)
    im = Image.fromarray((np.dstack([rgb, a])[Y0:Y1, X0:X1] * 255 + .5).astype(np.uint8), "RGBA").resize((Wc, Hc), Image.LANCZOS)
    im = Image.merge("RGBA", (*im.convert("RGB").filter(ImageFilter.UnsharpMask(2, 60, 2)).split(), im.getchannel("A")))
    if j == 0:   # the original sharp photo, exactly where the video starts
        im = Image.new("RGBA", (Wc, Hc), (0, 0, 0, 0)); d = Image.open("/home/claude/pull-a-card/assets/aero3/dolphin.webp").convert("RGBA").resize((380, 338), Image.LANCZOS)
        im.alpha_composite(d, (round(330 - ax), round(520 - ay)))
    im.save(f"out_d-{j:02d}.webp", quality=86, method=6)
json.dump(rect, open("d_rect.json", "w")); print(rect, len(pick))
sky = Image.new("RGBA", (Wc, Hc), (30, 110, 220, 255)); sh = Image.new("RGB", (6 * 240, 260), "white")
for i, j in enumerate([0, 3, 6, 9, 13, 17]):
    s = sky.copy(); s.alpha_composite(Image.open(f"out_d-{j:02d}.webp")); s.thumbnail((230, 260)); sh.paste(s.convert("RGB"), (i * 240, 0))
sh.save("d_sheet.jpg", quality=88)
