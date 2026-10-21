# Iron Reader — on-device mobile app (PWA)

Your FastAPI pipeline (`roi.py`, `features.py`, `patches.py`, `calibration.py`, `device.py`, `model_utils.py`) ported to run
**entirely on the phone** — no server, no upload. Installable on Android and iPhone ("Add to Home Screen"), works offline.

| You asked for | How it works |
|---|---|
| Model runs on phone hardware | `pipeline.js` + vendored `opencv.js` (WASM) in a Web Worker. ~1–2 s per photo on a desktop CPU; expect a few seconds on a mid-range phone. |
| Choose a photo / click a photo | **Take Photo** opens the phone's own camera app (full-res, keeps EXIF); **Choose from Gallery** opens the picker. |
| Update the model when it improves | The model is one small signed JSON file (a *model bundle*). The app checks `model/latest.json`, shows the release notes, and installs on tap. Roll back any time. No app re-install. |

## Run it
```bash
node tools/serve.mjs 8080          # http://localhost:8080  (camera + service worker need HTTPS or localhost)
```
Deploy = upload this folder to any HTTPS static host (Render *Static Site*, GitHub Pages, Netlify, Cloudflare Pages).
For a quick on-phone test of the local server use a tunnel (`cloudflared tunnel --url http://localhost:8080`).
Open the URL on the phone → browser menu → **Install app** / **Add to Home Screen**.

## Shipping a model update (the loop)
```bash
# once: signing key. Keep iron_signing_key.pem private. Paste the printed JWK into config.js -> UPDATE_PUBLIC_KEY, set REQUIRE_SIGNATURE: true
python tools/model_tool.py keygen --out-private iron_signing_key.pem --out-public-jwk public_key.jwk.json

# every release (version must increase):
python tools/model_tool.py publish --version 2 \
   --pkl "Iron App2/models/model.pkl" \
   --reference-patches "Iron App2/calibration_data/reference_patches.json" \
   --notes "Retrained on 600 photos incl. Samsung + Poco" --n-photos 600 \
   --sign-key iron_signing_key.pem --out-dir model/
# -> model/model-v2.json + model/latest.json   => deploy the model/ folder. Phones pick it up on next launch (or "Check for updates").
```
Installed phones refuse an update unless: SHA-256 matches, the ECDSA signature verifies, the schema is valid, the bundle reproduces
its own self-test predictions, it is strictly newer, and `min_app_version` is satisfied. The previous model is kept for rollback.
A bundle contains: regression (`linear`, `polynomial` or `piecewise_linear` — the last two can address the S-shaped residual bias
without any code change), the 9 reference-card patch values, calibrated range, MAE estimates, reference-device names.
What needs an **app** update instead (bump `CACHE` in `sw.js`): changes to ROI/patch/feature code.
You can host updates elsewhere (e.g. GitHub Pages): set `UPDATE_MANIFEST_URL` in `config.js` to the absolute URL.

## Tests (all pass — see below)
```bash
python tests/make_synthetic.py /tmp/synth && python tests/make_fixtures.py tests/fixtures.json
python tests/py_reference.py "Iron App2" /tmp/ref.json /tmp/synth/*.png /tmp/synth/*.jpg   # ORIGINAL python pipeline
node tests/units.mjs /tmp/synth                 # scipy/sklearn ports vs the real libraries
node tests/parity.mjs /tmp/synth /tmp/ref.json  # JS vs Python on identical pixels
python tests/e2e.py /tmp/synth /tmp/ref.json    # real Chromium: photo -> result, EXIF, OTA update/rollback/attacks, offline
```

## Behaviour differences from the Python server (deliberate)
* Photos far from ~4096 px wide are rescaled (all pixel constants were tuned at 4096×3072) and flagged; the server just failed.
* Portrait photos are rejected with a clear message (constants assume landscape); the server would silently mis-detect.
* If fewer than the 7 concentration patches are found the app reports "card not found"; the server would crash with a KeyError.
* The patch-correction Huber fit uses an exact optimiser; sklearn's L-BFGS occasionally stops early (1 of 200 test cases).

## Build the standalone Android APK (no server needed on the phone)

The `android/` folder is a ready Capacitor project that wraps this app: the whole app, OpenCV engine and model are **inside the APK**;
analysis runs on the phone, works in airplane mode, and the only network use is the optional model-update check.
The APK is built by GitHub Actions (no Android Studio needed).

1. Push this folder to a **public** GitHub repo (public so phones can read model updates from `raw.githubusercontent.com`).
2. Repo -> Settings -> Secrets and variables -> Actions -> **Variables** -> add
   * `UPDATE_MANIFEST_URL` = `https://raw.githubusercontent.com/<you>/<repo>/main/model/latest.json`
   * `UPDATE_PUBLIC_KEY` = contents of `public_key.jwk.json` (from `model_tool.py keygen`) -- recommended
3. *(Recommended)* stable signing key, so a new APK installs over the old one and keeps downloaded model updates. Once:
   `keytool -genkeypair -v -keystore iron.jks -alias iron -keyalg RSA -keysize 2048 -validity 10000`
   then base64 it (`base64 -w0 iron.jks`, on Windows `certutil -encode`) and add **Secrets**: `ANDROID_KEYSTORE_B64`,
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (= `iron`). Without them a debug-signed APK is built (works, but you must uninstall before installing a newer build).
4. Actions tab -> **Build Android APK** -> Run workflow. After ~5 min download the artifact `IronReader-apk` (unzip -> `.apk`).
5. Send the APK to the phone, open it, allow "install unknown apps" for your file manager/browser, install. First "Take Photo" asks for camera permission.

Model updates never need a rebuild: `python tools/model_tool.py publish ... --out-dir model/`, commit and push `model/`; the phone sees it
at next launch / "Check for updates". Rebuild the APK only when the detection/feature code changes.

## Going further: store-style APK / iOS app
iOS would need a Mac + Xcode (`npx cap add ios`) and an Apple developer account for installation; the PWA install on iPhone works meanwhile.
