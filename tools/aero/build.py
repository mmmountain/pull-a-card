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
    y, x = r["y"] + PLATE_TOP, r["x"]; P = 200                     # pad: a layer may hang off the edge of the scene
    padded = np.pad(bgA, ((P, P), (P, P), (0, 0)), mode="edge"); under = padded[y + P:y + P + f.shape[0], x + P:x + P + f.shape[1]]
    comp = f[..., :3] * f[..., 3:] + under * (1 - f[..., 3:])
    d = nd.gaussian_filter(np.abs(comp - under).max(-1), 2)
    keep = np.clip((d - 0.035) / 0.04, 0, 1); g = f.copy(); g[..., 3] *= keep; return g

EDITS = os.path.join(SRC, "edits")
def export_and_override(key, t):
    """Hand-editing: every smooth frame (before dithering) is written to /tmp/aero-frames/<thing>/NN.png. A PNG of the
    same size dropped in tools/aero/src/edits/<thing>/NN.png replaces that frame on the next build."""
    out = f"/tmp/aero-frames/{key}"; os.makedirs(out, exist_ok=True)
    for j, f in enumerate(t["frames"]):
        rgba(f).save(f"{out}/{j:02d}.png")
        e = f"{EDITS}/{key}/{j:02d}.png"
        if os.path.exists(e):
            g = load_rgba(e)
            if g.shape != f.shape: g = np.asarray(rgba(g).resize((f.shape[1], f.shape[0]), Image.LANCZOS)).astype(np.float32) / 255
            t["frames"][j] = g; t["obj"][j] = g[..., 3]; print("  edited:", key, j)

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
    # The frames came out of the photo with a ragged patch of sea and sand around the glass: keep only the glass and
    # lime (SAM3 mask, src/water/mask.png) and give it a clean contact shadow on the sand instead.
    m = nd.gaussian_filter((np.asarray(Image.open(f"{SRC}/water/mask.png")) > 127).astype(np.float32), 1.0)
    ys, xs = np.where(m > 0.5); base = ys.max(); foot = xs[ys > base - 30]; cx, ew = (foot.min() + foot.max()) / 2, (foot.max() - foot.min()) * 0.62
    yy, xx = np.mgrid[0:m.shape[0], 0:m.shape[1]]
    sh = nd.gaussian_filter((((xx - cx) / ew) ** 2 + ((yy - base + 8) / (ew * 0.2)) ** 2 < 1).astype(np.float32), ew * 0.1) * 0.45
    fr = []
    for f in fs:
        a = load_rgba(f); ga = a[..., 3] * m; al = ga + sh * (1 - ga)
        rgb = (a[..., :3] * ga[..., None] + np.array([0.30, 0.27, 0.24]) * (sh * (1 - ga))[..., None]) / np.maximum(al[..., None], 1e-4)
        fr.append(np.dstack([rgb, al]))
    return {"rect": {"x": 0, "y": 847, "w": 473, "h": 959}, "frames": fr, "obj": [f[..., 3] * m for f in [load_rgba(x) for x in fs]]}

def pile():  # fruit added one piece at a time: 7 stop-motion frames
    fr = [load_rgba(f) for f in sorted(glob.glob(f"{SRC}/pile/pile-*.webp"))]
    return {"rect": {"x": 163, "y": 1329, "w": 744, "h": 579}, "frames": fr, "obj": [f[..., 3] for f in fr]}

def dolphin():
    """Turns away to leave as walk comes due: every usable frame of the generated video (on black, keyed by brightness),
    skipping the few where the tail leaves the frame. Frame 0 is the original sharp photo, exactly where the video starts."""
    from PIL import ImageFilter
    fs = video_frames(f"{SRC}/dolphin_turn.mp4"); pick = [i for i in range(len(fs)) if not 25 <= i <= 31]
    def matte(v):
        core = nd.binary_opening(v > 0.07, iterations=1); lab, n = nd.label(core)
        keep = lab == (np.argmax(nd.sum(core, lab, range(1, n + 1))) + 1); keep = nd.binary_fill_holes(nd.binary_closing(keep, iterations=3))
        soft = nd.gaussian_filter(keep.astype(np.float32), 0.8); edge = np.clip((v - 0.02) / 0.07, 0, 1)
        return np.where(soft > 0.99, 1.0, np.minimum(soft, np.maximum(edge, soft * 0.6)))
    F = [np.asarray(Image.open(fs[i]).convert("RGB")).astype(np.float32) / 255 for i in pick]; A = [matte(f.max(-1)) for f in F]
    u = np.any([a > 0.03 for a in A], axis=0); ys, xs = np.where(u)
    X0, X1, Y0, Y1 = max(0, xs.min() - 4), min(640, xs.max() + 5), max(0, ys.min() - 4), min(640, ys.max() + 5)
    ys0, xs0 = np.where(A[0] > 0.5); k = 380 / (xs0.max() - xs0.min())   # frame 0 -> the photo's rect (330, 520, 380x338)
    ax, ay = 330 - (xs0.min() - X0) * k, 520 - (ys0.min() - Y0) * k; Wc, Hc = round((X1 - X0) * k), round((Y1 - Y0) * k)
    fr = []
    for j, (f, a) in enumerate(zip(F, A)):
        rgb = np.clip(f / np.maximum(a[..., None], 0.05), 0, 1)
        im = Image.fromarray((np.dstack([rgb, a])[Y0:Y1, X0:X1] * 255 + .5).astype(np.uint8), "RGBA").resize((Wc, Hc), Image.LANCZOS)
        im = Image.merge("RGBA", (*im.convert("RGB").filter(ImageFilter.UnsharpMask(2, 60, 2)).split(), im.getchannel("A")))
        if j == 0:
            im = Image.new("RGBA", (Wc, Hc), (0, 0, 0, 0)); d = Image.open(f"{SRC}/dolphin_still.webp").convert("RGBA").resize((380, 338), Image.LANCZOS)
            im.alpha_composite(d, (round(330 - ax), round(520 - ay)))
        fr.append(np.asarray(im).astype(np.float32) / 255)
    return {"rect": {"x": round(ax) - 90, "y": round(ay), "w": Wc, "h": Hc}, "frames": fr, "obj": [f[..., 3] for f in fr]}  # nudged left of where the photo had it

def turtle():
    """Stretch: the turtle draws its head and flippers into its shell as stretch comes due. Not a generated video (those
    morphed the shell): the photo is split into parts with SAM3 masks (src/turtle_*.png) and each part slides in under
    the shell and shrinks, staggered, so the shell itself never changes."""
    src = np.asarray(Image.open(f"{SRC}/turtle_src.webp").convert("RGB")).astype(np.float32) / 255
    L = src.max(-1); alpha = nd.gaussian_filter(nd.binary_fill_holes(L > 0.08).astype(np.float32), 0.7)
    mk = lambda k: nd.gaussian_filter((np.asarray(Image.open(f"{SRC}/turtle_{k}.png")) > 127).astype(np.float32), 0.7)
    shell = mk("sh"); parts = {k: mk(k) for k in ("f1", "f2", "f3", "hd")}
    # The head and flippers hid bits of the shell's rim in the photo: complete the shell to its convex outline and fill
    # the missing rim by diffusing the nearby shell colour in (normalized blur), so nothing is bitten out once they go.
    from skimage.morphology import convex_hull_image
    hull = nd.gaussian_filter(convex_hull_image(shell > 0.5).astype(np.float32), 0.7)
    have = ((alpha > 0.5) & (sum(parts.values()) < 0.5)).astype(np.float32); fill = src.copy()   # photo pixels that aren't a limb
    for r in (2, 4, 8, 16):
        num = nd.gaussian_filter(src * have[..., None], (r, r, 0)); den = nd.gaussian_filter(have, r)[..., None]
        fill = np.where(((have < 0.5)[..., None]) & (den > 1e-3), num / np.maximum(den, 1e-6), fill)
        have = np.maximum(have, (den[..., 0] > 0.05).astype(np.float32))
    own = ((alpha > 0.5) & (sum(parts.values()) < 0.5))[..., None]
    shell_rgb = np.where(own, src, fill); shell = np.maximum(hull, shell)
    skin = np.clip(alpha - shell - sum(parts.values()), 0, 1); skin = nd.gaussian_filter(nd.binary_opening(skin > 0.5, iterations=2).astype(np.float32), 0.7)
    # The underside: the skin and plastron right under the shell's rim stays put (only the neck beyond it goes in with the
    # head), completed to a solid outline and filled where the flippers had covered it, so the shell has a bottom.
    near = nd.distance_transform_edt(shell < 0.5) < 40
    belly_own = (skin > 0.5) & near
    belly = nd.gaussian_filter(convex_hull_image((shell > 0.5) | belly_own).astype(np.float32), 0.7)
    have = belly_own.astype(np.float32); bfill = src.copy()
    for r in (2, 4, 8, 16, 32):
        num = nd.gaussian_filter(src * have[..., None], (r, r, 0)); den = nd.gaussian_filter(have, r)[..., None]
        bfill = np.where(((have < 0.5)[..., None]) & (den > 1e-3), num / np.maximum(den, 1e-6), bfill)
        have = np.maximum(have, (den[..., 0] > 0.05).astype(np.float32))
    belly_rgb = np.where(belly_own[..., None], src, bfill)
    skin = skin * (1 - belly_own)                                  # what's left of the skin is the neck: it goes in with the head
    cen = lambda m: np.array(nd.center_of_mass(m > 0.5))
    C = cen(shell)
    # when each part starts and finishes tucking in (0..1 of the way to due), and how far it goes toward the shell's centre
    timing = {"f2": (0.0, 0.55, 0.95), "f3": (0.1, 0.65, 0.95), "hd": (0.25, 0.8, 0.9), "f1": (0.35, 0.9, 1.0), "skin": (0.25, 0.8, 0.9)}
    ease = lambda x: x * x * (3 - 2 * x)
    def place(rgb, m, k, T):
        t0, t1, reach = timing[k]; u = ease(np.clip((T - t0) / (t1 - t0), 0, 1))
        c = cen(m); d = (C - c) * reach * u; sc = 1 - 0.45 * u
        # move and shrink about the part's own centre: out(y) = c + d + (y - c) * sc  ->  in(y) = c + (y - c - d) / sc
        mat = np.eye(2) / sc; off = c - (c + d) / sc
        warp = lambda ch: nd.affine_transform(ch, mat, offset=off, order=1)
        return np.dstack([warp(rgb[..., i] * m) for i in range(3)]), warp(m)
    def over(dst_rgb, dst_a, rgb_pm, a):  # premultiplied "over"
        return rgb_pm + dst_rgb * (1 - a[..., None]), a + dst_a * (1 - a)
    ys, xs = np.where(alpha > 0.05); y0, y1, x0, x1 = ys.min() - 6, ys.max() + 7, xs.min() - 6, xs.max() + 7
    fr = []
    for T in np.linspace(0, 1, 16):
        rgb, a = np.zeros_like(src), np.zeros(L.shape, np.float32)
        for k in ("f1", "skin", "f2", "f3", "hd"):            # back to front, all under the shell
            pm, pa = place(src, skin if k == "skin" else parts[k], k, T); rgb, a = over(rgb, a, pm, pa)
        rgb, a = over(rgb, a, belly_rgb * belly[..., None], belly)
        rgb, a = over(rgb, a, shell_rgb * shell[..., None], shell)
        out = np.dstack([rgb / np.maximum(a[..., None], 1e-4), a])[y0:y1, x0:x1]; fr.append(out)
    cx, cy, Wt = 840, 870, 380
    Ht = round((y1 - y0) * Wt / (x1 - x0))
    fr = [np.asarray(rgba(f).resize((Wt, Ht), Image.LANCZOS)).astype(np.float32) / 255 for f in fr]
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
def gif(frames, out, ms, cell=CELL):
    pal = [255, 0, 255, 255, 255, 255, 200, 236, 255, 255, 246, 190, 255, 214, 244, 150, 214, 255] + [0] * (256 * 3 - 18)
    ims = []
    for f in frames:
        im = Image.new("P", f.shape[::-1], 0); im.putpalette(pal); im.putdata(f.flatten().tolist()); ims.append(im.resize((f.shape[1] * cell, f.shape[0] * cell), Image.NEAREST))
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
    G, N = 64, 16; stars = [(14, 16, 3, 0, 2), (48, 12, 3, 6, 3), (50, 44, 4, 11, 2), (18, 50, 3, 4, 4), (33, 30, 2, 9, 3)]
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
    box = (390, 0, 780, 720); pts = bright_points(plate, box, 110, 3, 120); C2 = 2   # finer pixels than the rest: stars stay tiny
    w, h = (box[2] - box[0]) // C2, (box[3] - box[1]) // C2; frames = []
    random.seed(7); ph = [random.randrange(N) for _ in pts]; sz = [random.choice([0, 0, 0, 1]) for _ in pts]; col = [random.choice([1, 2, 3, 4]) for _ in pts]
    for f in range(N):
        px = np.zeros((h, w), np.uint8)
        for (x, y), p, s, c in zip(pts, ph, sz, col):
            t = ((f + p) % N) / N
            if t < 0.45: star(px, x // C2, y // C2, int(round(s * math.sin(math.pi * t / 0.45))), c)
        frames.append(px)
    gif(frames, f"{OUT}/life_stars.gif", 110, C2); boxes["stars"] = {"x": box[0], "y": box[1] - PLATE_TOP, "w": w * C2, "h": h * C2}
    # water stream (plate coords): glints pop on the brightest highlights, a few at a time
    box = (0, 640, 1080, 1060); pts = bright_points(plate, box, 7, 11, 225); NS = 64   # a long loop, mostly empty
    w, h = (box[2] - box[0]) // CELL, (box[3] - box[1]) // CELL; frames = []
    random.seed(9); ph = random.sample(range(0, NS, NS // len(pts)), len(pts))
    for f in range(NS):
        px = np.zeros((h, w), np.uint8)
        for (x, y), p in zip(pts, ph):
            t = (f + p) % NS
            if t < 5: star(px, x // CELL, y // CELL, [0, 1, 2, 1, 0][t], 2)
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
    "walk": (dolphin, "walk", {"reverse": True, "bob": 6, "sway": 1.2, "lift": True, "spark": [0.6, 0.48, 0.3]}),
    "stretch": (turtle, "stretch", {"colours": 96, "bob": 4, "rise": 620, "spark": [0.5, 0.5, 0.65]}),
    "bathroom": (ball, "bath", {"spark": [0.5, 0.4, 0.45]}),
    "water": (water, "water", {"spark": [0.4, 0.45, 0.42]}),
    "eat": (pile, "eat", {"spark": [0.52, 0.42, 0.32]}),
}

def main():
    for f in glob.glob(f"{OUT}/*"): os.remove(f)
    bg = plate(); bgA = np.asarray(bg).astype(np.float32) / 255; sparkle(f"{OUT}/sparkle.gif"); life_boxes = life(bg)
    man = {"size": [1080, 1920], "plate": [1080, 2304], "plateTop": PLATE_TOP, "glowPad": GLOW_PAD,
           "order": ["stretch", "walk", "bathroom", "water", "eat"], "touch": ["walk", "bathroom", "water", "eat", "stretch"],
           "life": life_boxes, "things": {}}
    for key, (fn, pre, extra) in THINGS.items():
        t = fn()
        if extra.pop("reverse", False): t["frames"], t["obj"] = t["frames"][::-1], t["obj"][::-1]   # play the clip backwards
        export_and_override(key, t)
        t["frames"] = [drop_matching(f, bgA, t["rect"]) for f in t["frames"]]; fr = dither_seq(t["frames"], extra.pop("colours", 48))
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
