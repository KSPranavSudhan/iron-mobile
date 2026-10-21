// Tiny static server for local testing:  node tools/serve.mjs [port]
// Env MODEL_OVERLAY=/some/dir : files in that dir are served for /model/<name> (used by tests/e2e.py to publish fake updates).
// NOTE: service workers and (on real phones) camera access need HTTPS or http://localhost. For on-phone tests use a tunnel
// (e.g. `npx localtunnel --port 8080` or `cloudflared tunnel --url http://localhost:8080`) or deploy to any HTTPS static host.
import http from 'http'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8080), overlay = process.env.MODEL_OVERLAY;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  let file = path.join(root, p);
  if (overlay && p.startsWith('/model/')) { const o = path.join(overlay, path.basename(p)); if (fs.existsSync(o)) file = o; }
  if (!file.startsWith(root) && !(overlay && file.startsWith(overlay))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    res.end(buf);
  });
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
