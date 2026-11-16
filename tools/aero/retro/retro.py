# The retro touch for the Focus scene.
#   sparkle: a looping GIF of twinkling four-point stars (1-bit transparency, chunky pixels), shown on whatever is due.
#   dither:  give cut-out frames the GIF look: a small colour palette with visible dithering, hard edges, chunky pixels.
# Usage: python3 retro.py sparkle <out.gif> | python3 retro.py dither <out_dir> <prefix> <frame.webp>...
import sys, os, math, random
from PIL import Image

def sparkle(out):
    G, UP, N = 72, 3, 16                      # grid, upscale, frames
    random.seed(5)
    stars = [(14, 15, 13, 0, 0), (54, 12, 9, 5, 1), (56, 42, 14, 10, 0), (20, 54, 10, 3, 2), (36, 32, 7, 8, 1), (10, 36, 6, 12, 2), (44, 62, 8, 14, 0)]  # x, y, size, phase, colour
    cols = [((255, 255, 255), (190, 240, 255)), ((255, 255, 255), (255, 244, 170)), ((255, 255, 255), (255, 200, 240))]
    frames = []
    for f in range(N):
        im = Image.new("P", (G, G), 0); im.putpalette([255, 0, 255] + [255, 255, 255, 190, 240, 255, 255, 244, 170, 255, 200, 240] + [0] * (256 * 3 - 15))
        px = im.load()
        for x, y, size, ph, c in stars:
            t = ((f + ph) % N) / N; k = math.sin(math.pi * min(1, t * 2)) if t < 0.5 else 0   # twinkle for half the loop
            if f == 0: k = max(k, 0.6 if ph % 2 == 0 else 0)                                   # frame 0 reads fine as a still
            r = int(round(size * k))
            if r < 1: continue
            tint = 2 + c
            for d in range(-r, r + 1):
                w = 1 if abs(d) > r * 0.45 else 2                                             # long thin arms
                for e in range(-w + 1, w):
                    for (ax, ay) in ((x + d, y + e), (x + e, y + d)):
                        if 0 <= ax < G and 0 <= ay < G: px[ax, ay] = tint if abs(d) > r * 0.5 else 1
            for d in range(-r // 3, r // 3 + 1):                                              # short diagonals
                for (ax, ay) in ((x + d, y + d), (x + d, y - d)):
                    if 0 <= ax < G and 0 <= ay < G: px[ax, ay] = 1
        frames.append(im.resize((G * UP, G * UP), Image.NEAREST))
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=90, loop=0, transparency=0, disposal=2, optimize=False)
    print(out, os.path.getsize(out), "bytes")

def dither(out_dir, prefix, files, cell=3, colours=20):
    for j, f in enumerate(files):
        im = Image.open(f).convert("RGBA"); W, H = im.size
        small = im.resize((W // cell, H // cell), Image.LANCZOS)
        a = small.getchannel("A").point(lambda v: 255 if v > 110 else 0)                       # hard edge, like GIF transparency
        rgb = small.convert("RGB").quantize(colours, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).convert("RGB")
        o = Image.merge("RGBA", (*rgb.split(), a)).resize(((W // cell) * cell, (H // cell) * cell), Image.NEAREST)
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0)); canvas.paste(o, (0, 0))
        canvas.save(os.path.join(out_dir, f"{prefix}{j:02d}.webp"), lossless=True, method=6)

if __name__ == "__main__":
    if sys.argv[1] == "sparkle": sparkle(sys.argv[2])
    else: dither(sys.argv[2], sys.argv[3], sys.argv[4:])
