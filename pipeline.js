/*
 * pipeline.js -- on-device port of the Iron App2 FastAPI pipeline
 * (roi.py + features.py + patches.py + calibration.py + device.py + model_utils.py).
 *
 * Runs unchanged in a browser Web Worker (importScripts) and in Node (require) so the
 * exact same code is parity-tested against the Python pipeline.
 *
 * Image processing is delegated to opencv.js so HSV conversion, connected components,
 * Sobel and contour detection behave like the cv2 calls in the Python app. The only
 * SciPy / scikit-learn pieces (gaussian_filter1d, find_peaks, HuberRegressor) are
 * re-implemented below and verified against the real libraries in tests/.
 *
 * All pixel constants are copied verbatim from the Python code and were tuned on
 * ~4096x3072 landscape photos (see normaliseResolution()).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IronPipeline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-6;

  // ---- constants copied from roi.py / features.py / patches.py -------------------------
  const SIDE_INSET = 30, TOP_MARGIN = 80, BOTTOM_MARGIN = 30;
  const BG = { patch_w: 200, patch_h: 350, gap: 120 };
  const PATCH_NAMES_LEFT = ['0.0', '0.5', '1.5', '2.5', 'GRAY'];
  const PATCH_NAMES_RIGHT = ['0.2', '1.0', '2.0', 'WHITE'];
  const CONC_PATCH_NAMES = ['0.0', '0.2', '0.5', '1.0', '1.5', '2.0', '2.5'];
  const REFERENCE_WIDTH = 4096; // photos the constants were validated on (4096x3072 / 4080x3060)

  class PipelineError extends Error {
    constructor(code, message) { super(message); this.name = 'PipelineError'; this.code = code; }
  }

  // ======================================================================================
  // SciPy ports
  // ======================================================================================

  /** scipy.ndimage.gaussian_filter1d(x, sigma, mode='reflect', truncate=4.0) */
  function gaussianFilter1d(x, sigma) {
    const radius = Math.floor(4.0 * sigma + 0.5);
    const w = new Float64Array(2 * radius + 1);
    let sum = 0;
    for (let k = -radius; k <= radius; k++) { const v = Math.exp(-0.5 * (k * k) / (sigma * sigma)); w[k + radius] = v; sum += v; }
    for (let i = 0; i < w.length; i++) w[i] /= sum;
    const n = x.length, out = new Float64Array(n);
    const refl = (i) => { // scipy 'reflect': d c b a | a b c d | d c b a
      const period = 2 * n;
      i = ((i % period) + period) % period;
      return i < n ? i : period - 1 - i;
    };
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = i + k;
        acc += w[k + radius] * x[(j >= 0 && j < n) ? j : refl(j)];
      }
      out[i] = acc;
    }
    return out;
  }

  /** scipy.signal.find_peaks(x, distance=distance, prominence=prominence) -> peak indices */
  function findPeaks(x, distance, prominence) {
    const n = x.length;
    // 1. local maxima (plateaus -> midpoint)
    let peaks = [];
    let i = 1; const iMax = n - 1;
    while (i < iMax) {
      if (x[i - 1] < x[i]) {
        let ahead = i + 1;
        while (ahead < iMax && x[ahead] === x[i]) ahead++;
        if (x[ahead] < x[i]) {
          peaks.push(Math.floor((i + (ahead - 1)) / 2));
          i = ahead;
        }
      }
      i++;
    }
    // 2. minimum distance, highest peaks win
    if (distance != null && peaks.length > 1) {
      const dist = Math.ceil(distance);
      const m = peaks.length;
      const keep = new Uint8Array(m).fill(1);
      const order = Array.from({ length: m }, (_, k) => k).sort((a, b) => (x[peaks[a]] - x[peaks[b]]) || (a - b));
      for (let r = m - 1; r >= 0; r--) {
        const j = order[r];
        if (!keep[j]) continue;
        let k = j - 1;
        while (k >= 0 && peaks[j] - peaks[k] < dist) { keep[k] = 0; k--; }
        k = j + 1;
        while (k < m && peaks[k] - peaks[j] < dist) { keep[k] = 0; k++; }
      }
      peaks = peaks.filter((_, k) => keep[k]);
    }
    // 3. prominence (whole-signal window)
    if (prominence != null) {
      peaks = peaks.filter((p) => {
        let leftMin = x[p], rightMin = x[p];
        let k = p;
        while (k >= 0 && x[k] <= x[p]) { if (x[k] < leftMin) leftMin = x[k]; k--; }
        k = p;
        while (k < n && x[k] <= x[p]) { if (x[k] < rightMin) rightMin = x[k]; k++; }
        return (x[p] - Math.max(leftMin, rightMin)) >= prominence;
      });
    }
    return peaks;
  }

  // ======================================================================================
  // scikit-learn HuberRegressor(max_iter=1000) port (1 feature, intercept, epsilon=1.35,
  // alpha=1e-4). Same objective as sklearn's _huber_loss_and_gradient, minimised with a
  // dense BFGS + Armijo line search. The problem is jointly convex, so this lands on the
  // same optimum sklearn's L-BFGS-B converges to (verified in tests/huber_check.py).
  // ======================================================================================

  function huberLossGrad(p, xs, ys, eps, alpha) {
    const n = xs.length, w = p[0], c = p[1], sigma = p[2];
    let outlierLoss = 0, nOut = 0, sq = 0, gw = 0, gc = 0, sumNon = 0, sumSign = 0;
    for (let i = 0; i < n; i++) {
      const r = ys[i] - w * xs[i] - c;
      const a = Math.abs(r);
      if (a > eps * sigma) {
        outlierLoss += 2.0 * eps * a; nOut++;
        const s = r < 0 ? -1 : 1;
        gw -= 2.0 * eps * s * xs[i]; sumSign += s;
      } else {
        sq += r * r; sumNon += r;
        gw += (2.0 / sigma) * r * (-xs[i]);
      }
    }
    outlierLoss -= sigma * nOut * eps * eps;
    const squared = sq / sigma;
    gw += alpha * 2.0 * w;
    const gs = n - nOut * eps * eps - squared / sigma;
    gc = -2.0 * sumNon / sigma - 2.0 * eps * sumSign;
    const loss = n * sigma + squared + outlierLoss + alpha * w * w;
    return { loss, grad: [gw, gc, gs] };
  }

  function huberFit(xs, ys, opts) {
    const eps = (opts && opts.epsilon) || 1.35, alpha = (opts && opts.alpha != null) ? opts.alpha : 1e-4;
    const SIGMA_MIN = 2.220446049250313e-16 * 10;
    const n = xs.length;
    let p = [0, 0, 1];
    let f = huberLossGrad(p, xs, ys, eps, alpha);
    let H = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; // inverse-Hessian estimate
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (let it = 0; it < 2000; it++) {
      const gnorm = Math.max(Math.abs(f.grad[0]), Math.abs(f.grad[1]), Math.abs(f.grad[2]));
      if (gnorm < 1e-11) break;
      let d = [0, 0, 0];
      for (let r = 0; r < 3; r++) d[r] = -(H[r][0] * f.grad[0] + H[r][1] * f.grad[1] + H[r][2] * f.grad[2]);
      if (dot(d, f.grad) >= 0) { H = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; d = f.grad.map((g) => -g); }
      let t = 1, accepted = false, pn, fn;
      for (let ls = 0; ls < 60; ls++) {
        pn = [p[0] + t * d[0], p[1] + t * d[1], Math.max(p[2] + t * d[2], SIGMA_MIN)];
        fn = huberLossGrad(pn, xs, ys, eps, alpha);
        if (Number.isFinite(fn.loss) && fn.loss <= f.loss + 1e-4 * t * dot(d, f.grad)) { accepted = true; break; }
        t *= 0.5;
      }
      if (!accepted) break;
      const s = [pn[0] - p[0], pn[1] - p[1], pn[2] - p[2]];
      const y = [fn.grad[0] - f.grad[0], fn.grad[1] - f.grad[1], fn.grad[2] - f.grad[2]];
      const sy = dot(s, y);
      if (sy > 1e-300) {
        const rho = 1 / sy;
        const Hy = [0, 0, 0];
        for (let r = 0; r < 3; r++) Hy[r] = H[r][0] * y[0] + H[r][1] * y[1] + H[r][2] * y[2];
        const yHy = dot(y, Hy);
        const Hn = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
          Hn[r][c] = H[r][c] - rho * (s[r] * Hy[c] + Hy[r] * s[c]) + rho * (rho * yHy + 1) * s[r] * s[c];
        }
        H = Hn;
      }
      const moved = Math.max(Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2]));
      p = pn; f = fn;
      if (moved < 1e-15) break;
    }
    if (![p[0], p[1]].every(Number.isFinite)) return olsFit(xs, ys);
    return { slope: p[0], intercept: p[1], sigma: p[2] };
  }

  function olsFit(xs, ys) {
    const n = xs.length; let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
    const slope = sxx > 0 ? sxy / sxx : 0;
    return { slope, intercept: my - slope * mx, sigma: NaN };
  }

  // ======================================================================================
  // Model (bundle) maths
  // ======================================================================================

  function predictValue(model, x) {
    switch (model.type) {
      case 'linear': return model.coef * x + model.intercept;
      case 'polynomial': { // coefs highest power first
        let acc = 0; for (const c of model.coefs) acc = acc * x + c; return acc;
      }
      case 'piecewise_linear': { // knots sorted by x; linear extrapolation beyond the ends
        const X = model.x, Y = model.y, m = X.length;
        let k = 0;
        if (x <= X[0]) k = 0; else if (x >= X[m - 1]) k = m - 2;
        else { k = 0; while (k < m - 2 && x > X[k + 1]) k++; }
        const t = (x - X[k]) / (X[k + 1] - X[k]);
        return Y[k] + t * (Y[k + 1] - Y[k]);
      }
      default: throw new Error('Unknown model type: ' + model.type);
    }
  }

  function isReferenceFamily(device, names) {
    if (!device || (!device.make && !device.model)) return false;
    const combined = `${device.make || ''} ${device.model || ''}`.trim().toLowerCase();
    return names.some((n) => combined.includes(n));
  }

  // ======================================================================================
  // OpenCV-backed image stages
  // ======================================================================================

  function createPipeline(cv) {
    const mats = []; // scratch tracking so everything is freed even on error
    const track = (m) => { mats.push(m); return m; };
    const freeAll = () => { while (mats.length) { try { mats.pop().delete(); } catch (e) { /* already freed */ } } };
    const free = (m) => { const k = mats.indexOf(m); if (k >= 0) mats.splice(k, 1); try { m.delete(); } catch (e) { /* noop */ } };

    // ---- roi.py -------------------------------------------------------------------------
    function segmentTubeColor(rgb) {
      const hsv = track(new cv.Mat());
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      // H in (0,25), S>30, 80<V<255 -- looped in JS (cv.inRange would need two full-size bound Mats)
      const mask = track(new cv.Mat(hsv.rows, hsv.cols, cv.CV_8UC1));
      {
        const hd = hsv.data, md = mask.data, N = hsv.rows * hsv.cols;
        for (let i = 0, o = 0; i < N; i++, o += 3) {
          const h = hd[o], s = hd[o + 1], v = hd[o + 2];
          md[i] = (h > 0 && h < 25 && s > 30 && v > 80 && v < 255) ? 255 : 0;
        }
      }
      free(hsv);
      const labels = track(new cv.Mat()), stats = track(new cv.Mat()), cent = track(new cv.Mat());
      const n = cv.connectedComponentsWithStats(mask, labels, stats, cent, 8, cv.CV_32S);
      free(labels); free(mask);
      const d = stats.data32S;
      let best = null;
      for (let i = 1; i < n; i++) {
        const x = d[i * 5], y = d[i * 5 + 1], w = d[i * 5 + 2], h = d[i * 5 + 3], area = d[i * 5 + 4];
        if (area < 20000) continue;
        const aspect = h / Math.max(w, 1);
        if (aspect > 2.5) { if (best === null || area > best[4]) best = [x, y, w, h, area]; }
      }
      free(stats); free(cent);
      return best;
    }

    function segmentTubeGradient(gray8, W, H, promFrac) {
      const sx1 = 300, sy1 = 700;
      const sx2 = Math.min(2200, W), sy2 = Math.min(2200, H);
      if (sx2 <= sx1 || sy2 <= sy1) return null;
      const f64 = (r) => { // clone() => isolated borders, like a numpy slice passed to cv2
        const sub = gray8.roi(r), c = sub.clone(); sub.delete();
        const out = track(new cv.Mat()); c.convertTo(out, cv.CV_64F); c.delete();
        return out;
      };
      const band = f64(new cv.Rect(sx1, sy1, sx2 - sx1, sy2 - sy1));
      let g = track(new cv.Mat());
      cv.Sobel(band, g, cv.CV_64F, 0, 1, 5, 1, 0, cv.BORDER_DEFAULT);
      const bw = band.cols, bh = band.rows;
      let bestRow = 0, bestVal = -1;
      {
        const d = g.data64F;
        for (let r = 0; r < bh; r++) {
          let s = 0; const o = r * bw;
          for (let c = 0; c < bw; c++) s += Math.abs(d[o + c]);
          if (s > bestVal) { bestVal = s; bestRow = r; }
        }
      }
      free(g); free(band);
      const meniscusY = sy1 + bestRow;
      const edgeY1 = meniscusY + 50;
      const edgeY2 = Math.min(meniscusY + 50 + 300, H);
      if (edgeY2 - edgeY1 < 50) return null;
      const eb = f64(new cv.Rect(sx1, edgeY1, sx2 - sx1, edgeY2 - edgeY1));
      g = track(new cv.Mat());
      cv.Sobel(eb, g, cv.CV_64F, 1, 0, 5, 1, 0, cv.BORDER_DEFAULT);
      const ew = eb.cols, eh = eb.rows;
      const colProfile = new Float64Array(ew);
      {
        const d = g.data64F;
        for (let r = 0; r < eh; r++) { const o = r * ew; for (let c = 0; c < ew; c++) colProfile[c] += Math.abs(d[o + c]); }
      }
      free(g); free(eb);
      const smoothed = gaussianFilter1d(colProfile, 3);
      let mx = -Infinity; for (let i = 0; i < smoothed.length; i++) if (smoothed[i] > mx) mx = smoothed[i];
      const peaks = findPeaks(smoothed, 100, mx * promFrac);
      if (peaks.length < 2) return null;
      let bestPair = null, bestScore = -1;
      for (let i = 0; i < peaks.length; i++) for (let j = i + 1; j < peaks.length; j++) {
        const sep = peaks[j] - peaks[i];
        if (sep >= 250 && sep <= 420) {
          const score = smoothed[peaks[i]] + smoothed[peaks[j]];
          if (score > bestScore) { bestScore = score; bestPair = [peaks[i], peaks[j]]; }
        }
      }
      if (!bestPair) return null;
      const tx1 = sx1 + bestPair[0], tx2 = sx1 + bestPair[1], tw = tx2 - tx1;
      const y2 = Math.min(meniscusY + 1400, H - 50);
      return [tx1, meniscusY, tw, y2 - meniscusY, tw * (y2 - meniscusY)];
    }

    function getRoi(rgb, gray8, W, H) {
      let seg = segmentTubeColor(rgb), method = 'color';
      if (!seg) {
        method = 'failed';
        for (const frac of [0.15, 0.10, 0.20, 0.25, 0.08, 0.05]) {
          seg = segmentTubeGradient(gray8, W, H, frac);
          if (seg) { method = 'gradient_fallback'; break; }
        }
      }
      if (!seg) return { roi: null, method: 'failed' };
      const [bx, by, bw, bh] = seg;
      let x1 = bx + SIDE_INSET, x2 = bx + bw - SIDE_INSET;
      let y1 = by + TOP_MARGIN, y2 = by + bh - BOTTOM_MARGIN;
      if (x1 >= x2 || y1 >= y2) return { roi: null, method: 'failed' };
      x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(W, x2); y2 = Math.min(H, y2);
      if (x1 >= x2 || y1 >= y2) return { roi: null, method: 'failed' };
      return { roi: [x1, y1, x2, y2], method };
    }

    // ---- features.py --------------------------------------------------------------------
    function meanRGB(rgb, W, x1, y1, x2, y2) {
      const d = rgb.data; let r = 0, g = 0, b = 0;
      for (let y = y1; y < y2; y++) {
        let o = (y * W + x1) * 3;
        for (let x = x1; x < x2; x++, o += 3) { r += d[o]; g += d[o + 1]; b += d[o + 2]; }
      }
      const cnt = (x2 - x1) * (y2 - y1);
      return [r / cnt, g / cnt, b / cnt];
    }

    function extractFeature(rgb, W, H, roi) {
      const [x1, y1, x2, y2] = roi;
      if (x2 <= x1 || y2 <= y1) return null;
      const [R, G, B] = meanRGB(rgb, W, x1, y1, x2, y2);
      const yc1 = y1, yc2 = Math.min(y1 + BG.patch_h, y2);
      const leftX2 = x1 - BG.gap, leftX1 = leftX2 - BG.patch_w;
      const rightX1 = x2 + BG.gap, rightX2 = rightX1 + BG.patch_w;
      const parts = [];
      if (leftX1 > 0) parts.push([leftX1, leftX2]);
      if (rightX2 < W) parts.push([rightX1, rightX2]);
      if (!parts.length || yc2 <= yc1) return null;
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      const d = rgb.data;
      for (const [xa, xb] of parts) {
        for (let y = yc1; y < yc2; y++) {
          let o = (y * W + xa) * 3;
          for (let x = xa; x < xb; x++, o += 3) { sr += d[o]; sg += d[o + 1]; sb += d[o + 2]; }
        }
        cnt += (xb - xa) * (yc2 - yc1);
      }
      const Gbg = sg / cnt, Bbg = sb / cnt;
      const logBG = Math.log10(B / (G + EPS));
      const logBGbg = Math.log10(Bbg / (Gbg + EPS));
      return { R, G, B, R_bg: sr / cnt, G_bg: Gbg, B_bg: Bbg, log_BG: logBG, log_BG_bg: logBGbg, log_BG_normalized: logBG - logBGbg };
    }

    // ---- patches.py ---------------------------------------------------------------------
    function getSquares(gray8, t) {
      const thr = track(new cv.Mat());
      cv.threshold(gray8, thr, t, 255, cv.THRESH_BINARY_INV);
      const contours = new cv.MatVector(), hier = track(new cv.Mat());
      cv.findContours(thr, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      free(thr); free(hier);
      const squares = [];
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const r = cv.boundingRect(c);
        c.delete();
        const area = r.width * r.height;
        if (area < 80000) continue;
        const aspect = r.height / r.width;
        if (aspect > 0.7 && aspect < 1.4 && r.width > 200 && r.width < 600 && r.height > 200 && r.height < 600) {
          squares.push([r.x, r.y, r.width, r.height, area]);
        }
      }
      contours.delete();
      return squares;
    }

    function clusterPatches(squares, xTol = 100, yTol = 100) {
      const cs = squares.map(([x, y, w, h, area]) => ({ cx: x + w / 2, cy: y + h / 2, x, y, w, h, area }));
      const used = new Array(cs.length).fill(false), groups = [];
      for (let i = 0; i < cs.length; i++) {
        if (used[i]) continue;
        const group = [cs[i]]; used[i] = true;
        for (let j = i + 1; j < cs.length; j++) {
          if (used[j]) continue;
          if (Math.abs(cs[j].cx - cs[i].cx) < xTol && Math.abs(cs[j].cy - cs[i].cy) < yTol) { group.push(cs[j]); used[j] = true; }
        }
        let best = group[0]; for (const g of group) if (g.area > best.area) best = g;
        groups.push(best);
      }
      return groups;
    }

    function splitColumns(groups) {
      const xs = groups.slice().sort((a, b) => a.cx - b.cx);
      const gaps = [];
      for (let i = 0; i < xs.length - 1; i++) gaps.push([xs[i + 1].cx - xs[i].cx, i]);
      gaps.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
      const s = gaps[0][1];
      return [xs.slice(0, s + 1), xs.slice(s + 1)];
    }

    /** returns {colors:{name:[R,G,B]}, boxes:{name:[x,y,w,h]}, threshold} or null */
    function extractPatchColors(rgb, gray8, W) {
      let t = null, squares = null, groups = null;
      for (const tv of [100, 120, 140, 160, 180, 200, 220]) {
        const sq = getSquares(gray8, tv);
        if (sq.length >= 9) {
          const g = clusterPatches(sq);
          if (g.length === 9) { t = tv; squares = sq; groups = g; break; }
        }
      }
      if (t === null) return null;
      let [left, right] = splitColumns(groups);
      left = left.slice().sort((a, b) => a.cy - b.cy);
      right = right.slice().sort((a, b) => a.cy - b.cy);
      const colors = {}, boxes = {};
      const place = (names, col) => {
        for (let k = 0; k < Math.min(names.length, col.length); k++) {
          const g = col[k];
          const ix = Math.floor(g.w * 0.25), iy = Math.floor(g.h * 0.25);
          colors[names[k]] = meanRGB(rgb, W, g.x + ix, g.y + iy, g.x + g.w - ix, g.y + g.h - iy);
          boxes[names[k]] = [g.x, g.y, g.w, g.h];
        }
      };
      place(PATCH_NAMES_LEFT, left);
      place(PATCH_NAMES_RIGHT, right);
      return { colors, boxes, threshold: t };
    }

    // ---- resolution normalisation -------------------------------------------------------
    /** The pixel constants above assume ~4096-wide landscape photos. Leave 4080..4096-class
     *  photos untouched (exact parity with the Python app); rescale anything >10% off. */
    function normaliseResolution(rgb) {
      const W = rgb.cols;
      const ratio = W / REFERENCE_WIDTH;
      if (ratio >= 0.9 && ratio <= 1.1) return { mat: rgb, scale: 1 };
      const nw = REFERENCE_WIDTH, nh = Math.round(rgb.rows * REFERENCE_WIDTH / W);
      const out = track(new cv.Mat());
      cv.resize(rgb, out, new cv.Size(nw, nh), 0, 0, ratio > 1 ? cv.INTER_AREA : cv.INTER_LINEAR);
      return { mat: out, scale: nw / W };
    }

    // ======================================================================================
    // analyze(): mirrors app.py::analyze()
    // ======================================================================================
    /**
     * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} img  RGBA pixels (already EXIF-oriented)
     * @param {{make:string|null,model:string|null,present:boolean}} device  parsed EXIF
     * @param {object} bundle  validated model bundle (see bundle.js)
     * @param {(stage:string)=>void} [progress]
     */
    function analyze(img, device, bundle, progress) {
      const say = progress || (() => {});
      try {
        if (img.height > img.width) {
          throw new PipelineError('portrait', 'This photo is in portrait orientation. Hold the phone in landscape (wide) orientation so the tube and the reference card sit side by side, then retake.');
        }
        say('decode');
        let rgba = track(new cv.Mat(img.height, img.width, cv.CV_8UC4));
        rgba.data.set(img.data);
        let rgb0 = track(new cv.Mat());
        cv.cvtColor(rgba, rgb0, cv.COLOR_RGBA2RGB);
        free(rgba);
        const { mat: rgb, scale } = normaliseResolution(rgb0);
        if (rgb !== rgb0) free(rgb0);
        const W = rgb.cols, H = rgb.rows;
        const gray8 = track(new cv.Mat());
        cv.cvtColor(rgb, gray8, cv.COLOR_RGB2GRAY);

        say('tube');
        const { roi, method } = getRoi(rgb, gray8, W, H);
        if (!roi) throw new PipelineError('no_tube', 'Could not locate the sample tube in this photo. Retake with the tube centered and fully visible.');

        say('features');
        const feats = extractFeature(rgb, W, H, roi);
        if (!feats) throw new PipelineError('no_background', 'Could not sample the background around the tube. Retake with more space visible on both sides of the tube.');
        const rawFeature = feats.log_BG_normalized;

        say('card');
        const pc = extractPatchColors(rgb, gray8, W);
        const needed = CONC_PATCH_NAMES;
        if (!pc || !needed.every((n) => pc.colors[n])) {
          throw new PipelineError('no_card', 'Could not locate the 9-patch reference card in this photo. Retake with the full card visible and well lit alongside the tube.');
        }
        const photoPatches = {};
        for (const [n, c] of Object.entries(pc.colors)) photoPatches[n] = Math.log10(c[2] / (c[1] + EPS));

        say('model');
        const refPatches = bundle.reference_patches;
        const names = bundle.reference_device_names || [];
        const same = isReferenceFamily({ make: device.make, model: device.model }, names) && !!device.present;
        let corrected, calibrated, warning = null, slope = null, resid = null, skipped = false;
        if (!refPatches || Object.values(refPatches).some((v) => v == null)) {
          corrected = rawFeature; calibrated = false;
          warning = "Reference patch data isn't configured in this model, so no device correction was applied. This reading is uncorrected and may be biased.";
        } else {
          const xs = needed.map((n) => photoPatches[n]), ys = needed.map((n) => refPatches[n]);
          const fit = huberFit(xs, ys);
          slope = fit.slope;
          resid = xs.map((x, i) => fit.slope * x + fit.intercept - ys[i]);
          // Orientation guard: an upside-down / wrongly rotated photo still "finds" a tube and a card, but reads the card
          // patches in the wrong order -> negative slope -> silently wrong reading (e.g. -0.6 instead of 1.7).
          // On all 489 real photos the slope is >= 0.45; on 180-degree rotated ones it is always negative.
          if (!(slope > 0.2)) {
            throw new PipelineError('orientation', 'The reference card reads backwards, so this photo is probably upside down or rotated. Hold the phone the same way round as for your other photos (tube and card in the usual positions) and retake.');
          }
          // Validated Nord-family models skip the card correction: on them the per-photo card slope is mostly
          // shot-to-shot noise (sd ~0.08-0.12 around 1.0) and applying it raised error from ~0.10 to ~0.15-0.19 mg/L
          // (leave-one-session-out on 349 Nord photos; held-out AC2001 unit 0.185 -> 0.104). Cross-brand phones keep it.
          // Photos from the app's own camera (Android, Camera2) skip the phone maker's colour processing that the
          // reference photos had, so until bundle.app_camera.validated is set (after checking against known samples)
          // they keep the card correction and get the cross-brand error estimate, even on a Nord.
          const appCam = device.source === 'app_camera', appCamOk = !!(bundle.app_camera && bundle.app_camera.validated);
          const skipList = (bundle.correction && bundle.correction.skip_for_models) || [];
          skipped = !!device.present && isReferenceFamily({ make: device.make, model: device.model }, skipList) && (!appCam || appCamOk);
          corrected = skipped ? rawFeature : slope * rawFeature;
          calibrated = same && (!appCam || appCamOk);
          if (appCam && !appCamOk) {
            warning = "Taken with the app's built-in camera. Its colour processing differs from the phone camera app the model was calibrated with and hasn't been checked against known samples yet, so the reference-card correction was applied and the cross-brand error estimate is shown.";
          } else if (!device.present) {
            warning = 'No camera metadata was found in this photo (common when a photo has been shared or edited), so the device couldn\'t be identified. A cross-brand correction was applied via the reference card; the error estimate below defaults to the cross-brand figure.';
          } else if (!calibrated) {
            warning = `Device '${device.make || ''} ${device.model || ''}' isn't the reference device family. A cross-brand correction was applied via the reference card; the error estimate is the average over the other phone brands validated so far -- not individually validated for this specific device.`;
          }
        }

        const conc = predictValue(bundle.model, corrected);
        const range = bundle.calibrated_range;
        const tol = bundle.range_tolerance || 0;   // readings like -0.03 at a blank are normal noise, not extrapolation
        const inRange = conc >= range[0] - tol && conc <= range[1] + tol;
        // honest error estimate: measured MAE for this phone category AND this concentration level when available
        const U = bundle.uncertainty, cat = calibrated ? 'same_family' : 'cross_brand';
        let mae = calibrated ? U.same_family_mae : U.cross_brand_mae;
        if (U.by_band && Array.isArray(U.by_band[cat])) {
          let b = 0; while (b < U.by_band.edges.length && conc >= U.by_band.edges[b]) b++;
          mae = U.by_band[cat][b];
        }
        if (!inRange) {
          const note = `Prediction falls outside the card's calibrated ${range[0].toFixed(1)}-${range[1].toFixed(1)} mg/L range -- treat as extrapolated and unreliable.`;
          warning = warning ? `${warning} ${note}` : note;
        }
        if (scale !== 1) {
          const note = `Photo resolution differs from the validated ~4096x3072 (rescaled x${scale.toFixed(2)}); accuracy not validated at this resolution.`;
          warning = warning ? `${warning} ${note}` : note;
        }
        return {
          concentration_mg_per_l: Math.round(conc * 1000) / 1000,
          uncertainty_mae_mg_per_l: mae,
          in_calibrated_range: inRange,
          calibrated_range: range,
          device_detected: { make: device.make || null, model: device.model || null },
          device_calibrated: calibrated,
          warning,
          roi_method: method,
          roi_box: roi,
          // extras beyond the Python response (used by the UI overlay and by parity tests)
          debug: {
            raw_feature: rawFeature, corrected_feature: corrected, patch_slope: slope, patch_residuals: resid, correction_skipped: skipped, source: device.source || 'file',
            patch_logbg: photoPatches, patch_boxes: pc.boxes, patch_threshold: pc.threshold,
            work_size: [W, H], scale, features: feats,
          },
        };
      } finally {
        freeAll();
      }
    }

    return { analyze };
  }

  return {
    createPipeline, PipelineError, predictValue, isReferenceFamily,
    // exported for unit tests
    _internals: { gaussianFilter1d, findPeaks, huberFit, olsFit, huberLossGrad },
  };
});
