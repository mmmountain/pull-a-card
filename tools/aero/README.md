# Focus · Frutiger Aero art

The Aero focus scene is one three.js world, pre-rendered.

- `scene4.html` builds the world (sky, clouds, sea, beach, islands) and the five needs; `window.renderFrame({need: level})`.
- `render4.js <out> full [ss]` renders the empty world, each need alone at 0–100%, and the gull/fish sprites (headless Chromium + swiftshader).
- `pack4.py <out> <pack>` runs `post.py` (bloom, sun rays, lens ghosts, grade, vignette) on every frame and cuts each need out where it differs from the empty world, writing cropped layers plus `manifest.json`.
- Earth textures (NASA Blue Marble, public domain) come from the `three-globe` npm package's example images, copied into `tex/`.

Then convert the layer PNGs to .webp, copy into `assets/aero3/`, and paste the manifest into `AERO` in App.js.
