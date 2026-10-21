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
python tools/model_tool.py publish --version 3 --min-app-version 2 \
   --pkl "Iron App2/models/model.pkl" \
   --reference-patches "Iron App2/calibration_data/reference_patches.json" \
   --extras-json model/bundle_extras.json \
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

## Camera settings (checklist + automatic check)
"Take Photo" first shows the settings the model was validated with and must be confirmed before the camera opens.
After every photo (camera or gallery) the app reads the photo's EXIF and checks ISO, shutter, white balance, flash,
exposure compensation, lens/zoom and resolution. Clearly-off settings (e.g. Auto white balance, flash, ISO 800, zoom)
block analysis; the user can still override, and the result is then marked "Not validated". Photos without camera data
(shared/edited copies) are allowed but flagged "can't verify". The requirements live in `model/bundle_extras.json`
(`capture`), so you can tighten or relax them with a model update — no new APK.

Validated settings found in the 489 photos: Nord ISO 80 · 1/100 s · manual WB · flash off (all 349 identical);
Samsung ISO 32 · 1/90; iqoo / random ISO 100 · 1/100; Poco ISO 100 · 1/100 manual **except 0.5/1.0/1.5 mg/L which were
shot in Auto (auto ISO 119-130, auto WB)** — the sets where Poco's errors are largest (+0.31 at 1.0).

## What v2 of the model changes (measured on the 489 real photos)
* Validated Nord-family models (Nord CE4, AC2001) skip the card correction: error 0.15-0.19 -> 0.10 mg/L
  (Nord leave-one-session-out 0.152 -> 0.105; held-out AC2001 unit 0.185 -> 0.104). Other brands unchanged.
* Error shown with each reading is the measured MAE for the phone category **and** concentration level
  (same family 0.05 / 0.10 / 0.19, other brands 0.11 / 0.30 / 0.45 for <0.75 / 0.75-1.75 / >1.75 mg/L).
* Readings within 0.1 mg/L outside 0-2.5 are no longer flagged as extrapolated (80 of 98 old flags were that); small
  negatives on blanks display as 0.00.
* Tried and rejected (not safe on every phone): quadratic / piecewise concentration models, model fit on corrected
  features, OLS / Theil-Sen / two-point card slopes, learned slope shrinkage (leave-one-phone-out), raw-colour-space
  affine correction. Scripts: `tests/experiments.py`, `tests/experiments_raw.py`, `tests/final_eval.py`.

## Tests (all pass — see below)
```bash
python tests/make_synthetic.py /tmp/synth && python tests/make_fixtures.py tests/fixtures.json
python tests/py_reference.py "Iron App2" /tmp/ref.json /tmp/synth/*.png /tmp/synth/*.jpg   # ORIGINAL python pipeline
node tests/units.mjs /tmp/synth                 # scipy/sklearn ports vs the real libraries
node tests/parity.mjs /tmp/synth /tmp/ref.json  # JS vs Python on identical pixels
python tests/e2e.py /tmp/synth /tmp/ref.json    # real Chromium: photo -> result, EXIF, OTA update/rollback/attacks, offline
#   REAL_PHOTOS=<folder with the unzipped Day*/test1 sets> python tests/e2e.py ...  also tests the camera checklist on real photos
python tests/py_batch.py "Iron App2" <photos> py.jsonl && python tests/browser_batch.py <photos> app.jsonl   # real-photo parity
python tests/exif_scan.py <photos> exif.csv && node tests/exif_check.mjs <photos> exif.csv                  # EXIF reader vs PIL
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
