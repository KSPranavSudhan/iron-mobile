/*
 * exif.js -- minimal JPEG EXIF reader + camera-settings check.
 *
 * readExif(): Make / Model / Orientation (IFD0) and the capture settings from the Exif sub-IFD
 * (ISO, exposure time, f-number, white balance, flash, exposure program/mode/bias, zoom, focal length).
 * `present` mirrors device.py::detect_device: false when the file has no EXIF block at all.
 *
 * checkCaptureSettings(): compares those settings with the requirements carried in the model bundle
 * (bundle.capture) -- the settings the reference photos were taken with.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IronExif = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  function readExif(buffer) {
    const none = { present: false, make: null, model: null, orientation: 1, settings: {} };
    try {
      const v = new DataView(buffer.buffer ? buffer.buffer : buffer, buffer.byteOffset || 0, buffer.byteLength);
      if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return none; // not a JPEG
      let off = 2;
      while (off + 4 < v.byteLength) {
        if (v.getUint8(off) !== 0xFF) return none;
        const marker = v.getUint8(off + 1);
        if (marker === 0xDA || marker === 0xD9) return none; // start of scan: no EXIF seen
        const len = v.getUint16(off + 2);
        if (marker === 0xE1 && off + 10 < v.byteLength && v.getUint32(off + 4) === 0x45786966 /* "Exif" */) {
          return parseTiff(v, off + 10, none);
        }
        off += 2 + len;
      }
    } catch (e) { /* fall through */ }
    return none;
  }

  function parseTiff(v, base, none) {
    const le = v.getUint16(base) === 0x4949;
    if (!le && v.getUint16(base) !== 0x4D4D) return none;
    const u16 = (o) => v.getUint16(base + o, le), u32 = (o) => v.getUint32(base + o, le), s32 = (o) => v.getInt32(base + o, le);
    if (u16(2) !== 42) return none;

    // generic first-value reader for one 12-byte IFD entry
    const value = (e) => {
      const type = u16(e + 2), n = u32(e + 4), size = (TYPE_SIZE[type] || 1) * n;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      switch (type) {
        case 2: { let s = ''; for (let i = 0; i < n; i++) { const c = v.getUint8(base + at + i); if (c === 0) break; s += String.fromCharCode(c); } return s.trim() || null; }
        case 3: return u16(at);
        case 4: return u32(at);
        case 5: { const d = u32(at + 4); return d ? u32(at) / d : null; }
        case 10: { const d = s32(at + 4); return d ? s32(at) / d : null; }
        case 9: return s32(at);
        default: return null;
      }
    };
    const readIfd = (ifdOff) => {
      const out = {}, count = u16(ifdOff);
      for (let i = 0; i < count; i++) { const e = ifdOff + 2 + i * 12; out[u16(e)] = e; }
      return out;
    };

    const ifd0Off = u32(4);
    if (!u16(ifd0Off)) return none; // empty EXIF == no EXIF (PIL: `if not exif`)
    const ifd0 = readIfd(ifd0Off);
    const out = { present: true, make: null, model: null, orientation: 1, settings: {} };
    if (ifd0[0x010F]) out.make = value(ifd0[0x010F]);
    if (ifd0[0x0110]) out.model = value(ifd0[0x0110]);
    if (ifd0[0x0112]) out.orientation = value(ifd0[0x0112]);
    if (ifd0[0x8769]) {
      try {
        const sub = readIfd(value(ifd0[0x8769]));
        const map = {
          iso: 0x8827, exposure_time_s: 0x829A, f_number: 0x829D, exposure_program: 0x8822, exposure_mode: 0xA402,
          exposure_bias_ev: 0x9204, flash: 0x9209, white_balance: 0xA403, digital_zoom: 0xA404,
          focal_length_mm: 0x920A, focal_35mm: 0xA405, datetime: 0x9003,
        };
        for (const [k, tag] of Object.entries(map)) if (sub[tag]) { const x = value(sub[tag]); if (x !== null && x !== undefined) out.settings[k] = x; }
      } catch (e) { /* partial EXIF is fine */ }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Capture-settings check. `req` = bundle.capture, e.g.
  //   { iso:{target:[80,100], allowed:[25,200]}, exposure_time_s:{target:[0.01,0.01], allowed:[0.00625,0.0167]},
  //     white_balance:'manual', flash:'off', exposure_bias_ev:{allowed:[-0.35,0.35]}, max_digital_zoom:1.1,
  //     focal_35mm:{allowed:[20,32]}, min_width:3600 }
  // Each item: status 'ok' | 'close' (inside allowed, outside target) | 'fail' | 'unknown' (not recorded).
  // ---------------------------------------------------------------------------------------------
  const fmtShutter = (t) => (t >= 1 ? `${t.toFixed(1)} s` : `1/${Math.round(1 / t)} s`);
  const inR = (x, r) => r && x >= r[0] - 1e-9 && x <= r[1] + 1e-9;

  function checkCaptureSettings(exif, req, imageSize) {
    const items = [];
    if (!req) return { status: 'unchecked', items };
    const s = (exif && exif.settings) || {};
    const add = (key, label, value, expected, status) => items.push({ key, label, value, expected, status });
    const range = (key, label, spec, fmt) => {
      if (!spec) return;
      const x = s[key];
      const t = spec.target, narrow = t && t[1] <= t[0] * 1.15;   // a narrow target band is shown as its nominal value (1/100 s)
      const exp = t ? (narrow ? fmt((t[0] + t[1]) / 2) : `${fmt(t[0])}–${fmt(t[1])}`) : `${fmt(spec.allowed[0])} to ${fmt(spec.allowed[1])}`;
      if (typeof x !== 'number') return add(key, label, 'not recorded', exp, 'unknown');
      const st = spec.target && inR(x, spec.target) ? 'ok' : inR(x, spec.allowed) ? (spec.target ? 'close' : 'ok') : 'fail';
      add(key, label, fmt(x), exp, st);
    };
    range('iso', 'ISO', req.iso, (x) => String(Math.round(x)));
    range('exposure_time_s', 'Shutter speed', req.exposure_time_s, fmtShutter);
    if (req.white_balance === 'manual') {
      const wb = s.white_balance;
      // 2 = auto white balance locked for the shot (app camera on phones without fixed presets): close, not exact
      add('white_balance', 'White balance', wb === undefined ? 'not recorded' : wb === 1 ? 'Manual' : wb === 2 ? 'Auto, locked' : 'Auto', 'Manual / fixed',
        wb === undefined ? 'unknown' : wb === 1 ? 'ok' : wb === 2 ? 'close' : 'fail');
    }
    if (req.flash === 'off') {
      const f = s.flash;
      add('flash', 'Flash', f === undefined ? 'not recorded' : (f & 1) ? 'Fired' : 'Off', 'Off', f === undefined ? 'unknown' : (f & 1) ? 'fail' : 'ok');
    }
    range('exposure_bias_ev', 'Exposure compensation', req.exposure_bias_ev, (x) => `${x > 0 ? '+' : ''}${x.toFixed(1)} EV`);
    if (req.max_digital_zoom) {
      const z = s.digital_zoom;
      if (typeof z !== 'number' || z === 0) add('digital_zoom', 'Zoom', 'not recorded', '1x', 'unknown');
      else add('digital_zoom', 'Zoom', `${z.toFixed(2)}x`, '1x', z <= req.max_digital_zoom ? 'ok' : 'fail');
    }
    if (req.focal_35mm) {
      const f = s.focal_35mm;
      if (typeof f !== 'number' || f === 0) add('focal_35mm', 'Lens', 'not recorded', 'main (1x) camera', 'unknown');
      else add('focal_35mm', 'Lens', `${f} mm (35mm eq.)`, 'main (1x) camera', inR(f, req.focal_35mm.allowed) ? 'ok' : 'fail');
    }
    if (req.min_width && imageSize) {
      const w = Math.max(imageSize[0], imageSize[1]);
      add('resolution', 'Resolution', `${imageSize[0]}×${imageSize[1]}`, `≥ ${req.min_width} px wide`, w >= req.min_width ? 'ok' : 'fail');
    }
    const st = items.map((i) => i.status);
    const coreUnknown = items.some((i) => ['iso', 'exposure_time_s', 'white_balance'].includes(i.key) && i.status === 'unknown');
    let status;
    if (st.includes('fail')) status = 'fail';                       // at least one setting clearly outside what was validated
    else if (!exif || !exif.present || coreUnknown) status = 'unknown'; // can't verify (no / partial EXIF, e.g. shared photos)
    else if (st.includes('close')) status = 'close';                 // inside tolerance, not exactly the reference settings
    else status = 'ok';
    return { status, items };
  }

  return { readExif, checkCaptureSettings };
});
