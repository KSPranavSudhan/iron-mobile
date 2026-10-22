/*
 * bundle.js -- model bundle validation + over-the-air update logic.
 *
 * A "model bundle" is one small JSON file that carries everything the on-device
 * pipeline needs from training: the regression, the reference-card patch values,
 * the error estimates and the reference device names. Updating the model means
 * replacing this file -- no app release required.
 *
 *   latest.json (manifest, fetched with no-store)
 *      -> { version, bundle_url, sha256, signature?, notes, released, min_app_version }
 *   model-vN.json (bundle)
 *
 * Safety gates before a downloaded bundle is activated:
 *   1. SHA-256 of the downloaded bytes matches the manifest
 *   2. ECDSA P-256 signature over those bytes verifies (when a public key is configured)
 *   3. strict schema validation (finite numbers, all 9 reference patches, ...)
 *   4. built-in self-test vectors reproduce (the bundle predicts what it claims to)
 *   5. min_app_version <= this app, and version is strictly newer than what's installed
 * The previous bundle is kept so the user can roll back.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pipeline.js'));
  else root.IronBundle = factory(root.IronPipeline);
})(typeof self !== 'undefined' ? self : this, function (Pipeline) {
  'use strict';

  const SCHEMA = 1;
  const PATCH_KEYS = ['0.0', '0.2', '0.5', '1.0', '1.5', '2.0', '2.5', 'WHITE', 'GRAY'];
  const KEY_ACTIVE = 'iron.model.active', KEY_PREV = 'iron.model.previous';

  const fin = (x) => typeof x === 'number' && Number.isFinite(x);
  const finArr = (a, min) => Array.isArray(a) && a.length >= min && a.every(fin);

  function validateBundle(b, appVersion) {
    const errs = [];
    if (!b || typeof b !== 'object') return ['Bundle is not an object'];
    if (b.schema !== SCHEMA) errs.push(`Unsupported schema ${b.schema} (app supports ${SCHEMA})`);
    if (!Number.isInteger(b.version) || b.version < 1) errs.push('version must be a positive integer');
    if (typeof b.released !== 'string') errs.push('released date missing');
    if (b.min_app_version != null && appVersion != null && b.min_app_version > appVersion) {
      errs.push(`Needs app version ${b.min_app_version} or newer (this is ${appVersion}). Update the app first.`);
    }
    const m = b.model;
    if (!m || typeof m !== 'object') errs.push('model missing');
    else if (m.type === 'linear') { if (!fin(m.coef) || !fin(m.intercept)) errs.push('linear model needs finite coef and intercept'); }
    else if (m.type === 'polynomial') { if (!finArr(m.coefs, 2) || m.coefs.length > 8) errs.push('polynomial needs 2-8 finite coefs'); }
    else if (m.type === 'piecewise_linear') {
      if (!finArr(m.x, 2) || !finArr(m.y, 2) || m.x.length !== m.y.length) errs.push('piecewise_linear needs equal-length x/y with >=2 knots');
      else for (let i = 1; i < m.x.length; i++) if (!(m.x[i] > m.x[i - 1])) { errs.push('piecewise_linear x must be strictly increasing'); break; }
    } else errs.push(`unknown model type '${m && m.type}'`);
    const r = b.reference_patches;
    if (!r || typeof r !== 'object') errs.push('reference_patches missing');
    else for (const k of PATCH_KEYS) if (!fin(r[k])) errs.push(`reference_patches['${k}'] missing or not finite`);
    if (!Array.isArray(b.calibrated_range) || b.calibrated_range.length !== 2 || !b.calibrated_range.every(fin) || !(b.calibrated_range[0] < b.calibrated_range[1])) errs.push('calibrated_range must be [low, high]');
    if (!b.uncertainty || !fin(b.uncertainty.same_family_mae) || !fin(b.uncertainty.cross_brand_mae)) errs.push('uncertainty.same_family_mae / cross_brand_mae missing');
    if (!Array.isArray(b.reference_device_names) || !b.reference_device_names.every((s) => typeof s === 'string')) errs.push('reference_device_names must be a list of strings');
    // optional: models that skip the card correction, honest error table, range tolerance
    if (b.correction != null && !(b.correction && Array.isArray(b.correction.skip_for_models) && b.correction.skip_for_models.every((t) => typeof t === 'string' && t.length >= 4))) errs.push('correction.skip_for_models must be a list of model-name substrings (>= 4 chars)');
    if (b.uncertainty && b.uncertainty.by_band != null) {
      const u = b.uncertainty.by_band, n = Array.isArray(u.edges) ? u.edges.length + 1 : -1;
      if (n < 2 || !finArr(u.edges, 1) || !finArr(u.same_family, n) || !finArr(u.cross_brand, n) || u.same_family.length !== n || u.cross_brand.length !== n) errs.push('uncertainty.by_band needs edges[k] and same_family/cross_brand with k+1 numbers');
    }
    if (b.app_camera != null && !(typeof b.app_camera === 'object' && (b.app_camera.validated == null || typeof b.app_camera.validated === 'boolean') && (b.app_camera.white_balance == null || typeof b.app_camera.white_balance === 'string'))) errs.push('app_camera must be {validated: boolean, white_balance?: string}');
    if (b.range_tolerance != null && !(fin(b.range_tolerance) && b.range_tolerance >= 0 && b.range_tolerance <= 0.5)) errs.push('range_tolerance must be between 0 and 0.5');
    // optional camera-capture requirements (shown before the camera opens, checked against EXIF afterwards)
    if (b.capture != null) {
      const c = b.capture, rng = (r) => Array.isArray(r) && r.length === 2 && r.every(fin) && r[0] <= r[1];
      if (typeof c !== 'object') errs.push('capture must be an object');
      else {
        for (const k of ['iso', 'exposure_time_s', 'exposure_bias_ev', 'focal_35mm']) {
          if (c[k] != null && (!rng(c[k].allowed) || (c[k].target != null && !rng(c[k].target)))) errs.push(`capture.${k} needs allowed:[lo,hi] (and optional target)`);
        }
        if (c.checklist != null && !(Array.isArray(c.checklist) && c.checklist.every((t) => typeof t === 'string'))) errs.push('capture.checklist must be a list of strings');
        if (c.max_digital_zoom != null && !fin(c.max_digital_zoom)) errs.push('capture.max_digital_zoom must be a number');
        if (c.min_width != null && !fin(c.min_width)) errs.push('capture.min_width must be a number');
      }
    }
    // self-test: the bundle must reproduce its own claimed predictions
    if (!errs.length) {
      if (!Array.isArray(b.selftest) || b.selftest.length < 2) errs.push('selftest needs at least 2 vectors');
      else for (const t of b.selftest) {
        let got = NaN; try { got = Pipeline.predictValue(m, t.x); } catch (e) { /* NaN */ }
        if (!fin(got) || Math.abs(got - t.y) > 1e-6) { errs.push(`selftest failed at x=${t.x}: expected ${t.y}, got ${got}`); break; }
      }
    }
    return errs;
  }

  // ---- crypto helpers (WebCrypto: browsers, workers, Node >= 18) -------------------------
  const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;
  const toBytes = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

  async function sha256Hex(bytes) {
    if (!subtle()) throw new Error('WebCrypto unavailable (needs HTTPS)');
    return hex(await subtle().digest('SHA-256', toBytes(bytes)));
  }

  /** ECDSA P-256 / SHA-256, signature in IEEE P1363 (r||s, 64 bytes) base64 */
  async function verifySignature(bytes, sigB64, publicKeyJwk) {
    if (!subtle()) throw new Error('WebCrypto unavailable (needs HTTPS)');
    const key = await subtle().importKey('jwk', publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64(sigB64), toBytes(bytes));
  }

  // ---- persistence ----------------------------------------------------------------------
  function safeStorage(s) {
    return {
      get(k) { try { const v = s.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
      set(k, v) { try { s.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
      del(k) { try { s.removeItem(k); } catch (e) { /* noop */ } },
    };
  }

  class ModelStore {
    /** @param builtin validated built-in bundle shipped inside the app; @param storage localStorage-like */
    constructor(builtin, storage, appVersion) {
      this.builtin = builtin; this.st = safeStorage(storage); this.appVersion = appVersion;
    }
    /** Active bundle: the installed update if it still validates, else the built-in. */
    active() {
      const a = this.st.get(KEY_ACTIVE);
      if (a && validateBundle(a, this.appVersion).length === 0) return { bundle: a, source: 'updated' };
      return { bundle: this.builtin, source: 'built-in' };
    }
    previous() {
      const p = this.st.get(KEY_PREV);
      return p && validateBundle(p, this.appVersion).length === 0 ? p : null;
    }
    install(bundle) {
      const cur = this.active();
      if (cur.source === 'updated') this.st.set(KEY_PREV, cur.bundle);
      else this.st.del(KEY_PREV);
      return this.st.set(KEY_ACTIVE, bundle);
    }
    rollback() {
      const p = this.previous();
      if (p) { this.st.set(KEY_ACTIVE, p); this.st.del(KEY_PREV); } else { this.resetToBuiltin(); }
      return this.active();
    }
    resetToBuiltin() { this.st.del(KEY_ACTIVE); this.st.del(KEY_PREV); return this.active(); }
  }

  // ---- OTA update ----------------------------------------------------------------------
  const resolve = (base, rel) => new URL(rel, new URL(base, (typeof location !== 'undefined' ? location.href : 'http://localhost/'))).href;

  /** Fetch the manifest and compare with the installed version. Never throws. */
  async function checkForUpdate({ manifestUrl, installedVersion, appVersion, fetchFn }) {
    try {
      const f = fetchFn || fetch;
      const res = await f(manifestUrl + (manifestUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return { status: 'error', message: `Update server returned HTTP ${res.status}` };
      const m = await res.json();
      if (!m || m.schema !== SCHEMA || !Number.isInteger(m.version) || typeof m.bundle_url !== 'string' || typeof m.sha256 !== 'string') {
        return { status: 'error', message: 'Update manifest is malformed' };
      }
      if (m.version <= installedVersion) return { status: 'up_to_date', manifest: m };
      if (m.min_app_version != null && m.min_app_version > appVersion) {
        return { status: 'needs_app_update', manifest: m, message: `Model v${m.version} needs a newer version of the app.` };
      }
      return { status: 'available', manifest: m };
    } catch (e) {
      return { status: 'error', message: navigator && navigator.onLine === false ? 'You are offline.' : `Could not reach the update server (${e.message || e}).` };
    }
  }

  /** Download, verify and return a validated bundle (does not activate it). Throws Error with a user-readable message. */
  async function downloadVerified({ manifestUrl, manifest, installedVersion, appVersion, publicKeyJwk, requireSignature, fetchFn }) {
    const f = fetchFn || fetch;
    const url = resolve(manifestUrl, manifest.bundle_url);
    const res = await f(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Model download failed (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 256 * 1024) throw new Error('Model file is unexpectedly large; refusing it.');
    if ((await sha256Hex(bytes)) !== manifest.sha256.toLowerCase()) throw new Error('Integrity check failed (SHA-256 mismatch). The model was not installed.');
    if (publicKeyJwk) {
      if (!manifest.signature) throw new Error('This model update is unsigned; refusing it.');
      let ok = false;
      try { ok = await verifySignature(bytes, manifest.signature, publicKeyJwk); } catch (e) { ok = false; }
      if (!ok) throw new Error('Signature check failed. The model was not installed.');
    } else if (requireSignature) {
      throw new Error('No update public key configured; cannot verify the update.');
    }
    let bundle;
    try { bundle = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { throw new Error('Model file is not valid JSON.'); }
    const errs = validateBundle(bundle, appVersion);
    if (errs.length) throw new Error('Model failed validation: ' + errs[0]);
    if (bundle.version !== manifest.version) throw new Error('Manifest and model versions disagree; refusing it.');
    if (bundle.version <= installedVersion) throw new Error('Model is not newer than the installed one.');
    return bundle;
  }

  return { SCHEMA, PATCH_KEYS, validateBundle, sha256Hex, verifySignature, ModelStore, checkForUpdate, downloadVerified, resolve };
});
