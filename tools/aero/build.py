# One script for the Focus "Frutiger Aero" look: smooth sources in tools/aero/src -> dithered frames, glows, ambient GIFs,
# and the manifest the app reads (src/focus/aeroLook.js). Run from the repo root:  python3 tools/aero/build.py
#
# Every thing in the scene is a sequence of frames placed on a layer rect in scene coordinates (1080x1920; the background
# plate is 1080x2304 with the scene starting 192px down). Frame 0 = just done, last frame = due.
import os, json, glob, math, subprocess, tempfile, random
import numpy as np
from PIL import Image
from scipy import ndimage as nd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC, OUT = os.path.join(ROOT, "tools/aero/src"), os.path.join(ROOT, "assets/aero3")
CELL = 3                # one dither pixel = 3 scene px
PLATE_TOP = 192

def rgba(a):  # float RGBA (h, w, 4) in 0..1 -> Image
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA")

def video_frames(path):
    d = tempfile.mkdtemp(); subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, f"{d}/f%03d.png"], check=True)
    return sorted(glob.glob(f"{d}/f*.png"))

BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) / 16 + 1 / 32

def ordered(a):  # alpha (h, w) 0..1 -> 0/1 with a 4x4 ordered pattern: soft edges and shadows become retro stipple
    h, w = a.shape; t = np.tile(BAYER, (h // 4 + 1, w // 4 + 1))[:h, :w]
    return (a > t).astype(np.float32)

def dither_seq(frames, colours=48):
    """Shared palette for the whole sequence (no palette flicker), Floyd-Steinberg colour, ordered alpha, chunky pixels."""
    H, W = frames[0].shape[:2]; h, w = H // CELL, W // CELL
    small = [np.asarray(rgba(f).resize((w, h), Image.LANCZOS)).astype(np.float32) / 255 for f in frames]
    # palette from the visible pixels of every frame
    vis = np.concatenate([s[..., :3][s[..., 3] > 0.3] for s in small])[::3]
    side = int(math.ceil(math.sqrt(len(vis)))); pad = np.zeros((side * side, 3), np.float32); pad[:len(vis)] = vis; pad[len(vis):] = vis[0]
    pal = Image.fromarray((pad.reshape(side, side, 3) * 255).astype(np.uint8), "RGB").quantize(colours, method=Image.MEDIANCUT)
    out = []
    for s in small:
        a = s[..., 3]; rgb = s[..., :3] / np.maximum(a[..., None], 1e-3); rgb[a < 1e-3] = 0
        q = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), "RGB").quantize(palette=pal, dither=Image.FLOYDSTEINBERG).convert("RGB")
        al = Image.fromarray((ordered(np.clip((a - 0.3) / 0.4, 0, 1)) * 255).astype(np.uint8), "L")  # stipple only a thin edge band
        im = Image.merge("RGBA", (*q.split(), al)).resize((w * CELL, h * CELL), Image.NEAREST)
        c = Image.new("RGBA", (W, H), (0, 0, 0, 0)); c.paste(im, (0, 0)); out.append(c)
    return out

def hitbox(obj, inset=0.06):  # visible object -> [x, y, w, h] as fractions of the layer, a little inside the silhouette
    ys, xs = np.where(obj > 0.5); H, W = obj.shape
    if len(xs) == 0: return None                                   # nothing there yet (the empty pile): borrow a neighbour's
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max(); dx, dy = (x1 - x0) * inset, (y1 - y0) * inset
    return [round((x0 + dx) / W, 3), round((y0 + dy) / H, 3), round((x1 - x0 - 2 * dx) / W, 3), round((y1 - y0 - 2 * dy) / H, 3)]

def drop_matching(f, bgA, r):
    """Where a frame just repeats the photo behind it (sea seen through the edge of the glass, sand), let the photo show:
    the dithered copy of the sea would otherwise sit on the smooth sea as a visible patch."""
    y, x = r["y"] + PLATE_TOP, r["x"]; under = bgA[y:y + f.shape[0], x:x + f.shape[1]]
    comp = f[..., :3] * f[..., 3:] + under * (1 - f[..., 3:])
    d = nd.gaussian_filter(np.abs(comp - under).max(-1), 2)
    keep = np.clip((d - 0.035) / 0.04, 0, 1); g = f.copy(); g[..., 3] *= keep; return g

def fill_gaps(hits):
    for j in range(len(hits)):
        if hits[j] is None: hits[j] = next(h for h in hits[j:] + hits[::-1] if h)
    return hits

GLOW_PAD = 0.15
def glow(obj, tint=(255, 252, 225)):
    """A soft halo from the due frame's silhouette, on a canvas GLOW_PAD bigger each side, stippled like the rest."""
    H, W = obj.shape; py, px = int(H * GLOW_PAD), int(W * GLOW_PAD)
    a = np.zeros((H + 2 * py, W + 2 * px), np.float32); a[py:py + H, px:px + W] = obj
    r = max(6, 0.05 * max(H, W)); g = nd.gaussian_filter(a, r); g = np.clip(g / max(g.max(), 1e-3) * 1.4, 0, 1) * 0.85
    h, w = g.shape; sm = np.asarray(Image.fromarray((g * 255).astype(np.uint8)).resize((w // CELL, h // CELL), Image.LANCZOS)) / 255
    al = Image.fromarray((ordered(sm) * 255).astype(np.uint8)).resize(((w // CELL) * CELL, (h // CELL) * CELL), Image.NEAREST)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0)); im.paste(Image.merge("RGBA", (*[Image.new("L", al.size, c) for c in tint], al)), (0, 0)); return im

def load_rgba(f):
    return np.asarray(Image.open(f).convert("RGBA")).astype(np.float32) / 255

# ---------------------------------------------------------------- sources -> smooth RGBA frames on their layer
def water():  # glass filling: 25 smooth frames -> 13
    fs = sorted(glob.glob(f"{SRC}/water/wf-*.webp"))[::2]
    fr = [load_rgba(f) for f in fs]; return {"rect": {"x": 0, "y": 847, "w": 473, "h": 959}, "frames": fr, "obj": [f[..., 3] for f in fr]}

def pile():  # fruit added one piece at a time: 7 stop-motion frames
    fr = [load_rgba(f) for f in sorted(glob.glob(f"{SRC}/pile/pile-*.webp"))]
    return {"rect": {"x": 163, "y": 1329, "w": 744, "h": 579}, "frames": fr, "obj": [f[..., 3] for f in fr]}

def dolphin():  # turns away to leave: 18 -> 9
    fs = sorted(glob.glob(f"{SRC}/dolphin/out_d-*.webp")); fs = fs[::2] if len(fs) % 2 else fs[::2][:-1] + [fs[-1]]
    fr = [load_rgba(f) for f in fs]; return {"rect": {"x": 24, "y": 274, "w": 829, "h": 860}, "frames": fr, "obj": [f[..., 3] for f in fr]}

def turtle():  # flippers and head draw into the shell as stretch comes due (video shot on black: key out by brightness)
    fs = video_frames(f"{SRC}/turtle_withdraw.mp4")
    pick = [0, 12, 18, 24, 30, 36, 42, 48, 52, 56]
    raw = []
    for i in pick:
        p = np.asarray(Image.open(fs[i]).convert("RGB")).astype(np.float32) / 255
        L = p.max(-1); a = np.clip((L - 0.07) / 0.18, 0, 1); a = nd.binary_fill_holes(a > 0.5) * np.maximum(a, 0.0)
        a = np.maximum(a, nd.binary_fill_holes(a > 0.5) * 1.0); a = nd.gaussian_filter(a, 0.7)
        rgb = np.clip(p / np.maximum(a[..., None], 0.2), 0, 1); raw.append(np.dstack([rgb, a]))
    U = np.max([r[..., 3] for r in raw], 0) > 0.1; ys, xs = np.where(U); m = 4
    y0, y1, x0, x1 = ys.min() - m, ys.max() + m, xs.min() - m, xs.max() + m
    cx, cy, Wt = 770, 862, 270                                    # where the old still sat, about as wide
    k = Wt / (x1 - x0); Ht = round((y1 - y0) * k)
    fr = [np.asarray(rgba(r[y0:y1, x0:x1]).resize((Wt, Ht), Image.LANCZOS)).astype(np.float32) / 255 for r in raw]
    return {"rect": {"x": cx - Wt // 2, "y": cy - Ht // 2, "w": Wt, "h": Ht}, "frames": fr, "obj": [f[..., 3] for f in fr]}

def ball():
    """Beach ball: a deflate video played backwards, so it is fully inflated when bathroom is due. Cut out with SAM3
    masks (tools/aero/src/ball/m*.png), given a soft contact shadow, placed where the restroom pod stood."""
    fs = video_frames(f"{SRC}/ball_deflate.mp4")
    idx = [0, 6, 12, 17, 23, 29, 35, 41, 47, 52]                   # m00..m09 (the last two masks repeat m09)
    K = 0.983 * 0.85                                              # video px -> scene px, a touch smaller than the MJ ball
    anchor_v, anchor_s = (297, 655), (850, 1490)                  # inflated ball's bottom centre: video -> scene
    layers = []
    for j, i in enumerate(idx):
        p = np.asarray(Image.open(fs[i]).convert("RGB")).astype(np.float32) / 255
        m = np.asarray(Image.open(f"{SRC}/ball/m{j:02d}.png")).astype(np.float32) / 255
        m = nd.binary_opening(m > 0.5, iterations=2); lab, n = nd.label(m); m = lab == (np.argmax(nd.sum(m, lab, range(1, n + 1))) + 1)
        m = nd.gaussian_filter(nd.binary_fill_holes(m).astype(np.float32), 0.8)
        ys, xs = np.where(m > 0.5); bx = (xs[ys > ys.max() - 0.15 * (ys.max() - ys.min())]); bw = bx.max() - bx.min(); by = ys.max()
        layers.append((p, m, (bx.min() + bx.max()) / 2, by, bw))
    # scene canvas big enough for every frame plus its shadow
    S = np.zeros((1920, 1080, 4), np.float32); frames, objs = [], []
    for p, m, sx, sy, bw in layers:
        c = np.zeros_like(S); o = np.zeros(S.shape[:2], np.float32)
        tx, ty = anchor_s[0] - anchor_v[0] * K, anchor_s[1] - anchor_v[1] * K
        h, w = p.shape[:2]; W2, H2 = round(w * K), round(h * K); X, Y = round(tx), round(ty)
        pr = np.asarray(Image.fromarray((p * 255).astype(np.uint8)).resize((W2, H2), Image.LANCZOS)).astype(np.float32) / 255
        mr = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((W2, H2), Image.LANCZOS)).astype(np.float32) / 255
        # contact shadow: a squashed ellipse under the ball's footprint
        ex, ey, ew = X + sx * K, Y + sy * K - 4, bw * K * 0.55
        yy, xx = np.mgrid[0:1920, 0:1080]; e = ((xx - ex) / ew) ** 2 + ((yy - ey) / (ew * 0.16)) ** 2
        sh = nd.gaussian_filter((e < 1).astype(np.float32), ew * 0.08) * 0.5
        c[..., :3] = np.array([0.30, 0.26, 0.22]); c[..., 3] = sh
        ball_a = np.zeros(S.shape[:2], np.float32); ball_rgb = np.zeros((1920, 1080, 3), np.float32)
        y0, x0 = max(0, Y), max(0, X); y1, x1 = min(1920, Y + H2), min(1080, X + W2)
        ball_a[y0:y1, x0:x1] = mr[y0 - Y:y1 - Y, x0 - X:x1 - X]; ball_rgb[y0:y1, x0:x1] = pr[y0 - Y:y1 - Y, x0 - X:x1 - X]
        a = ball_a + c[..., 3] * (1 - ball_a); rgb = (ball_rgb * ball_a[..., None] + c[..., :3] * (c[..., 3] * (1 - ball_a))[..., None]) / np.maximum(a[..., None], 1e-4)
        frames.append(np.dstack([rgb, a])); objs.append(ball_a)
    frames, objs = frames[::-1], objs[::-1]                       # inflating as bathroom comes due
    U = np.max([f[..., 3] for f in frames], 0) > 0.02; ys, xs = np.where(U); y0, y1, x0, x1 = ys.min() - 3, ys.max() + 4, xs.min() - 3, min(1080, xs.max() + 4)
    return {"rect": {"x": int(x0), "y": int(y0), "w": int(x1 - x0), "h": int(y1 - y0)}, "frames": [f[y0:y1, x0:x1] for f in frames], "obj": [o[y0:y1, x0:x1] for o in objs]}

# ---------------------------------------------------------------- ambient life and sparkle
def gif(frames, out, ms):
    pal = [255, 0, 255, 255, 255, 255, 200, 236, 255, 255, 246, 190, 255, 214, 244, 150, 214, 255] + [0] * (256 * 3 - 18)
    ims = []
    for f in frames:
        im = Image.new("P", f.shape[::-1], 0); im.putpalette(pal); im.putdata(f.flatten().tolist()); ims.append(im.resize((f.shape[1] * CELL, f.shape[0] * CELL), Image.NEAREST))
    ims[0].save(out, save_all=True, append_images=ims[1:], duration=ms, loop=0, transparency=0, disposal=2, optimize=False)

def star(px, x, y, r, c):
    h, w = px.shape
    def put(a, b, v):
        if 0 <= a < w and 0 <= b < h: px[b, a] = v
    put(x, y, 1)
    for d in range(1, r + 1):
        v = c if d == r else 1
        for a, b in ((x + d, y), (x - d, y), (x, y + d), (x, y - d)): put(a, b, v)

def sparkle(out):
    """On whatever is due: a few small, thin four-point stars that twinkle in turn (more delicate than before)."""
    G, N = 64, 16; stars = [(14, 16, 5, 0, 2), (48, 12, 4, 6, 3), (50, 44, 6, 11, 2), (18, 50, 4, 4, 4), (33, 30, 3, 9, 3)]
    frames = []
    for f in range(N):
        px = np.zeros((G, G), np.uint8)
        for x, y, size, ph, c in stars:
            t = ((f + ph) % N) / N; k = math.sin(math.pi * t * 2) if t < 0.5 else 0
            if f == 0 and ph % 2 == 0: k = max(k, 0.6)
            r = int(round(size * k))
            if r >= 1: star(px, x, y, r, c)
        frames.append(px)
    gif(frames, out, 90)

def bright_points(plate, box, n, seed, thresh):
    x0, y0, x1, y1 = box; a = np.asarray(plate.convert("L")).astype(np.float32)[y0:y1, x0:x1]
    loc = (a == nd.maximum_filter(a, 9)) & (a > thresh); ys, xs = np.where(loc)
    random.seed(seed); idx = random.sample(range(len(xs)), min(n, len(xs))); return [(xs[i], ys[i]) for i in idx]

def life(plate):
    """Retro GIF loops laid over the photo: stars twinkling in the Milky Way, glints running along the water stream."""
    N = 24; boxes = {}
    # Milky Way (plate coords)
    box = (390, 0, 780, 720); pts = bright_points(plate, box, 110, 3, 120)
    w, h = (box[2] - box[0]) // CELL, (box[3] - box[1]) // CELL; frames = []
    random.seed(7); ph = [random.randrange(N) for _ in pts]; sz = [random.choice([0, 1, 1, 2, 2]) for _ in pts]; col = [random.choice([1, 2, 3, 4]) for _ in pts]
    for f in range(N):
        px = np.zeros((h, w), np.uint8)
        for (x, y), p, s, c in zip(pts, ph, sz, col):
            t = ((f + p) % N) / N
            if t < 0.45: star(px, x // CELL, y // CELL, int(round(s * math.sin(math.pi * t / 0.45))), c)
        frames.append(px)
    gif(frames, f"{OUT}/life_stars.gif", 110); boxes["stars"] = {"x": box[0], "y": box[1] - PLATE_TOP, "w": w * CELL, "h": h * CELL}
    # water stream (plate coords): glints pop on the brightest highlights, a few at a time
    box = (0, 640, 1080, 1060); pts = bright_points(plate, box, 120, 11, 225)
    w, h = (box[2] - box[0]) // CELL, (box[3] - box[1]) // CELL; frames = []
    random.seed(9); ph = [random.randrange(N) for _ in pts]
    for f in range(N):
        px = np.zeros((h, w), np.uint8)
        for (x, y), p in zip(pts, ph):
            t = ((f + p) % N) / N
            if t < 0.25: star(px, x // CELL, y // CELL, 2 if 0.09 < t < 0.16 else 1 if 0.03 < t < 0.22 else 0, 2)
        frames.append(px)
    gif(frames, f"{OUT}/life_shimmer.gif", 90); boxes["shimmer"] = {"x": box[0], "y": box[1] - PLATE_TOP, "w": w * CELL, "h": h * CELL}
    return boxes

def plate():
    """The background, minus the restroom pod's shadow baked into the sand (the beach ball brings its own)."""
    im = Image.open(f"{SRC}/bg_plate.jpg").convert("RGB"); a = np.asarray(im).astype(np.float32)
    y0, y1, x0, x1 = 1606, 1724, 540, 1080
    top, bot = nd.uniform_filter1d(a[y0 - 6:y0, x0:x1].mean(0), 25, axis=0), nd.uniform_filter1d(a[y1:y1 + 6, x0:x1].mean(0), 25, axis=0)
    t = np.linspace(0, 1, y1 - y0)[:, None, None]; fill = top[None] * (1 - t) + bot[None] * t
    tex = a[y0 - 130:y1 - 130, x0:x1] - nd.uniform_filter(a[y0 - 130:y1 - 130, x0:x1], (9, 9, 1))   # keep the sand grain
    blend = np.minimum(1, np.minimum(np.arange(x1 - x0), (x1 - x0) - np.arange(x1 - x0)) / 30)[None, :, None]
    a[y0:y1, x0:x1] = a[y0:y1, x0:x1] * (1 - blend) + (fill + tex) * blend
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)); out.save(f"{OUT}/bg.jpg", quality=90); return out

# ---------------------------------------------------------------- build
THINGS = {  # key: (builder, file prefix, extra manifest fields)
    "walk": (dolphin, "walk", {"bob": 6, "sway": 1.2, "lift": True, "spark": [0.68, 0.6, 0.21]}),
    "stretch": (turtle, "stretch", {"bob": 4, "rise": 620, "spark": [0.5, 0.5, 0.9]}),
    "bathroom": (ball, "bath", {"spark": [0.5, 0.4, 0.6]}),
    "water": (water, "water", {"spark": [0.4, 0.45, 0.57]}),
    "eat": (pile, "eat", {"spark": [0.52, 0.42, 0.42]}),
}

def main():
    for f in glob.glob(f"{OUT}/*"): os.remove(f)
    bg = plate(); bgA = np.asarray(bg).astype(np.float32) / 255; sparkle(f"{OUT}/sparkle.gif"); life_boxes = life(bg)
    man = {"size": [1080, 1920], "plate": [1080, 2304], "plateTop": PLATE_TOP, "glowPad": GLOW_PAD,
           "order": ["stretch", "walk", "bathroom", "water", "eat"], "touch": ["walk", "bathroom", "water", "eat", "stretch"],
           "life": life_boxes, "things": {}}
    for key, (fn, pre, extra) in THINGS.items():
        t = fn(); t["frames"] = [drop_matching(f, bgA, t["rect"]) for f in t["frames"]]; fr = dither_seq(t["frames"])
        names = []
        for j, im in enumerate(fr):
            n = f"{pre}-{j:02d}.webp"; im.save(f"{OUT}/{n}", lossless=True, method=6); names.append(n)
        glow(t["obj"][-1]).save(f"{OUT}/{pre}-glow.webp", lossless=True, method=6)
        man["things"][key] = {"rect": t["rect"], "frames": names, "glow": f"{pre}-glow.webp", "hit": fill_gaps([hitbox(o) for o in t["obj"]]), **extra}
        print(key, len(names), t["rect"])
    write_js(man)

def write_js(man):
    req = lambda n: f'require("../../assets/aero3/{n}")'
    L = ["// Generated by tools/aero/build.py: do not edit by hand. The Frutiger Aero look: where each thing sits on the",
         "// scene (1080x1920), its frames (done -> due), its glow, and its touch boxes ([x, y, w, h] fractions, one per frame).",
         "export const AERO_LOOK = {",
         f"  size: {json.dumps(man['size'])}, plate: {json.dumps(man['plate'])}, plateTop: {man['plateTop']}, glowPad: {man['glowPad']},",
         f'  bg: {req("bg.jpg")}, sparkle: {req("sparkle.gif")},',
         f"  order: {json.dumps(man['order'])}, touch: {json.dumps(man['touch'])},",
         "  life: {"]
    for k, b in man["life"].items(): L.append(f'    {k}: {{ src: {req("life_" + k + ".gif")}, ...{json.dumps(b)} }},')
    L.append("  },"); L.append("  things: {")
    for k, t in man["things"].items():
        extra = {x: t[x] for x in t if x not in ("rect", "frames", "glow", "hit")}
        L.append(f"    {k}: {{")
        L.append(f"      rect: {json.dumps(t['rect'])}, ...{json.dumps(extra)},")
        L.append(f"      glow: {req(t['glow'])},")
        L.append("      frames: [" + ", ".join(req(n) for n in t["frames"]) + "],")
        L.append(f"      hit: {json.dumps(t['hit'])},")
        L.append("    },")
    L.append("  },"); L.append("};")
    p = os.path.join(ROOT, "src/focus/aeroLook.js"); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write("\n".join(L) + "\n")

if __name__ == "__main__":
    main()
