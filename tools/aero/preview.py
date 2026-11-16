# Preview the built look: the scene with every thing at a given fill (0..1), as the app would place it.
#   python3 tools/aero/preview.py <fill> <out.jpg> [glow]
import sys, re, json
from PIL import Image
A = "assets/aero3/"; js = open("src/focus/aeroLook.js").read()
f, out = float(sys.argv[1]), sys.argv[2]
bg = Image.open(A + "bg.jpg").convert("RGBA"); top = 192
order = json.loads(re.search(r"order: (\[[^\]]*\])", js).group(1))
for k in order:
    blk = js[js.index(f"    {k}: {{"):]; blk = blk[:blk.index("\n    },")]
    r = json.loads(re.search(r"rect: (\{[^}]*\})", blk).group(1)); fr = re.findall(r'aero3/([a-z]+-\d\d\.webp)', blk)
    im = Image.open(A + fr[round(f * (len(fr) - 1))]).convert("RGBA").resize((r["w"], r["h"]))
    if len(sys.argv) > 3 and f >= 1:
        g = Image.open(A + re.search(r'aero3/([a-z]+-glow\.webp)', blk).group(1)).convert("RGBA"); pw, ph = round(r["w"] * .15), round(r["h"] * .15)
        bg.alpha_composite(g.resize((r["w"] + 2 * pw, r["h"] + 2 * ph)), (r["x"] - pw, r["y"] + top - ph))
    bg.alpha_composite(im, (r["x"], r["y"] + top))
bg.convert("RGB").crop((0, top, 1080, top + 1920)).save(out, quality=88)
