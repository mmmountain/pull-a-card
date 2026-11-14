// Renders icons (3D) and the canvas layers. Usage: node render2.js <outDir>
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const root = __dirname, out = process.argv[2];
const types = { ".html": "text/html", ".js": "text/javascript" };
const server = http.createServer((q, s) => {
  const f = path.join(root, decodeURIComponent(q.url.split("?")[0]));
  if (!f.startsWith(root) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(s);
}).listen(0, async () => {
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await b.newPage(); const base = `http://127.0.0.1:${server.address().port}`;
  const save = (name, url) => fs.writeFileSync(path.join(out, name), Buffer.from(url.split(",")[1], "base64"));
  await p.goto(base + "/icons.html"); await p.waitForFunction("window.ready === true");
  for (const n of ["drop", "bowl", "leaf", "door", "sneaker"]) save("icon-" + n + ".png", await p.evaluate((n) => window.render(n), n));
  await p.goto(base + "/bg.html"); await p.waitForFunction("window.ready === true");
  save("landscape.jpg", await p.evaluate(() => window.landscape()));
  save("orb-back.png", await p.evaluate(() => window.orbBack()));
  save("orb-front.png", await p.evaluate(() => window.orbFront()));
  for (const [n, hex] of [["water", "#1ea7ff"], ["eat", "#ff8a00"], ["stretch", "#7ccf12"], ["bathroom", "#ffc21a"], ["walk", "#1fc7a2"]]) save("liquid-" + n + ".png", await p.evaluate((h) => window.liquid(h), hex));
  console.log("done"); await b.close(); server.close();
});
