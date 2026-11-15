# Focus · Frutiger Aero art

The Aero focus scene is one three.js world, pre-rendered.

- `scene4.html` builds the world (sky, clouds, sea, beach, islands) and the five needs; `window.renderFrame({need: level})`.
- `render4.js <out> full [ss]` renders the empty world, each need alone at 0–100%, and the gull/fish sprites (headless Chromium + swiftshader).
- `pack4.py <out> <pack>` runs `post.py` (bloom, sun rays, lens ghosts, grade, vignette) on every frame and cuts each need out where it differs from the empty world, writing cropped layers plus `manifest.json`.
- Earth textures (NASA Blue Marble, public domain) come from the `three-globe` npm package's example images, copied into `tex/`.

Then convert the layer PNGs to .webp, copy into `assets/aero3/`, and paste the manifest into `AERO` in App.js.

## Photographed water

Splashes and streams are photographs shot on black (`photo/`), not modeled. After `pack4.py`, lay one into the background:
`python3 photo/water_overlay.py pack/bg.jpg photo/stream.png pack/bg.jpg 560 -88 1100 1012` (x, y, height, horizon y).
It screens the water's light over the scene, bends and deepens what's behind it, and adds foam where it meets the sea.
