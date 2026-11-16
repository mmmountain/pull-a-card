# Focus · Frutiger Aero art

`python3 tools/aero/build.py` (from the repo root) turns the smooth sources in `src/` into everything the app shows:
dithered frames per need, glows, the sparkle and ambient-life GIFs, the cleaned background, and the manifest
`src/focus/aeroLook.js` (placement, frames, touch boxes). It wipes `assets/aero3/` first. Preview a fill level with
`python3 tools/aero/preview.py 0.5 /tmp/p.jpg [glow]`.

Sources (`src/`): `bg_plate.jpg` (the outpainted beach), `water/` glass filling, `pile/` fruit stop-motion,
`dolphin/` turning away, `turtle_withdraw.mp4` (shot on black), `ball_deflate.mp4` plus SAM3 masks `ball/m*.png`
(played backwards: inflated = due). How those were made — Midjourney edits, FLUX Kontext, Wan first/last-frame and
image-to-video on Hugging Face — lives in `mj/`, `pile/`, `dolphin/`, `gen/`, `photo/`.

To add a thing or a new look: give it a builder in `build.py` that returns smooth RGBA frames on a scene rect, add it
to `THINGS`, rebuild. The app code (`src/focus/Aero.js`) needs no change.
