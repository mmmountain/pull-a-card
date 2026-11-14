// Renders the Aero world (scene4.html): the empty world, each need alone at each fill level, and sprites.
// Usage: node render4.js <outDir> [mock|full] [ss]
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const root = __dirname, out = process.argv[2], mode = process.argv[3] || "full", ss = process.argv[4] || "1.5";
const types = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg" };
const LEVELS = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1];
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((q, s) => {
  const f = path.join(root, decodeURIComponent(q.url.split("?")[0]));
  if (!f.startsWith(root) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(s);
}).listen(0, async () => {
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errs.push(m.text()));
  await p.goto(`http://127.0.0.1:${server.address().port}/scene4.html?ss=${ss}`);
  await p.waitForFunction("window.ready === true", null, { timeout: 300000 }).catch(() => {});
  if (errs.length) console.log("errors:", errs.slice(0, 8));
  fs.writeFileSync(path.join(out, "sun.json"), JSON.stringify(await p.evaluate(() => window.sunScreen)));
  const save = (name, url) => fs.writeFileSync(path.join(out, name), Buffer.from(url.split(",")[1], "base64"));
  const t0 = Date.now();
  if (mode === "mock") { save("mock.png", await p.evaluate(() => window.renderFrame({ walk: 0.6, eat: 0.6, stretch: 0.6, bathroom: 0.6, water: 0.6 }))); console.log("mock", Date.now() - t0, "ms"); }
  else {
    save("bg.png", await p.evaluate(() => window.renderFrame({}))); console.log("bg", Date.now() - t0);
    for (const n of ["walk", "eat", "stretch", "bathroom", "water"]) {
      for (const l of LEVELS) save(`${n}-${Math.round(l * 100)}.png`, await p.evaluate(([n, l]) => window.renderFrame({ [n]: l }), [n, l]));
      console.log(n, Date.now() - t0);
    }
    save("mock.png", await p.evaluate(() => window.renderFrame({ walk: 0.6, eat: 0.6, stretch: 0.6, bathroom: 1, water: 0.6 })));
    for (const s of ["gull", "fish"]) save(`sprite-${s}.png`, await p.evaluate((s) => window.renderSprite(s), s));
  }
  if (errs.length) console.log("errors:", errs.slice(0, 8));
  await b.close(); server.close();
});
