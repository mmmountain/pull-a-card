// Random color schemes that keep every color's job the same.
// Built in OKLCH so "same lightness" really looks the same across hues.
//
// Roles (same names the app already uses):
//   bg     page            light, low chroma, base hue
//   bg2    panels/tabs     a step darker than bg, same hue
//   felt   shared table    light, second hue from the harmony
//   paper  card faces      near-white, faint base tint
//   ink    text            very dark, tinted toward the accent
//   muted  secondary text  mid-dark, same hue as ink
//   line   dashed borders  light accent
//   accent buttons/active  mid-light, saturated, harmony hue
//   hot    urgent (held too long)   always red-ish, stronger than accent
//   warm   warning                  always amber-ish
//   suit   four suits      four hues spaced 90° apart, equal lightness and chroma

// The default: stone, sage and clay. Shuffle still makes random schemes; Pink lemonade is the old default.
export const ORIGINAL = {
  name: "Original · sage and stone",
  bg: "#eceee8", bg2: "#dce2d6", felt: "#d3dfd0", paper: "#fafaf7", ink: "#1f2b25", muted: "#55665c",
  line: "#b6c4b3", accent: "#8db39a", hot: "#c4553d", warm: "#cf9a3a",
  suit: { body: "#cf8468", home: "#7aa3bd", mind: "#cfae55", work: "#82ad84" },
};
export const PINK_LEMONADE = {
  name: "Pink lemonade",
  bg: "#fff3a6", bg2: "#ffe57a", felt: "#ffd3e6", paper: "#fffdf7", ink: "#3a1630", muted: "#8a4f6c",
  line: "#f4a9c9", accent: "#ff7eb6", hot: "#ff4f86", warm: "#ffb020",
  suit: { body: "#ff5c93", home: "#6cbcff", mind: "#ffb81f", work: "#5fd394" },
};

/* ---------- OKLCH → sRGB ---------- */
function oklchToRgb(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
}
const inGamut = (rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** OKLCH to hex, pulling chroma down until it fits on a screen (keeps hue and lightness). */
export function oklch(L, C, h) {
  let c = C, rgb = oklchToRgb(L, c, h);
  while (!inGamut(rgb) && c > 0) { c = Math.max(0, c - 0.005); rgb = oklchToRgb(L, c, h); }
  return "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
}

/* ---------- contrast check (WCAG) ---------- */
function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
export function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/* ---------- harmonies ---------- */
const HARMONIES = [
  { name: "Analogous", accent: 35, felt: -30 },
  { name: "Complementary", accent: 180, felt: 15 },
  { name: "Split-complementary", accent: 150, felt: 210 },
  { name: "Triadic", accent: 120, felt: 240 },
  { name: "Monochrome", accent: 0, felt: 0 },
];
const MOODS = [
  { name: "pastel", bgC: 0.07, accC: 0.14, bgL: 0.95 },
  { name: "sunny", bgC: 0.11, accC: 0.17, bgL: 0.94 },
  { name: "soft", bgC: 0.035, accC: 0.11, bgL: 0.96 },
  { name: "bold", bgC: 0.09, accC: 0.2, bgL: 0.93 },
];
const wrap = (h) => ((h % 360) + 360) % 360;

/** Make a random scheme. Pass `rand` for repeatable results. */
export function randomTheme(rand = Math.random) {
  for (let tries = 0; tries < 20; tries++) {
    const base = rand() * 360;
    const hm = HARMONIES[Math.floor(rand() * HARMONIES.length)];
    const mood = MOODS[Math.floor(rand() * MOODS.length)];
    const accH = wrap(base + hm.accent), feltH = wrap(base + hm.felt);
    const suitStart = rand() * 360;
    const suitH = [0, 90, 180, 270].map((d) => wrap(suitStart + d));
    const t = {
      name: `${hm.name} · ${mood.name} · ${Math.round(base)}°`,
      bg: oklch(mood.bgL, mood.bgC, base),
      bg2: oklch(mood.bgL - 0.06, mood.bgC * 1.35, base),
      felt: oklch(0.9, Math.max(0.04, mood.bgC * 0.9), hm.name === "Monochrome" ? wrap(base + 20) : feltH),
      paper: oklch(0.99, 0.008, base),
      ink: oklch(0.26, 0.06, accH),
      muted: oklch(0.47, 0.07, accH),
      line: oklch(0.82, mood.accC * 0.6, accH),
      accent: oklch(0.76, mood.accC, accH),
      hot: oklch(0.64, 0.2, 20),
      warm: oklch(0.78, 0.16, 70),
      suit: {
        body: oklch(0.7, 0.16, suitH[0]),
        home: oklch(0.7, 0.16, suitH[1]),
        mind: oklch(0.7, 0.16, suitH[2]),
        work: oklch(0.7, 0.16, suitH[3]),
      },
    };
    // Text must stay readable on every surface it sits on.
    const ok = contrast(t.ink, t.bg) >= 7 && contrast(t.ink, t.paper) >= 7 && contrast(t.ink, t.accent) >= 4.5 &&
      contrast(t.muted, t.bg) >= 4.5 && contrast(t.muted, t.bg2) >= 3.5;
    if (ok) return t;
  }
  return ORIGINAL;
}
