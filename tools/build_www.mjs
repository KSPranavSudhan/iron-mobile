// Copies the web app into www/ (what goes inside the APK) and bakes in build-time settings.
//   UPDATE_MANIFEST_URL=https://raw.githubusercontent.com/<you>/<repo>/main/model/latest.json
//   UPDATE_PUBLIC_KEY='{"kty":"EC",...}'   (optional; if set, unsigned/wrongly-signed updates are refused)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), out = path.join(root, 'www');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'style.css', 'app.js', 'worker.js', 'pipeline.js', 'bundle.js', 'exif.js', 'config.js', 'manifest.webmanifest']) fs.copyFileSync(path.join(root, f), path.join(out, f));
for (const d of ['lib', 'model', 'icons']) fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true, filter: (s) => !/latest\.json$|model-v\d+\.json$/.test(s) });
let cfg = fs.readFileSync(path.join(out, 'config.js'), 'utf8');
const url = process.env.UPDATE_MANIFEST_URL, key = process.env.UPDATE_PUBLIC_KEY;
if (url) cfg = cfg.replace(/UPDATE_MANIFEST_URL: '[^']*'/, `UPDATE_MANIFEST_URL: ${JSON.stringify(url)}`);
if (key) { JSON.parse(key); cfg = cfg.replace('UPDATE_PUBLIC_KEY: null', `UPDATE_PUBLIC_KEY: ${key}`).replace('REQUIRE_SIGNATURE: false', 'REQUIRE_SIGNATURE: true'); }
fs.writeFileSync(path.join(out, 'config.js'), cfg);
console.log(`www/ ready. update url: ${url || '(none - model updates disabled in this build)'}; signature required: ${!!key}`);
