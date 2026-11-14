// Renders the Aero world: background, each need at 8 fill levels (cropped, with a manifest), and sprites.
// Usage: node render3.js <outDir> [quick]
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const root = __dirname, out = process.argv[2], quick = process.argv[3] === "quick";
const types = { ".html": "text/html", ".js": "text/javascript" };
const LEVELS = quick ? [0.5] : [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1];
const server = http.createServer((q, s) => {
  const f = path.join(root, decodeURIComponent(q.url.split("?")[0]));
  if (!f.startsWith(root) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(s);
}).listen(0, async () => {
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(`http://127.0.0.1:${server.address().port}/scene.html`);
  await p.waitForFunction("window.ready === true", null, { timeout: 120000 });
  const save = (name, url) => fs.writeFileSync(path.join(out, name), Buffer.from(url.split(",")[1], "base64"));
  save("full-bg.png", await p.evaluate(() => window.renderLayer("bg"))); console.log("bg");
  for (const n of ["walk", "eat", "stretch", "bathroom", "water"]) {
    for (const l of LEVELS) save(`full-${n}-${Math.round(l * 100)}.png`, await p.evaluate(([n, l]) => window.renderLayer(n, l), [n, l]));
    console.log(n);
  }
  if (!quick) for (const s of ["gull", "fish"]) save(`sprite-${s}.png`, await p.evaluate((s) => window.renderSprite(s), s));
  if (errs.length) console.log("errors:", errs.slice(0, 5));
  await b.close(); server.close();
});
