/* app.js -- UI + glue: photo selection, on-device analysis (worker), model store and OTA updates. */
(function () {
  'use strict';
  const CFG = self.IRON_CONFIG;
  const $ = (id) => document.getElementById(id);
  const Bundle = self.IronBundle, Exif = self.IronExif;

  // ---------------------------------------------------------------- state
  let store = null;            // ModelStore
  let worker = null, workerReady = false, workerWaiters = [];
  let sel = null;              // {file, bitmap, exif}
  let pendingUpdate = null;    // {manifest}
  let deferredInstall = null;  // beforeinstallprompt event
  // Running inside the Capacitor Android app (APK)? Then everything is bundled in the APK: no service worker needed.
  const NATIVE = !!(self.Capacitor && self.Capacitor.isNativePlatform && self.Capacitor.isNativePlatform());
  const LAST_CHECK_KEY = 'iron.lastUpdateCheck';

  // ---------------------------------------------------------------- diagnostics: every failure becomes a screenshot-able report
  const DIAG_HINTS = [
    [/^E-CAM-PERM/, 'Allow camera access: Android Settings → Apps → Iron Reader → Permissions → Camera. Then try again.'],
    [/^E-CAM-(ACCESS|DEVICE-[12]|DISCONNECTED|OPEN-TIMEOUT)/, 'Another app may be using the camera. Close other camera apps (or restart the phone) and try again. Meanwhile you can use Manual.'],
    [/^E-CAM-/, 'This phone’s camera rejected the automatic setup. Use Manual for now and send this screenshot.'],
    [/^E-PLUGIN/, 'This build doesn’t include the in-app camera. Install the latest APK (uninstall the old app first).'],
    [/^E-APP-/, 'Open your camera app yourself, take the photo in Pro mode, then use “Choose from Gallery”.'],
    [/^E-LOAD/, 'The photo was taken but could not be handed to the analyser. Try again, or use Manual.'],
    [/^E-CRASH/, 'The app closed unexpectedly last time. The details below show where it happened.'],
    [/^E-ENGINE/, 'The on-device image engine did not start. Close and reopen the app.'],
  ];
  let lastDiagText = '';
  const nowStamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  function appLine() {
    let mv = '?'; try { mv = store ? store.active().bundle.version : '?'; } catch (e) { /* ignore */ }
    return `App v${CFG.APP_VERSION} · model v${mv} · ${NATIVE ? 'Android app' : 'browser'} · ${nowStamp()}`;
  }
  function describeNative(err) {
    const L = [];
    if (!err) return L;
    if (err.step) L.push(`Step: ${err.step}`);
    const d = err.device;
    if (d) L.push(`Phone: ${d.manufacturer || ''} ${d.model || ''} (${d.device || ''}) · Android ${d.android || '?'} (SDK ${d.sdk || '?'}) · native v${d.native_version || '?'}`);
    const p = err.plan;
    if (p) {
      L.push(`Camera: id ${p.camera_id} · ${p.hw_level} · ${p.mode} · ISO ${p.iso == null ? 'auto' : p.iso} · ${p.exposure_ms == null ? 'auto' : p.exposure_ms + ' ms'} · WB ${p.white_balance} · ${p.af}`);
      L.push(`Sizes: photo ${p.jpeg} · preview ${p.preview} · sensor ${p.sensor_orientation}° · focal ${p.focal35 == null ? '?' : p.focal35 + ' mm'} · ISO range ${p.iso_range || '?'} · exp ${p.exposure_range_ms || '?'} ms`);
      if (p.notes && p.notes.length) L.push('Notes: ' + p.notes.join(' | '));
    }
    if (err.exception) L.push(`Exception: ${err.exception}`);
    if (err.stack) L.push(String(err.stack).split('\n').slice(1, 5).map((x) => '  ' + x.trim()).join('\n'));
    if (err.warnings && err.warnings.length) L.push('Warnings: ' + err.warnings.join(' | '));
    return L;
  }
  /** opts: {code, title, what, hint, native (error object from the camera), extra (lines), log (lines)} */
  function showDiagnostic(opts) {
    try {
      const code = opts.code || 'E-UNKNOWN';
      const hint = opts.hint || (DIAG_HINTS.find(([re]) => re.test(code)) || [null, 'Send this screenshot so the problem can be fixed.'])[1];
      const n = opts.native || {};
      const lines = [`${code} — ${opts.title || 'Error'}`];
      if (opts.what) lines.push(opts.what);
      lines.push(...describeNative(n));
      if (opts.extra) lines.push(...[].concat(opts.extra));
      lines.push(appLine());
      const log = opts.log || n.log || [];
      const full = lines.concat(log.length ? ['--- log ---', ...log] : []).join('\n');
      const shown = lines.concat(log.length ? ['--- log (last 10) ---', ...log.slice(-10)] : []).join('\n');
      lastDiagText = full;
      $('diag-code').textContent = code; $('diag-title').textContent = opts.title || 'Something went wrong';
      $('diag-what').textContent = opts.what || ''; $('diag-hint').textContent = hint;
      $('diag-pre').textContent = shown;
      const card = $('diag-card'); card.hidden = false;
      try { card.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
      self.__lastDiagnostic = { code, text: full };
    } catch (e) {
      try { alert(`${opts.code}: ${opts.title}\n${opts.what || ''}`); } catch (e2) { /* nothing left */ }
    }
  }
  self.addEventListener('error', (e) => {
    if (!e || !e.message || /^Script error\.?$/.test(e.message)) return;
    showDiagnostic({ code: 'E-JS', title: 'Unexpected app error', what: e.message,
      extra: [`At: ${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno}`, e.error && e.error.stack ? String(e.error.stack).split('\n').slice(0, 5).join('\n') : ''].filter(Boolean) });
  });
  self.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    showDiagnostic({ code: 'E-JS-PROMISE', title: 'Unexpected app error', what: (r && r.message) || String(r),
      extra: r && r.stack ? [String(r.stack).split('\n').slice(0, 5).join('\n')] : [] });
  });

  // ---------------------------------------------------------------- the app's own camera (Android only, native plugin "IronCamera")
  const Cam = {
    available: () => NATIVE && !!(self.Capacitor && typeof self.Capacitor.nativePromise === 'function'),
    async call(method, opts) {
      try { return await self.Capacitor.nativePromise('IronCamera', method, opts || {}); }
      catch (e) {
        const msg = (e && e.message) || String(e);
        const missing = /not implemented|UNIMPLEMENTED|not available|does not have/i.test(msg + ' ' + (e && e.code));
        return { status: 'error', error: { code: missing ? 'E-PLUGIN' : 'E-PLUGIN-CALL', message: `IronCamera.${method}: ${msg}` } };
      }
    },
  };

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

  function toast(msg, ms = 3500) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------- worker
  function startWorker() {
    try {
      worker = new Worker('worker.js');
    } catch (e) { $('footer-status').textContent = 'This browser cannot run the on-device engine.'; return; }
    worker.onmessage = (e) => {
      if (e.data.type === 'ready') { workerReady = true; workerWaiters.splice(0).forEach((f) => f()); updateFooter(); }
    };
    worker.onerror = (e) => {
      console.error('worker error', e.message);
      showDiagnostic({ code: 'E-ENGINE', title: 'The image engine failed', what: e.message || 'worker error', extra: [`At: ${(e.filename || '').split('/').pop()}:${e.lineno || '?'}`] });
    };
  }
  const whenWorkerReady = () => (workerReady ? Promise.resolve() : new Promise((r) => workerWaiters.push(r)));

  // ---------------------------------------------------------------- model chip / sheet
  function activeInfo() { return store.active(); }

  function renderModel() {
    const { bundle, source } = activeInfo();
    $('chip-text').textContent = `Model v${bundle.version}${source === 'updated' ? ' · updated' : ''}`;
    $('chip-dot').className = 'dot ' + (source === 'updated' ? 'dot-blue' : 'dot-ok');
    $('s-version').textContent = `v${bundle.version}`;
    $('s-source').textContent = source === 'updated' ? 'Downloaded update' : 'Built into the app';
    $('s-released').textContent = bundle.released || '—';
    const m = bundle.model;
    $('s-eq').textContent = m.type === 'linear' ? `conc = ${m.coef.toFixed(4)}·f ${m.intercept < 0 ? '−' : '+'} ${Math.abs(m.intercept).toFixed(4)}`
      : m.type === 'polynomial' ? `polynomial (degree ${m.coefs.length - 1})` : `piecewise-linear (${m.x.length} knots)`;
    const tr = bundle.training || {};
    $('s-train').textContent = [tr.n_photos ? `${tr.n_photos} photos` : null, tr.note].filter(Boolean).join(' · ') || '—';
    $('s-notes').textContent = bundle.notes || '';
    // Roll back = previous downloaded model if there is one, otherwise the built-in model.
    $('s-rollback').hidden = source !== 'updated';
    $('s-rollback').textContent = store.previous() ? `Roll back to v${store.previous().version}` : 'Roll back to built-in model';
    $('s-reset').hidden = !(source === 'updated' && store.previous());   // only useful when it differs from rollback
    $('s-app').textContent = `v${CFG.APP_VERSION}`;
    $('s-url').textContent = CFG.UPDATE_MANIFEST_URL;
    $('s-signed').textContent = CFG.UPDATE_PUBLIC_KEY ? 'Yes (signature required)' : 'No — integrity hash only';
    updateFooter();
  }

  function updateFooter() {
    const { bundle } = activeInfo();
    $('footer-status').textContent = `App v${CFG.APP_VERSION} · model v${bundle.version} · ${workerReady ? 'engine ready' : 'engine loading…'}`;
  }

  function setStatus(msg, kind) { const s = $('s-status'); s.textContent = msg || ''; s.className = 'sheet-status ' + (kind || ''); }

  function showUpdateAvailable(manifest) {
    pendingUpdate = { manifest };
    $('chip-update').hidden = false;
    $('ub-title').textContent = `Model update v${manifest.version} available`;
    $('ub-text').textContent = manifest.notes || 'A newer model is ready to install.';
    $('update-banner').hidden = false;
    $('s-update').hidden = false;
    $('s-update-title').textContent = `v${manifest.version} · released ${manifest.released || '—'}`;
    $('s-update-notes').textContent = manifest.notes || '';
  }
  function clearUpdateAvailable() {
    pendingUpdate = null; $('chip-update').hidden = true; $('update-banner').hidden = true; $('s-update').hidden = true;
  }

  async function checkUpdates(manual) {
    if (NATIVE && !/^https?:\/\//i.test(CFG.UPDATE_MANIFEST_URL)) {
      if (manual) setStatus('No update server configured in this build (set UPDATE_MANIFEST_URL when building the APK).', 'warn');
      return { status: 'error' };
    }
    if (manual) setStatus('Checking…');
    const r = await Bundle.checkForUpdate({ manifestUrl: CFG.UPDATE_MANIFEST_URL, installedVersion: activeInfo().bundle.version, appVersion: CFG.APP_VERSION });
    lsSet(LAST_CHECK_KEY, String(Date.now()));
    if (r.status === 'available') { showUpdateAvailable(r.manifest); if (manual) setStatus(`Update v${r.manifest.version} is available.`, 'ok'); }
    else if (r.status === 'up_to_date') { clearUpdateAvailable(); if (manual) setStatus('You have the latest model.', 'ok'); }
    else if (r.status === 'needs_app_update') { if (manual) setStatus(r.message, 'warn'); }
    else if (manual) setStatus(r.message, 'warn');
    return r;
  }

  async function installUpdate() {
    if (!pendingUpdate) return;
    const btn = $('s-install'); btn.disabled = true; setStatus('Downloading and verifying…');
    try {
      const bundle = await Bundle.downloadVerified({
        manifestUrl: CFG.UPDATE_MANIFEST_URL, manifest: pendingUpdate.manifest,
        installedVersion: activeInfo().bundle.version, appVersion: CFG.APP_VERSION,
        publicKeyJwk: CFG.UPDATE_PUBLIC_KEY, requireSignature: CFG.REQUIRE_SIGNATURE,
      });
      if (!store.install(bundle)) throw new Error('Could not save the model on this device (storage blocked?).');
      clearUpdateAvailable(); renderModel();
      setStatus(`Installed model v${bundle.version}.`, 'ok'); toast(`Model updated to v${bundle.version}`);
    } catch (e) {
      setStatus(e.message || String(e), 'err');
    } finally { btn.disabled = false; }
  }

  // ---------------------------------------------------------------- photo selection
  async function loadBitmap(file) {
    // colorSpaceConversion:'none' is REQUIRED: Nord / iQOO photos carry a Display P3 profile. OpenCV (which the model was
    // trained with) ignores it and reads the raw JPEG values; letting the browser convert to sRGB shifts the colours and
    // the readings by up to ~0.12 mg/L. With 'none' the pixels are bit-identical to cv2.imdecode (verified on real photos).
    try { return await createImageBitmap(file, { imageOrientation: 'from-image', colorSpaceConversion: 'none' }); }
    catch (e) {
      return await new Promise((res, rej) => { // <img> applies EXIF orientation by default in current browsers
        const url = URL.createObjectURL(file), im = new Image();
        im.onload = () => { createImageBitmap(im).then((b) => { URL.revokeObjectURL(url); res(b); }, rej); };
        im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
        im.src = url;
      });
    }
  }

  /** Settings the in-app camera actually used (from the camera itself) -> same shape as readExif().settings */
  function mergeNativeSettings(exif, n) {
    const num = (x) => typeof x === 'number' && isFinite(x);
    const a = n.actual || {}, p = n.plan || {}, d = n.device || {};
    const s = Object.assign({}, exif.settings || {});
    if (num(a.iso)) s.iso = a.iso;
    if (num(a.exposure_time_s)) s.exposure_time_s = a.exposure_time_s;
    if (num(a.awb_mode)) s.white_balance = a.awb_mode === 1 ? (p.awb_locked ? 2 : 0) : 1;   // 1 = AUTO; 2 = auto but locked for the shot
    s.flash = a.flash_state === 3 ? 1 : 0;                       // FLASH_STATE_FIRED
    s.exposure_bias_ev = 0;                                      // the app camera never applies exposure compensation
    s.digital_zoom = num(a.zoom_ratio) ? a.zoom_ratio : 1;
    if (num(p.focal35)) s.focal_35mm = Math.round(p.focal35);
    return { present: true, make: exif.make || d.manufacturer || null, model: exif.model || d.model || null, orientation: exif.orientation, settings: s, from_app_camera: true };
  }

  async function setSelectedFile(file, source, nativeInfo) {
    resetResultViews();
    if (sel && sel.bitmap && sel.bitmap.close) sel.bitmap.close();
    sel = null;
    const note = $('photo-note'); note.hidden = true;
    try {
      const head = await file.slice(0, 262144).arrayBuffer();
      let exif = Exif.readExif(new Uint8Array(head));
      if (source === 'app_camera' && nativeInfo) exif = mergeNativeSettings(exif, nativeInfo);
      const bitmap = await loadBitmap(file);
      sel = { file, bitmap, exif };
      const url = URL.createObjectURL(file);
      const th = $('dropzone-thumb'); th.onload = () => URL.revokeObjectURL(url); th.src = url; th.hidden = false;
      $('preview-empty').hidden = true; $('clear-btn').hidden = false; $('analyze-btn').disabled = false;
      const w = bitmap.width, h = bitmap.height, msgs = [];
      if (h > w) msgs.push('This photo is portrait. Retake it in landscape — the app needs the tube and card side by side.');
      else if (w < 3000) msgs.push(`Photo is only ${w}×${h}. The app was validated on ~4096×3072 photos; shared/compressed copies (WhatsApp etc.) can give wrong readings. Use the original.`);
      if (!exif.present) msgs.push('No camera metadata (EXIF) found, so the phone model can’t be identified; the cross-brand error estimate will be used.');
      if (nativeInfo) {
        const p = nativeInfo.plan || {};
        if (p.mode === 'locked_auto') msgs.push('This phone doesn’t let apps set ISO and shutter exactly, so exposure was measured and locked instead.');
        for (const w of [].concat(p.notes || [], nativeInfo.warnings || [])) if (!/doesn't let apps set/.test(w)) msgs.push(w + '.');
      }
      if (msgs.length) { note.textContent = msgs.join(' '); note.hidden = false; }
      sel.source = source; sel.override = false; sel.native = nativeInfo || null;
      sel.check = Exif.checkCaptureSettings(exif, activeInfo().bundle.capture, [w, h]);
      renderSettingsCheck();
    } catch (e) {
      showError('This image could not be opened. Try a JPEG photo.', { code: 'decode', message: e && e.message, file });
    }
  }

  function clearSelectedFile() {
    if (sel && sel.bitmap && sel.bitmap.close) sel.bitmap.close();
    sel = null;
    $('file-input-camera').value = ''; $('file-input-gallery').value = '';
    const th = $('dropzone-thumb'); th.hidden = true; th.removeAttribute('src');
    $('preview-empty').hidden = false; $('clear-btn').hidden = true; $('analyze-btn').disabled = true; $('photo-note').hidden = true;
    $('settings-check').hidden = true; setAnalyzeLabel('Analyze Sample');
  }

  // ---------------------------------------------------------------- camera settings (checklist + EXIF verification)
  const SC_TEXT = {
    ok: ['✓', 'Camera settings match the validated setup'],
    close: ['!', 'Camera settings are close to the validated setup'],
    unknown: ['?', 'Camera settings can’t be verified for this photo'],
    fail: ['✕', 'Camera settings differ from the validated setup'],
  };
  function setAnalyzeLabel(t) { const b = $('analyze-btn'); b.lastChild.textContent = ' ' + t; }

  function renderSettingsCheck() {
    const box = $('settings-check'), c = sel && sel.check;
    if (!c || c.status === 'unchecked') { box.hidden = true; return; }
    box.hidden = false; box.className = 'settings-check ' + c.status;
    $('sc-icon').textContent = SC_TEXT[c.status][0]; $('sc-title').textContent = SC_TEXT[c.status][1];
    const ul = $('sc-list'); ul.textContent = '';
    for (const it of c.items) {
      const li = document.createElement('li'); li.className = it.status;
      const a = document.createElement('span'); a.textContent = it.label + ' ';
      const sm = document.createElement('small'); sm.textContent = `(needs ${it.expected})`; a.appendChild(sm);
      const b = document.createElement('b'); b.textContent = it.value;
      li.append(a, b); ul.appendChild(li);
    }
    const hint = $('sc-hint'), ov = $('sc-override');
    if (c.status === 'fail') {
      hint.textContent = 'Retake the photo with the settings marked in red. Readings from other settings were never validated and can be badly off.';
      ov.hidden = sel.override; $('analyze-btn').disabled = !sel.override;
      setAnalyzeLabel(sel.override ? 'Analyze (not validated)' : 'Retake with the settings above');
    } else if (c.status === 'unknown') {
      hint.textContent = 'This photo has no (or incomplete) camera data — typical for shared or edited copies. Use the original photo from the camera if you can.';
      ov.hidden = true; $('analyze-btn').disabled = false; setAnalyzeLabel('Analyze Sample');
    } else {
      hint.textContent = c.status === 'close' ? 'Within tolerance, but not exactly the reference settings.' : '';
      ov.hidden = true; $('analyze-btn').disabled = false; setAnalyzeLabel('Analyze Sample');
    }
  }

  let capMode = 'web';   // 'web': browser camera input; 'native-manual': the phone's own camera app (Android app)
  function onTakePhoto() {
    if (Cam.available()) $('mode-sheet').showModal();
    else openCaptureSheet('web');
  }

  function openCaptureSheet(mode) {
    capMode = mode;
    const req = activeInfo().bundle.capture;
    const list = (req && Array.isArray(req.checklist)) ? req.checklist : [];
    if (mode === 'web' && !list.length) { $('file-input-camera').click(); return; }
    const ol = $('cap-list'); ol.textContent = '';
    for (const t of list) { const li = document.createElement('li'); li.textContent = t; ol.appendChild(li); }
    $('cap-confirm').checked = false; $('cap-open').disabled = true; $('cap-open').hidden = false;
    $('cap-open').textContent = mode === 'native-manual' ? 'Open my camera app' : 'Open camera';
    $('cap-step2').hidden = true;
    $('capture-sheet').showModal();
  }

  async function onCapOpen() {
    if (capMode !== 'native-manual') { $('capture-sheet').close(); $('file-input-camera').click(); return; }
    const r = await Cam.call('openCameraApp');
    if (!r || r.status !== 'ok') {
      $('capture-sheet').close();
      showDiagnostic({ code: (r && r.error && r.error.code) || 'E-APP-OPEN', title: 'Could not open the camera app', what: r && r.error && r.error.message, native: r && r.error });
      return;
    }
    $('cap-step2').hidden = false; $('cap-open').hidden = true;   // they come back here after shooting
  }

  function nominalCaptureOptions() {
    const bundle = activeInfo().bundle, req = bundle.capture || {}, o = { iso: 80, exposureNs: 10000000, whiteBalance: 'daylight', jpegWidth: 4096 };
    if (req.iso && Array.isArray(req.iso.target)) o.iso = Math.round(req.iso.target[0]);
    if (req.exposure_time_s && Array.isArray(req.exposure_time_s.target)) o.exposureNs = Math.round((req.exposure_time_s.target[0] + req.exposure_time_s.target[1]) / 2 * 1e9);
    if (bundle.app_camera && typeof bundle.app_camera.white_balance === 'string') o.whiteBalance = bundle.app_camera.white_balance;
    return o;
  }

  function b64ToBlob(b64) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: 'image/jpeg' });
  }

  async function loadCapturedFile(r) {
    let blob = null, why = '';
    try {
      const resp = await fetch(self.Capacitor.convertFileSrc(r.path));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      blob = await resp.blob();
      if (!blob.size) throw new Error('empty file');
    } catch (e) { why = (e && e.message) || String(e); blob = null; }
    if (!blob) {   // fallback: ask the native side for the bytes
      const b = await Cam.call('readCapture', { path: r.path });
      if (!b || b.status !== 'ok') throw new Error(`file URL failed (${why}); fallback failed (${b && b.error ? b.error.code + ' ' + b.error.message : '?'})`);
      blob = b64ToBlob(b.base64);
    }
    return new File([blob], String(r.path).split('/').pop() || 'capture.jpg', { type: 'image/jpeg' });
  }

  async function captureAutomatic() {
    $('diag-card').hidden = true;
    const sl = $('status-line'); sl.hidden = false; sl.textContent = 'Opening the camera…';
    let r;
    try { r = await Cam.call('capture', nominalCaptureOptions()); } finally { sl.hidden = true; }
    self.__lastCapture = r;
    if (!r || r.status === 'cancelled') return;
    if (r.status !== 'ok') {
      const e = r.error || {};
      showDiagnostic({ code: e.code || 'E-CAM', title: 'The automatic camera failed', what: e.message, native: e });
      return;
    }
    let file;
    try { file = await loadCapturedFile(r); }
    catch (e) { showDiagnostic({ code: 'E-LOAD', title: 'The photo could not be loaded', what: e.message, native: r, extra: [`File: ${r.path} (${r.bytes} bytes, ${r.width}×${r.height})`] }); return; }
    await setSelectedFile(file, 'app_camera', r);
  }

  async function cameraCheck() {
    const out = $('s-camcheck-out'); out.hidden = false; out.textContent = 'Reading camera capabilities…';
    const r = await Cam.call('getCapabilities');
    if (!r || r.status !== 'ok') { out.textContent = `${(r && r.error && r.error.code) || 'E-CAPS'}: ${(r && r.error && r.error.message) || 'failed'}\n${appLine()}`; return; }
    const d = r.device || {}, p = r.plan, L = [];
    L.push(`Phone: ${d.manufacturer} ${d.model} (${d.device}) · Android ${d.android} (SDK ${d.sdk}) · native v${d.native_version}`);
    L.push(`Automatic camera uses: camera ${r.chosen == null ? 'NONE FOUND' : r.chosen}`);
    if (p) {
      L.push(p.mode === 'manual' ? `  ✓ exact settings: ISO ${p.iso} · ${p.exposure_ms} ms · WB ${p.white_balance}` : `  ! no manual ISO/shutter for apps: exposure measured then locked · WB ${p.white_balance}`);
      L.push(`  photo ${p.jpeg} · preview ${p.preview} · ${p.hw_level} · focal ${p.focal35 == null ? '?' : p.focal35 + ' mm'} · ${p.af}`);
      for (const n of p.notes || []) L.push('  • ' + n);
    }
    L.push('All cameras:');
    for (const c of r.cameras || []) {
      L.push(c.error ? `  ${c.id}: error ${c.error}` : `  ${c.id} ${c.facing} ${c.hw_level} manual:${c.manual_sensor ? 'yes' : 'no'} ISO ${c.iso_range || '?'} exp ${c.exposure_range_ms || '?'} ms focal ${c.focal35 || '?'} photo ${c.photo_size || '?'} WB ${(c.awb_modes || []).join(',')}`);
    }
    if (r.error) L.push('Error: ' + r.error);
    L.push(appLine());
    out.textContent = L.join('\n');
  }

  // ---------------------------------------------------------------- analysis
  const STAGE_TEXT = { decode: 'Preparing photo…', tube: 'Locating the tube…', features: 'Measuring colour…', card: 'Reading the reference card…', model: 'Computing concentration…' };

  function bitmapToImageData(bitmap) {
    const r = bitmap.width / 4096;
    let w = bitmap.width, h = bitmap.height;
    if (r > 1.1) { w = 4096; h = Math.round(bitmap.height * 4096 / bitmap.width); }   // big sensors: keep canvas/memory sane
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h);
    c.width = c.height = 0;
    return d;
  }

  function runWorker(imageData, device, bundle, onStage) {
    return new Promise((resolve, reject) => {
      const prev = worker.onmessage;
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') onStage(m.stage);
        else if (m.type === 'result') { worker.onmessage = prev; resolve(m.result); }
        else if (m.type === 'error') { worker.onmessage = prev; reject(Object.assign(new Error(m.message), { code: m.code })); }
      };
      const buf = imageData.data.buffer;
      worker.postMessage({ type: 'analyze', buffer: buf, width: imageData.width, height: imageData.height, device, bundle }, [buf]);
    });
  }

  async function analyze() {
    if (!sel) return;
    if (sel.check && sel.check.status === 'fail' && !sel.override) return;   // must retake (or explicitly override)
    const btn = $('analyze-btn'); btn.disabled = true;
    const sl = $('status-line'); sl.hidden = false; sl.textContent = 'Starting engine…';
    $('error-card').hidden = true; $('readout-card').hidden = true;
    try {
      await Promise.race([whenWorkerReady(), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('The image engine did not start within 60 s.'), { code: 'engine_timeout' })), 60000))]);
      sl.textContent = STAGE_TEXT.decode;
      const imageData = bitmapToImageData(sel.bitmap);
      const { bundle, source } = activeInfo();
      const t0 = performance.now();
      const device = { make: sel.exif.make, model: sel.exif.model, present: sel.exif.present, source: sel.source === 'app_camera' ? 'app_camera' : 'file' };
      const res = await runWorker(imageData, device, bundle, (s) => { sl.textContent = STAGE_TEXT[s] || s; });
      res.elapsed_ms = Math.round(performance.now() - t0);
      showResult(res, bundle, source);
    } catch (e) {
      showError(e.message || 'Something went wrong reading this photo.', { code: e.code || 'internal', message: e.message });
    } finally { sl.hidden = true; }
  }

  function showResult(data, bundle, source) {
    self.__lastResult = data;   // handy for tests / debugging in the browser console
    $('capture-card').hidden = true; $('readout-card').hidden = false;
    // readings just below 0 (e.g. -0.03 on a blank) are noise around zero: show 0.00 and say so
    const below = data.concentration_mg_per_l < 0 && data.in_calibrated_range;   // only within the tolerance band
    $('readout-value').textContent = (below ? 0 : data.concentration_mg_per_l).toFixed(2);
    const dm = data.device_detected, mk = dm.make || '';
    const dev = dm.model ? (mk && dm.model.toLowerCase().startsWith(mk.toLowerCase()) ? dm.model : `${mk} ${dm.model}`.trim()) : 'Unidentified';
    $('detail-uncertainty').textContent = `± ${data.uncertainty_mae_mg_per_l.toFixed(2)} mg/L`;
    $('detail-device').textContent = dev;
    $('detail-range').textContent = `${data.calibrated_range[0]} – ${data.calibrated_range[1]} mg/L`;
    $('detail-model').textContent = `v${bundle.version}${source === 'updated' ? ' (updated)' : ''}`;
    const cal = $('detail-cal-status');
    cal.textContent = data.device_calibrated ? 'Calibrated' : 'Uncalibrated';
    cal.classList.toggle('badge-ok', data.device_calibrated); cal.classList.toggle('warn', !data.device_calibrated);
    const rb = $('range-badge'), ib = $('info-banner');
    if (data.in_calibrated_range) {
      rb.classList.remove('warn'); rb.classList.add('badge-ok'); $('range-badge-text').textContent = 'Within calibrated range';
      ib.classList.remove('warn'); $('banner-title').textContent = 'Good to go!';
      $('banner-detail').textContent = data.warning || 'Your measurement is within the calibrated range for this device.';
    } else {
      rb.classList.remove('badge-ok'); rb.classList.add('warn'); $('range-badge-text').textContent = 'Outside calibrated range';
      ib.classList.add('warn'); $('banner-title').textContent = 'Extrapolated result';
      $('banner-detail').textContent = data.warning || 'This reading falls outside the calibrated range and has been extrapolated.';
    }
    if (data.debug && data.debug.source === 'app_camera' && !data.device_calibrated) {
      ib.classList.add('warn'); $('banner-title').textContent = 'App camera — not yet validated';
    }
    if (below && data.in_calibrated_range) {
      $('banner-detail').textContent = `Raw reading ${data.concentration_mg_per_l.toFixed(3)} mg/L — at blank level (no detectable iron). ${data.warning || ''}`.trim();
    }
    // camera-settings verdict for this photo
    const sc = sel && sel.check, ds = $('detail-settings');
    const scLabel = { ok: 'Verified', close: 'Close to validated', unknown: 'Not verifiable', fail: 'Outside validated', unchecked: 'Not checked' };
    ds.textContent = (sc ? scLabel[sc.status] : 'Not checked') + (sel && sel.source === 'app_camera' ? ' (app camera)' : '');
    ds.classList.toggle('badge-ok', !!sc && sc.status === 'ok'); ds.classList.toggle('warn', !sc || sc.status !== 'ok');
    if (sc && sc.status === 'fail') {
      const bad = sc.items.filter((i) => i.status === 'fail').map((i) => `${i.label.toLowerCase()} ${i.value}`).join(', ');
      ib.classList.add('warn'); $('banner-title').textContent = 'Not validated — camera settings differ';
      $('banner-detail').textContent = `This photo was taken with ${bad}, outside the settings the model was validated on. Treat the reading as indicative only. ${data.warning || ''}`.trim();
    }
    $('detect-meta').textContent = `${data.roi_method} · ${(data.elapsed_ms / 1000).toFixed(1)} s on-device`;
    drawOverlay(data);
  }

  function drawOverlay(data) {
    try {
      const c = $('overlay'), d = data.debug, [W, H] = d.work_size;
      const pw = Math.min(900, W), ph = Math.round(pw * H / W), k = pw / W;
      c.width = pw; c.height = ph;
      const g = c.getContext('2d');
      g.drawImage(sel.bitmap, 0, 0, pw, ph);
      g.lineWidth = 3;
      g.strokeStyle = '#FF6A2B';
      const [x1, y1, x2, y2] = data.roi_box; g.strokeRect(x1 * k, y1 * k, (x2 - x1) * k, (y2 - y1) * k);
      g.strokeStyle = '#5B7CFA'; g.fillStyle = '#5B7CFA'; g.font = 'bold 13px sans-serif';
      for (const [n, b] of Object.entries(d.patch_boxes)) { g.strokeRect(b[0] * k, b[1] * k, b[2] * k, b[3] * k); g.fillText(n, b[0] * k + 4, b[1] * k + 15); }
    } catch (e) { /* overlay is a nicety */ }
  }

  function showError(msg, ctx) {
    $('error-card').hidden = false; $('error-detail').textContent = msg; $('analyze-btn').disabled = !sel;
    const pre = $('error-pre');
    if (!ctx) { pre.hidden = true; return; }
    const L = [`Code: ${ctx.code || 'unknown'}${ctx.message && ctx.message !== msg ? ' · ' + ctx.message : ''}`];
    if (sel && sel.bitmap) L.push(`Photo: ${sel.bitmap.width}×${sel.bitmap.height} · from ${sel.source}${sel.file ? ' · ' + Math.round(sel.file.size / 1024) + ' KB' : ''}`);
    else if (ctx.file) L.push(`File: ${ctx.file.name || '?'} · ${ctx.file.type || '?'} · ${Math.round((ctx.file.size || 0) / 1024)} KB`);
    if (sel && sel.exif) L.push(`Camera: ${[sel.exif.make, sel.exif.model].filter(Boolean).join(' ') || 'not identified'} · settings ${sel.check ? sel.check.status : '—'}`);
    if (sel && sel.native && sel.native.plan) L.push(`App camera: ${sel.native.plan.mode} · id ${sel.native.plan.camera_id} · ${sel.native.plan.hw_level} · jpeg orientation ${sel.native.jpeg_orientation}`);
    L.push(appLine());
    pre.textContent = L.join('\n'); pre.hidden = false;
  }
  function resetResultViews() { $('readout-card').hidden = true; $('error-card').hidden = true; $('capture-card').hidden = false; }
  function resetToCapture() { clearSelectedFile(); resetResultViews(); }

  // ---------------------------------------------------------------- boot
  async function boot() {
    // built-in model ships inside the app
    let builtin;
    try {
      const r = await fetch('model/model.json'); builtin = await r.json();
      const errs = Bundle.validateBundle(builtin, CFG.APP_VERSION);
      if (errs.length) throw new Error(errs[0]);
    } catch (e) { $('chip-text').textContent = 'Model error'; showError('The built-in model could not be loaded: ' + (e.message || e), { code: 'model_load', message: e.message }); return; }
    store = new Bundle.ModelStore(builtin, localStorage, CFG.APP_VERSION);
    renderModel();
    startWorker();

    // events
    $('file-input-camera').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) setSelectedFile(f, 'camera'); });
    $('file-input-gallery').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) setSelectedFile(f, 'gallery'); });
    $('btn-camera').addEventListener('click', onTakePhoto);
    $('mode-auto').addEventListener('click', () => { $('mode-sheet').close(); captureAutomatic(); });
    $('mode-manual').addEventListener('click', () => { $('mode-sheet').close(); openCaptureSheet('native-manual'); });
    $('cap-confirm').addEventListener('change', (e) => { $('cap-open').disabled = !e.target.checked; });
    $('cap-open').addEventListener('click', onCapOpen);
    $('cap-pick').addEventListener('click', () => { $('capture-sheet').close(); $('file-input-gallery').click(); });
    $('diag-close').addEventListener('click', () => { $('diag-card').hidden = true; });
    $('diag-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(lastDiagText); toast('Details copied'); }
      catch (e) { const r = document.createRange(); r.selectNodeContents($('diag-pre')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Selected — long-press to copy'); }
    });
    if (Cam.available()) { $('s-camcheck').hidden = false; $('s-camcheck').addEventListener('click', cameraCheck); }
    $('sc-override').addEventListener('click', () => { if (sel) { sel.override = true; renderSettingsCheck(); } });
    $('clear-btn').addEventListener('click', (e) => { e.preventDefault(); clearSelectedFile(); });
    $('analyze-btn').addEventListener('click', analyze);
    $('reset-btn').addEventListener('click', resetToCapture);
    $('error-reset-btn').addEventListener('click', resetToCapture);
    $('model-chip').addEventListener('click', () => $('sheet').showModal());
    $('ub-review').addEventListener('click', () => $('sheet').showModal());
    $('s-check').addEventListener('click', () => checkUpdates(true));
    $('s-install').addEventListener('click', installUpdate);
    $('s-rollback').addEventListener('click', () => { store.rollback(); renderModel(); setStatus('Rolled back.', 'ok'); checkUpdates(false); });
    $('s-reset').addEventListener('click', () => { store.resetToBuiltin(); renderModel(); setStatus('Using the built-in model.', 'ok'); checkUpdates(false); });

    // installable app
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; $('s-install-app').hidden = false; });
    $('s-install-app').addEventListener('click', async () => { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; $('s-install-app').hidden = true; } });
    if (/iphone|ipad/i.test(navigator.userAgent) && !navigator.standalone) $('s-install-hint').hidden = false;

    // service worker (offline shell) + "new app version" toast
    if (NATIVE) { $('s-offline').textContent = 'Yes (bundled in the app)'; $('s-install-hint').hidden = true; }
    else if ('serviceWorker' in navigator) {
      try {
        const hadController = !!navigator.serviceWorker.controller;
        await navigator.serviceWorker.register('sw.js');
        navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) toast('App updated — reload to use the new version', 8000); });
        navigator.serviceWorker.ready.then(() => { $('s-offline').textContent = 'Yes'; });
      } catch (e) { $('s-offline').textContent = 'No (service worker unavailable)'; }
    } else { $('s-offline').textContent = 'No (not supported)'; }

    // did the app crash last time? show what happened
    if (Cam.available()) {
      Cam.call('getLastCrash').then((r) => {
        if (r && r.crash) {
          const lines = String(r.crash).split('\n'), err = lines.find((l) => l.startsWith('error: ')) || lines[0];
          showDiagnostic({ code: 'E-CRASH', title: 'The app closed unexpectedly last time', what: err.replace(/^error: /, ''), extra: lines.filter((l) => l !== err && l.trim()).slice(0, 30) });
        }
      });
    }

    // background update check (quiet)
    const last = Number(lsGet(LAST_CHECK_KEY) || 0);
    if (CFG.AUTO_CHECK_UPDATES && navigator.onLine !== false && Date.now() - last > CFG.AUTO_CHECK_INTERVAL_MS) checkUpdates(false);
  }

  boot().catch((e) => showDiagnostic({ code: 'E-BOOT', title: 'The app failed to start', what: (e && e.message) || String(e), extra: e && e.stack ? [String(e.stack).split('\n').slice(0, 5).join('\n')] : [] }));
})();
