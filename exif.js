/*
 * exif.js -- minimal JPEG EXIF reader (Make / Model / Orientation only).
 * Mirrors device.py::detect_device: `present` is false when the file has no EXIF block
 * at all, true (with make/model possibly null) when it does.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IronExif = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function readExif(buffer) {
    const none = { present: false, make: null, model: null, orientation: 1 };
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
    const u16 = (o) => v.getUint16(base + o, le), u32 = (o) => v.getUint32(base + o, le);
    if (u16(2) !== 42) return none;
    const ifd0 = u32(4);
    const count = u16(ifd0);
    if (!count) return none; // empty EXIF == no EXIF (PIL: `if not exif`)
    const out = { present: true, make: null, model: null, orientation: 1 };
    const ascii = (entryOff) => {
      const n = u32(entryOff + 4);
      const dataOff = n <= 4 ? entryOff + 8 : u32(entryOff + 8);
      let s = '';
      for (let i = 0; i < n; i++) { const c = v.getUint8(base + dataOff + i); if (c === 0) break; s += String.fromCharCode(c); }
      return s.trim() || null;
    };
    for (let i = 0; i < count; i++) {
      const e = ifd0 + 2 + i * 12;
      const tag = u16(e);
      if (tag === 0x010F) out.make = ascii(e);
      else if (tag === 0x0110) out.model = ascii(e);
      else if (tag === 0x0112) out.orientation = u16(e + 8);
    }
    return out;
  }

  return { readExif };
});
